// lib/portfolio/fof-email.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { AIProvider, ContentBlock } from '@/lib/ai/types'
import { readManagerDocument, type ExtractedRow } from './fof-extract'
import { matchHoldings } from './fof-paste'
import { resolveHoldingVehicle } from './fof-register'
import { CAPS, capText, FUND_REVIEW_TYPES, issueTypeFor, type FundProposal } from './fof-review-types'

/**
 * A manager's email about a FUND HOLDING feeds its register — through review. The document is read
 * (fof-extract.ts), each NAV, call and distribution it reports becomes one parsing_reviews row with
 * the proposal in `payload`, and NOTHING is written to the register until a person approves it
 * (fof-reviews.ts). The entity is filled in when the holding has exactly one; otherwise it is chosen
 * at approval, and until then only unscoped callers see the review.
 */

const CENT = 0.005

const DAY_MS = 86_400_000
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export { CAPS }
const cap = capText

export function proposalsFromRows(
  rows: ExtractedRow[],
  holding: { id: string; name: string; aliases?: string[] | null },
  opts: { fallbackDate: string },
): { proposals: FundProposal[]; warnings: string[] } {
  const warnings: string[] = []
  // The email was already matched to this holding, so a document about ONE fund is taken as this
  // fund even when the manager prints a longer legal name. A document reporting on several is
  // matched by name or alias only — a wrong match would propose another fund's call against this one.
  const mine: ExtractedRow[] = rows.length <= 1
    ? rows
    : matchHoldings(rows, [holding]).filter(x => x.companyId).map(x => x.row as ExtractedRow)
  if (rows.length > 1 && mine.length === 0) {
    warnings.push(`The document reports on ${rows.length} funds and none is named ${holding.name}; nothing was proposed.`)
  }

  const proposals: FundProposal[] = []
  for (const r of mine) {
    const from = { fundName: cap(r.fundName, CAPS.fundName) ?? '', confidence: r.confidence, sourceText: cap(r.sourceText, CAPS.sourceText) }
    if (r.reportedNav !== null && r.navAsOf) {
      proposals.push({ kind: 'nav', ...from, asOfDate: r.navAsOf, reportedNav: r.reportedNav })
    } else if (r.reportedNav !== null) {
      warnings.push(`${r.fundName}: a NAV with no valuation date was not proposed.`)
    }
    const eventDate = r.eventDate ?? r.navAsOf ?? opts.fallbackDate
    const notice = (kind: 'call' | 'distribution', amount: number): FundProposal => ({
      kind, ...from, eventDate, dueDate: r.dueDate, noticeNumber: cap(r.noticeNumber, CAPS.noticeNumber), purpose: cap(r.purpose, CAPS.purpose), amount,
      dateAssumed: !r.eventDate,
    })
    if (r.calls > 0) proposals.push(notice('call', r.calls))
    if (r.distributions > 0) proposals.push(notice('distribution', r.distributions))
  }
  return { proposals, warnings }
}

/**
 * Whether the register already has this row: a NAV for the same date and value, or a notice of the
 * same kind and amount near the same date (within a week, or — when the date was assumed from a
 * statement's period end — within the quarter before it, where the notice itself would be dated).
 */
async function alreadyRecorded(
  admin: SupabaseClient, fundId: string, companyId: string, vehicleId: string | null, p: FundProposal,
): Promise<boolean | { error: string }> {
  if (p.kind === 'nav') {
    let q = (admin as any).from('fund_nav_statements').select('reported_nav')
      .eq('fund_id', fundId).eq('company_id', companyId).eq('as_of_date', p.asOfDate)
    q = vehicleId ? q.eq('vehicle_id', vehicleId) : q.is('vehicle_id', null)
    const { data, error } = await q
    if (error) return { error: error.message }
    return ((data as any[]) ?? []).some(n => Math.abs(Number(n.reported_nav) - p.reportedNav) < CENT)
  }
  const from = p.dateAssumed ? shift(p.eventDate, -92) : shift(p.eventDate, -8)
  const to = p.dateAssumed ? p.eventDate : shift(p.eventDate, 7)
  let q = (admin as any).from('fund_capital_events').select('amount')
    .eq('fund_id', fundId).eq('company_id', companyId).eq('kind', p.kind)
    .gt('event_date', from).lte('event_date', to)
  q = vehicleId ? q.eq('vehicle_id', vehicleId) : q.is('vehicle_id', null)
  const { data, error } = await q
  if (error) return { error: error.message }
  return ((data as any[]) ?? []).some(e => Math.abs(Number(e.amount) - p.amount) < CENT)
}

