// Proposing a vehicle's waterfall terms from its LPA — the server side of lib/accounting/lpa-terms.ts.
//
// Reads the LPA's text (an entity document's extracted text, or text pasted into the call), then
// reads the terms out of it with whichever reader is available:
//   * the person's assistant's own reading (`assistantProposal`), checked against the document;
//   * otherwise the fund's model, when it has a server AI key;
//   * otherwise the pattern reader alone, plus the passages the assistant should read itself.
// It WRITES NOTHING. The proposal comes back in the shape `set_waterfall_terms` takes, and that tool
// is always staged for a person to approve.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCarryTerms, type VehicleCarryTerms } from './carry'
import { vehicleIdByName } from './vehicle-id'
import { getDocument, KIND_LABELS, type DocumentKind } from '@/lib/entity-documents'
import { fundHasAIKey } from '@/lib/ai/keyless'
import {
  buildLpaTermsPrompt, heuristicLpaTerms, LPA_TERMS_RESPONSE_SHAPE, LPA_TERMS_RULES, parseLpaTermsResponse,
  proposalToTermsInput, relevantPassages, sourcesOf, TERM_FIELDS, lpaFeeScheduleToStored, type LpaTermsProposal,
} from './lpa-terms'

export const MAX_LPA_TEXT = 1_000_000
/** What the server model is sent: the relevant passages, not the whole agreement. */
const MODEL_PASSAGE_BUDGET = 60_000
/** What a keyless assistant is handed to read. */
const ASSISTANT_PASSAGE_BUDGET = 24_000

export interface LpaSourceText {
  text: string
  document: { id: string; title: string; kind: string; effectiveDate: string | null } | null
}

/** The LPA's text: one of the vehicle's own documents, or pasted text. Throws a message a person can act on. */
export async function loadLpaText(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  input: { documentId?: unknown; text?: unknown },
): Promise<LpaSourceText> {
  const hasDoc = typeof input.documentId === 'string' && input.documentId.trim() !== ''
  const hasText = typeof input.text === 'string' && input.text.trim() !== ''
  if (hasDoc === hasText) throw new Error('Pass documentId (from list_entity_documents) or text (the LPA pasted), not both.')
  if (hasText) {
    const text = String(input.text)
    if (text.length > MAX_LPA_TEXT) throw new Error('The text is too long (1,000,000 characters at most). Pass the LPA as an entity document instead.')
    return { text, document: null }
  }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) throw new Error(`Unknown vehicle "${group}".`)
  // Only this vehicle's own documents: the dispatcher has checked the caller may see this vehicle.
  const doc = await getDocument(admin, fundId, String(input.documentId), [vehicleId])
  if (!doc) throw new Error(`No such document on ${group}. list_entity_documents lists them.`)
  if (!doc.extracted_text) {
    throw new Error(doc.ocr_status === 'pending'
      ? 'This document is a scan still being read; try again in a few minutes.'
      : 'No text could be read from this document.')
  }
  return {
    text: doc.extracted_text,
    document: { id: doc.id, title: doc.title, kind: KIND_LABELS[doc.kind as DocumentKind] ?? doc.kind, effectiveDate: doc.effective_date },
  }
}

/** The fund's model reads the passages. Null (with the reason) when it cannot. */
async function readWithServerModel(
  admin: SupabaseClient, fundId: string, userId: string | null, text: string,
): Promise<{ proposal: LpaTermsProposal } | { failed: string }> {
  const { createFundAIProvider } = await import('@/lib/ai')
  const { logAIUsage } = await import('@/lib/ai/usage')
  const { rateLimit } = await import('@/lib/rate-limit')
  if (userId && await rateLimit({ key: `lpa-terms:${userId}`, limit: 10, windowSeconds: 300 })) {
    return { failed: 'Too many AI requests in the last few minutes, so the pattern reading is shown instead.' }
  }
  try {
    const { provider, model, providerType } = await createFundAIProvider(admin, fundId)
    const passages = relevantPassages(text, MODEL_PASSAGE_BUDGET)
    if (passages.length === 0) return { failed: 'No passage of the document mentions carry, a preferred return or a management fee.' }
    const result = await provider.createMessage({ model, maxTokens: 4096, content: buildLpaTermsPrompt(passages) })
    logAIUsage(admin, { fundId, userId: userId ?? undefined, provider: providerType, model, feature: 'lpa_terms', usage: result.usage })
    return { proposal: parseLpaTermsResponse(result.text, text, 'server_model') }
  } catch (e) {
    return { failed: `The fund's model could not read the terms (${(e as Error).message}), so the pattern reading is shown instead.` }
  }
}

