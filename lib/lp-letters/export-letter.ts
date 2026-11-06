// One letter, exported: Word, PDF, Markdown or JSON. The page's Export menu, the export route, the
// signed links the assistant hands out (lp_letter_export) and Google Docs all come through here,
// so every copy of a letter is laid out the same way.
//
// Every format is what investors may read: the "Missing information" section is never in it. A
// letter with structured content uses the document layout (document.ts); an older letter keeps
// the renderer it always had.
//
// The caller has already passed the lp_letters gate and the letter's entity check.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildDocxBuffer } from './export'
import { buildLetterDocx } from './docx-letter'
import { chartBytes } from './charts'
import { chartsOf, documentJson, documentMarkdown, hasStructuredContent, letterDocument } from './document'
import { investorText } from './internal'
import { documentLetterhead, contactBlock } from '@/lib/vehicle-letterhead'
import type { CompanyNarrative } from '@/lib/types/database'

type Admin = SupabaseClient

export type LetterExportFormat = 'docx' | 'pdf' | 'markdown' | 'json'
export const LETTER_EXPORT_FORMATS: LetterExportFormat[] = ['docx', 'pdf', 'markdown', 'json']

export interface ExportedLetter {
  body: Buffer
  contentType: string
  fileName: string
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function fileBase(fundName: string, period: string): string {
  return `${fundName} - ${period}`.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Letter'
}

/** The Word file alone (Google Docs converts it). */
export async function letterDocx(admin: Admin, fundId: string, letter: any): Promise<{ buffer: Buffer; fundName: string }> {
  const { data: fund } = await (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle()
  const letterhead = await documentLetterhead(admin, fundId, fund, letter.portfolio_group ? [letter.portfolio_group] : [])
  const fundName = letterhead.name || fund?.name || 'Fund'
  if (hasStructuredContent(letter)) {
    const bytes = await chartBytes(admin, fundId, letter.id, chartsOf(letter))
    const buffer = await buildLetterDocx(letterDocument(letter), {
      fundName, logo: letterhead.logo, address: contactBlock(letterhead), chartBytes: bytes,
    })
    return { buffer, fundName }
  }
  // An older letter: the layout it always had.
  const { data: settings } = await (admin as any).from('fund_settings').select('currency').eq('fund_id', fundId).maybeSingle()
  const summary = (Array.isArray(letter.portfolio_summary) ? letter.portfolio_summary : []) as any[]
  const buffer = await buildDocxBuffer({
    period_label: letter.period_label,
    full_draft: investorText(letter.full_draft),
    company_narratives: (Array.isArray(letter.company_narratives) ? letter.company_narratives : []) as CompanyNarrative[],
    portfolio_companies: summary.map(c => ({ companyName: c.company_name, status: c.status, stage: c.stage, totalInvested: c.total_invested, fmv: c.fmv, moic: c.moic })),
    fund_currency: settings?.currency ?? 'USD',
  }, fundName)
  return { buffer, fundName }
}

export async function exportLetter(admin: Admin, fundId: string, letter: any, format: LetterExportFormat): Promise<ExportedLetter | null> {
  if (!letter || letter.status === 'generating') return null
  const period = letter.period_label ?? 'Letter'
  if (format === 'pdf') {
    const { generateLetterPdf } = await import('@/lib/lp-report-pdf')
    const out = await generateLetterPdf(admin, { fundId, letterId: letter.id })
    return out ? { body: out.pdf, contentType: 'application/pdf', fileName: out.fileName } : null
  }
  if (format === 'docx') {
    const { buffer, fundName } = await letterDocx(admin, fundId, letter)
    return { body: buffer, contentType: DOCX, fileName: `${fileBase(fundName, period)}.docx` }
  }
  const { data: fund } = await (admin as any).from('funds').select('name').eq('id', fundId).maybeSingle()
  const fundName = fund?.name ?? 'Fund'
  const doc = letterDocument(letter)
  if (format === 'markdown') {
    // An older letter's text as it was written; a structured one with "## " headings and tables.
    const text = hasStructuredContent(letter) ? documentMarkdown(doc) : investorText(letter.full_draft)
    return { body: Buffer.from(text, 'utf8'), contentType: 'text/markdown; charset=utf-8', fileName: `${fileBase(fundName, period)}.md` }
  }
  const json = { letter_id: letter.id, ...(documentJson(doc) as object) }
  return { body: Buffer.from(JSON.stringify(json, null, 2), 'utf8'), contentType: 'application/json; charset=utf-8', fileName: `${fileBase(fundName, period)}.json` }
}
