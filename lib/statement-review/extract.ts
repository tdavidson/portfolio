// Reading a package out of the administrator's documents (stage 4 of docs/spec/statement-review.md).
//
// The documents are the vehicle's own entity documents: the quarterly package uploaded on the
// entity's Documents page (or with add_entity_document), whose text the upload already read,
// OCR included, with [Page N] markers. The figures come out of that text with whichever reader is
// available, like extract_lpa_terms:
//   * the fund's model, when it has a server AI key;
//   * otherwise the person's assistant, handed the text, the shape and the rules
//     (statement_review_extract), which then runs the review with the package it read.
// Either way every figure carries a citation, and the `sources` check confirms each cited figure
// is printed on the page it cites, so a misread figure is a finding, not a silent error.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getDocument } from '@/lib/entity-documents'
import { fundHasAIKey } from '@/lib/ai/keyless'
import type { PackageDocument } from './types'

/** A document a package is read from: its text, page markers included. */
export interface SourceDocument {
  id: string
  /** What citations name: the document's title. */
  name: string
  text: string
  hash?: string
  pages?: number
}

export const MAX_DOCUMENTS = 10
/** What the server model is sent in one call. Statement packages run to a few hundred thousand characters at most. */
export const MODEL_TEXT_BUDGET = 400_000
/** What an assistant is handed in one tool result. */
export const ASSISTANT_TEXT_BUDGET = 150_000

/** Load the documents a package is read from. Only the vehicle's own documents. */
export async function loadSourceDocuments(
  admin: SupabaseClient, fundId: string, vehicleId: string, ids: unknown,
): Promise<SourceDocument[] | string> {
  if (!Array.isArray(ids) || !ids.length || !ids.every(i => typeof i === 'string' && i)) {
    return 'document_ids must list the documents to read (list_entity_documents lists the vehicle\'s).'
  }
  if (ids.length > MAX_DOCUMENTS) return `At most ${MAX_DOCUMENTS} documents in one package.`
  const out: SourceDocument[] = []
  for (const id of new Set(ids as string[])) {
    const doc = await getDocument(admin, fundId, id, [vehicleId])
    if (!doc) return `No such document on this vehicle: ${id}. list_entity_documents lists them.`
    if (!doc.extracted_text) {
      return doc.ocr_status === 'pending'
        ? `${doc.title} is a scan still being read; try again in a few minutes.`
        : `No text could be read from ${doc.title}.`
    }
    const hash = (doc as { content_sha256?: unknown }).content_sha256
    const pages = doc.page_count
    out.push({
      id: doc.id,
      name: String(doc.title || doc.file_name),
      text: String(doc.extracted_text),
      ...(typeof hash === 'string' ? { hash } : {}),
      ...(pages != null && Number.isInteger(pages) && pages > 0 ? { pages } : {}),
    })
  }
  return out
}

/** The package's record of the documents it came from. */
export function packageDocuments(docs: SourceDocument[]): PackageDocument[] {
  return docs.map(d => ({ name: d.name, kind: 'statements', ...(d.hash ? { hash: d.hash } : {}), ...(d.pages ? { pages: d.pages } : {}) }))
}

/** Each document's text, in order, cut to a budget. Says which were cut. */
export function documentsText(docs: SourceDocument[], budget: number): { text: string; truncated: string[] } {
  const truncated: string[] = []
  let left = budget
  const parts = docs.map(d => {
    let body = d.text
    if (body.length > left) { body = body.slice(0, Math.max(0, left)); truncated.push(d.name) }
    left -= body.length
    return `===== DOCUMENT: ${d.name} =====\n${body}`
  })
  return { text: parts.join('\n\n'), truncated }
}

export const EXTRACTION_RESPONSE_SHAPE = `{
  "period_start": "YYYY-MM-DD",            // optional; the quarter's first day when absent
  "period_end": "YYYY-MM-DD",
  "partners": [{                           // one per capital account in the partner schedule
    "name": "As printed", "external_id": "the administrator's id, if printed",
    "commitment": 0, "beginning": 0, "contributions": 0, "distributions": 0,
    "allocations": { "income": 0, "expenses": 0, "management_fee": 0, "realized": 0, "unrealized": 0, "carry": 0, "total": 0 },
    "ending": 0, "unfunded": 0, "paid_in_to_date": 0, "distributed_to_date": 0,
    "cite": { "ending": { "document": "exact document name", "page": 4, "label": "row label as printed" }, "allocations.income": { ... } }
  }],
  "fund": {
    "partner_totals": { same fields as a partner: the TOTAL row printed under the partner schedule },
    "partners_capital": { same fields: the fund's statement of changes in partners' capital },
    "balance_sheet": { "assets": [{ "label": "", "amount": 0, "cite": {...} }], "liabilities": [...], "total_assets": 0, "total_liabilities": 0, "partners_capital": 0, "total_liabilities_and_capital": 0, "cite": {...} },
    "operations": { "lines": [{ "label": "", "amount": 0, "cite": {...} }], "net_income": 0, "cite": {...} },
    "soi": { "cost": 0, "fair_value": 0, "cite": {...} }
  },
  "holdings": [{ "name": "", "cost": 0, "fair_value": 0, "cite": {...} }],
  "cash": [{ "account": "", "balance": 0, "cite": {...} }]
}`