/** Where the pattern reader disagrees with a model's or assistant's reading — said, not resolved. */
function crossCheck(proposal: LpaTermsProposal, patterns: LpaTermsProposal): string[] {
  const out: string[] = []
  for (const f of TERM_FIELDS) {
    const a = proposal.terms[f], b = patterns.terms[f]
    if (a && b && a.value !== b.value) out.push(`${f}: the reading says ${JSON.stringify(a.value)}, the pattern reader found ${JSON.stringify(b.value)} in "${b.quote.slice(0, 160)}". Check the clause.`)
    if (!a && b) out.push(`${f}: not in the reading, but the pattern reader found ${JSON.stringify(b.value)} in "${b.quote.slice(0, 160)}".`)
  }
  return out
}

export interface ExtractLpaTermsResult {
  vehicle: string
  source: LpaSourceText['document'] | { pasted: true; chars: number }
  method: LpaTermsProposal['method']
  current: VehicleCarryTerms & { recipientNames: Record<string, string> }
  proposal: LpaTermsProposal
  /** The input for set_waterfall_terms: every field, with where each came from. */
  proposedTerms: Record<string, unknown>
  filledFrom: Record<string, string>
  /** The management fee as set_fee_schedule takes it, dated from the vehicle's first closing, when the LPA states it. */
  proposedFeeSchedule?: Record<string, unknown>
  /** For a keyless assistant: the passages to read, and the JSON to hand back as assistantProposal. */
  passages?: { page: number | null; section: string | null; text: string }[]
  responseShape?: string
  rules?: string
  written: false
  next: string
}