/** The same proposal already waiting for review — the same email processed twice, or a forward of it. */
function samePending(open: { issue_type: string; payload: any }[], p: FundProposal): boolean {
  return open.some(r => {
    if (r.issue_type !== issueTypeFor(p) || !r.payload) return false
    if (p.kind === 'nav') return r.payload.asOfDate === p.asOfDate && Math.abs(Number(r.payload.reportedNav) - p.reportedNav) < CENT
    return r.payload.eventDate === p.eventDate && Math.abs(Number(r.payload.amount) - p.amount) < CENT
  })
}

export interface ProposeInput {
  fundId: string
  emailId: string
  companyId: string
  /** Whose entities the holding's entity may be inferred among: the forwarder's, or the fund's for outside mail. */
  access: Pick<AccessContext, 'vehicles'>
  ai: { provider: Pick<AIProvider, 'createMessage'>; model: string }
  content: ContentBlock[]
  /** The email's date, for a call or distribution the document gives no date for. */
  fallbackDate: string
}

export async function proposeFundReviews(
  admin: SupabaseClient,
  input: ProposeInput,
): Promise<{ written: number; warnings: string[] }> {
  const { data: holding, error: holdingError } = await admin.from('companies')
    .select('id, name, aliases, holding_type').eq('fund_id', input.fundId).eq('id', input.companyId).maybeSingle()
  if (holdingError) return { written: 0, warnings: [`The holding could not be looked up: ${holdingError.message}`] }
  if (!holding || (holding as any).holding_type !== 'fund') return { written: 0, warnings: [] }

  let read: { rows: ExtractedRow[]; warnings: string[] }
  try {
    read = await readManagerDocument(input.ai, input.content)
  } catch (e) {
    return { written: 0, warnings: [`The manager document could not be read: ${(e as Error).message}`] }
  }
  const { proposals, warnings } = proposalsFromRows(read.rows, holding as any, { fallbackDate: input.fallbackDate })

  const resolved = await resolveHoldingVehicle(admin, input.fundId, input.companyId, undefined, input.access)
  const vehicleId = 'vehicleId' in resolved ? resolved.vehicleId : null

  const { data: open, error: openError } = await (admin as any).from('parsing_reviews')
    .select('issue_type, payload').eq('fund_id', input.fundId).eq('company_id', input.companyId)
    .is('resolution', null).in('issue_type', [...FUND_REVIEW_TYPES])
  if (openError) return { written: 0, warnings: [...warnings, `Open reviews could not be checked, so nothing was proposed: ${openError.message}`] }
  const pending = ((open as any[]) ?? [])

  const fresh: FundProposal[] = []
  for (const p of proposals) {
    if (samePending(pending, p)) continue
    const recorded = await alreadyRecorded(admin, input.fundId, input.companyId, vehicleId, p)
    if (typeof recorded === 'object') {
      return { written: 0, warnings: [...warnings, `The register could not be checked, so nothing was proposed: ${recorded.error}`] }
    }
    if (recorded) continue
    fresh.push(p)
    // An accepted proposal also counts as pending for the rest of this batch.
    pending.push({ issue_type: issueTypeFor(p), payload: p })
  }
  const allWarnings = [...read.warnings, ...warnings]
  if (fresh.length === 0) return { written: 0, warnings: allWarnings }

  const { error } = await (admin as any).from('parsing_reviews').insert(fresh.map(p => ({
    fund_id: input.fundId,
    email_id: input.emailId,
    company_id: input.companyId,
    vehicle_id: vehicleId,
    issue_type: issueTypeFor(p),
    payload: p,
    extracted_value: String(p.kind === 'nav' ? p.reportedNav : p.amount),
    context_snippet: p.sourceText,
  })))
  if (error) return { written: 0, warnings: [...allWarnings, `The proposals could not be saved for review: ${error.message}`] }
  return { written: fresh.length, warnings: allWarnings }
}