export const EXTRACTION_RULES = [
  'Copy figures exactly as printed. Never compute, total or infer a figure the documents do not print; leave it out.',
  'Every figure gets a citation in its "cite": the document name exactly as given, the page from the [Page N] marker before it, and the row label as printed.',
  'Signs: contributions and distributions positive. Allocations signed as they change the capital account: income and gains positive, expenses, the management fee and carry charged to a limited partner negative, carry received by the GP positive. Operations lines signed as they add to net income (expenses negative). Balance sheet asset and liability lines positive. A printed (1,250.00) is -1250.',
  'Amounts as plain numbers in the currency printed, not thousands: if a statement says "in thousands", multiply and say so in "warnings".',
  'Period flows (this quarter) and to-date totals (since inception) are different fields: put each where it belongs, and only what the document labels.',
  'One partner entry per capital account. Keep the TOTAL row out of "partners": it goes in fund.partner_totals.',
  'Leave out any part the documents do not have. Add "warnings": ["..."] for anything unclear (an unreadable page, a figure you could not place).',
].join('\n')

export function buildExtractionPrompt(docs: SourceDocument[], hint: { periodEnd?: string; vehicle?: string }): { prompt: string; truncated: string[] } {
  const { text, truncated } = documentsText(docs, MODEL_TEXT_BUDGET)
  const prompt = [
    `Read the fund administrator's quarterly statement package below${hint.vehicle ? ` for ${hint.vehicle}` : ''}${hint.periodEnd ? `, period ending ${hint.periodEnd}` : ''}, and return its figures as ONE JSON object in this shape (comments explain; omit what is not printed):`,
    EXTRACTION_RESPONSE_SHAPE,
    'Rules:',
    EXTRACTION_RULES,
    'Return only the JSON object, no prose.',
    '',
    text,
  ].join('\n\n')
  return { prompt, truncated }
}

/** The JSON object out of a reader's reply: fenced or bare. A string when there is none. */
export function parseExtractionResponse(raw: unknown): Record<string, unknown> | string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return 'The reading is not a JSON object.'
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return 'The reading has no JSON object in it.'
  try {
    const v = JSON.parse(body.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : 'The reading is not a JSON object.'
  } catch {
    return 'The reading is not valid JSON.'
  }
}

/** The fund's model reads the package. The reason when it can't. */
export async function extractWithServerModel(
  admin: SupabaseClient, fundId: string, userId: string | null, docs: SourceDocument[], hint: { periodEnd?: string; vehicle?: string },
): Promise<{ package: Record<string, unknown>; truncated: string[] } | { failed: string; noKey?: boolean }> {
  if (!(await fundHasAIKey(admin, fundId))) {
    return { noKey: true, failed: "This fund has no server AI key, so the app can't read the documents itself. Ask your assistant to review the package: it reads them with statement_review_extract." }
  }
  const { createFundAIProvider } = await import('@/lib/ai')
  const { logAIUsage } = await import('@/lib/ai/usage')
  const { rateLimit } = await import('@/lib/rate-limit')
  if (userId && await rateLimit({ key: `statement-extract:${userId}`, limit: 10, windowSeconds: 600 })) {
    return { failed: 'Too many document readings in the last few minutes. Try again shortly.' }
  }
  try {
    const { provider, model, providerType } = await createFundAIProvider(admin, fundId)
    const { prompt, truncated } = buildExtractionPrompt(docs, hint)
    const result = await provider.createMessage({ model, maxTokens: 32_000, content: prompt })
    logAIUsage(admin, { fundId, userId: userId ?? undefined, provider: providerType, model, feature: 'statement_review_extract', usage: result.usage })
    const parsed = parseExtractionResponse(result.text)
    if (typeof parsed === 'string') return { failed: `The fund's model could not read the package: ${parsed}` }
    return { package: parsed, truncated }
  } catch (e) {
    return { failed: `The fund's model could not read the package (${(e as Error).message}).` }
  }
}