export async function extractLpaTerms(
  admin: SupabaseClient,
  ctx: { fundId: string; group: string; userId: string | null },
  input: { documentId?: unknown; text?: unknown; assistantProposal?: unknown; useServerModel?: unknown },
): Promise<ExtractLpaTermsResult> {
  const { fundId, group, userId } = ctx
  const source = await loadLpaText(admin, fundId, group, input)
  const current = await loadCarryTerms(admin, fundId, group)
  const patterns = heuristicLpaTerms(source.text)

  let proposal: LpaTermsProposal = patterns
  const extraWarnings: string[] = []
  let keyless = false
  if (input.assistantProposal != null) {
    proposal = parseLpaTermsResponse(input.assistantProposal, source.text, 'assistant')
  } else if (input.useServerModel !== false && await fundHasAIKey(admin, fundId)) {
    const read = await readWithServerModel(admin, fundId, userId, source.text)
    if ('proposal' in read) proposal = read.proposal
    else { extraWarnings.push(read.failed); keyless = true }
  } else {
    keyless = true
  }
  if (proposal !== patterns) extraWarnings.push(...crossCheck(proposal, patterns))
  proposal = { ...proposal, warnings: [...proposal.warnings, ...extraWarnings] }

  // Recipients are entities, not words in an LPA: keep today's, or suggest the fund's only GP.
  const { data: ents } = await admin.from('lp_entities' as any).select('id, entity_name, partner_class').eq('fund_id', fundId)
  const entities = ((ents as any[]) ?? []) as { id: string; entity_name: string; partner_class: string | null }[]
  const nameOf = Object.fromEntries(entities.map(e => [e.id, e.entity_name]))
  const { input: terms, filledFrom } = proposalToTermsInput(proposal, current)
  const filled: Record<string, string> = { ...filledFrom }
  const carryOn = terms.kind !== 'none' && terms.carryRate > 0
  if (carryOn && terms.carryRecipients.length === 0) {
    const gps = entities.filter(e => e.partner_class === 'gp')
    if (gps.length === 1) {
      terms.carryRecipients = [{ lpEntityId: gps[0].id, pct: 100 }]
      filled.carryRecipients = 'suggested'
      proposal.warnings.push(`No carry recipient is set; ${gps[0].entity_name} (the fund's only GP-class partner) is suggested at 100%. Confirm it with the person.`)
    } else {
      filled.carryRecipients = 'missing'
      proposal.warnings.push(`No carry recipient is set and ${gps.length === 0 ? 'no partner is GP-class' : `${gps.length} partners are GP-class`}: ask the person who receives the carry, and pass carryRecipients (lpEntityId, pct summing to 100) to set_waterfall_terms.`)
    }
  }

  const proposedTerms = {
    vehicle: group,
    ...terms,
    ...(source.document ? { documentId: source.document.id } : {}),
    sources: sourcesOf(proposal),
  }

  // The fee schedule, dated from the first closing (or the LPA reading's own words when none is recorded).
  let proposedFeeSchedule: Record<string, unknown> | undefined
  const feeReading = proposal.info.managementFeeSchedule?.value
  if (feeReading) {
    const vehicleId = await vehicleIdByName(admin, fundId, group)
    const { data: closings } = vehicleId
      ? await (admin as any).from('vehicle_closings').select('close_date').eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('close_date').limit(1)
      : { data: [] }
    const first = (closings as any[])?.[0]?.close_date as string | undefined
    if (first) {
      const { schedule, warnings } = lpaFeeScheduleToStored(feeReading, first)
      proposedFeeSchedule = { vehicle: group, schedule }
      proposal.warnings.push(...warnings)
    } else {
      proposal.warnings.push('The LPA states the management fee, but no closing is recorded for this vehicle, so the fee schedule cannot be dated. Ask the person for the initial closing date, then call set_fee_schedule.')
    }
  }

  const show = 'Show the person every proposed term with its quote and confidence, the fields not found, every unsupported provision ' +
    '(the engine does not model them: say what that means for this fund), and every warning. Only if they confirm, call ' +
    'set_waterfall_terms with proposedTerms (adjusted for anything they corrected). It is always staged: a person with GP ' +
    'economics write approves it, and nothing changes until then. If proposedFeeSchedule is present, show it too (frequency, timing, ' +
    'each rate and basis from its date, the end), and only if they confirm, call set_fee_schedule with its schedule, then ' +
    'update_fee_periods action generate to write the periods.'
  return {
    vehicle: group,
    source: source.document ?? { pasted: true, chars: source.text.length },
    method: proposal.method,
    current: { ...current, recipientNames: Object.fromEntries(current.recipients.map(r => [r.lpEntityId, nameOf[r.lpEntityId] ?? r.lpEntityId])) },
    proposal,
    proposedTerms,
    filledFrom: filled,
    ...(proposedFeeSchedule ? { proposedFeeSchedule } : {}),
    ...(keyless
      ? {
          passages: relevantPassages(source.text, ASSISTANT_PASSAGE_BUDGET).map(p => ({ page: p.page, section: p.section, text: p.text })),
          responseShape: LPA_TERMS_RESPONSE_SHAPE,
          rules: LPA_TERMS_RULES,
        }
      : {}),
    written: false,
    next: keyless
      ? 'This is a PATTERN reading (low to medium confidence); the fund\'s model did not read it. Read the passages yourself ' +
        '(they are the clauses on distributions, carry, the hurdle and fees; if a term is not in them, ask the person ' +
        'where the LPA states it), then call extract_lpa_terms again with the same ' +
        'source and assistantProposal set to your reading in responseShape, following rules: it is checked against the ' +
        'document and returned in the same form. Then: ' + show
      : show,
  }
}
