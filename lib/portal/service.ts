/**
 * What an investor can see and do in their portal, as functions: the web portal's routes
 * (app/api/portal/**) and the investor connector (app/api/portal/mcp) both call these, so an LP
 * reaches exactly the same data, under exactly the same checks, whichever way they come in.
 *
 * The caller resolves WHO is asking (an `LpPrincipal`) and nothing else. Everything here scopes to
 * the principal's investor ids and to funds whose LP portal is on, the way each route always did.
 * The connector narrows the investor ids to one fund before calling (lib/portal/principal.ts), so a
 * conversation never reaches past the fund it was connected to.
 *
 * Views, downloads, wire acknowledgments and messages are written to the LP access log with the
 * channel they came through (`metadata.source`: web, api or mcp; lib/audit/source.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { overviewFromLive, type LiveOverviewRow } from '@/lib/lp-overview'
import { lastDataDates, loadPositions } from '@/lib/accounting/lp-positions'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { buildActivity, type VehicleActivityInput } from '@/lib/portal/activity'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { listCapitalCalls } from '@/lib/accounting/capital-calls'
import { listDistributions } from '@/lib/accounting/distributions'
import { getSelfReadState, logLpAccessEvent } from '@/lib/lp-access-log'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { loadItemDocuments } from '@/lib/lp-onboarding-audit'
import { DEFAULT_CONSENT_DISCLOSURE } from '@/lib/tax/delivery'
import {
  buildOnboardingMatrix, normalizeKinds, loadClosingsByEntity, closingPhrase,
  DEFAULT_ONBOARDING_KINDS, ONBOARDING_KIND_HELP, ONBOARDING_MAX_UPLOAD_BYTES,
  type OnboardingEntity, type OnboardingItemRow,
} from '@/lib/lp-onboarding'

export interface LpPrincipal {
  /** The signed-in person (auth.users id). */
  userId: string
  email?: string | null
  lpAccountId: string
  /** The investors this account may act for: its own, and those it is an authorized user of. */
  investorIds: string[]
}

/** A refusal with the status a route answers with. Every "not yours" is a 404. */
export class PortalError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const notFound = () => new PortalError(404, 'Not found')

async function enabledFundsAmong(admin: any, fundIds: string[]): Promise<Set<string>> {
  if (fundIds.length === 0) return new Set()
  const { data } = await admin.from('fund_settings').select('fund_id').eq('lp_portal_enabled', true).in('fund_id', fundIds)
  return new Set(((data ?? []) as any[]).map(f => f.fund_id as string))
}

async function portalOnFor(admin: any, fundId: string): Promise<boolean> {
  const { data } = await admin.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  return !!data?.lp_portal_enabled
}

// ---------------------------------------------------------------------------
// Overview and statements
// ---------------------------------------------------------------------------

/**
 * Headline totals and a per-vehicle breakdown, from the live report the fund has published to
 * this LP (lp_live_report_shares). Only funds with the portal on.
 */
export async function portalOverview(admin: SupabaseClient, p: LpPrincipal) {
  const db = admin as any
  const { data: account } = await db.from('lp_accounts').select('display_name').eq('id', p.lpAccountId).maybeSingle()
  const investorName = (account?.display_name as string | null) ?? null

  const empty = { investorName, currency: 'USD', hasData: false as const }
  if (p.investorIds.length === 0) return empty

  const { data: entities } = await db.from('lp_entities').select('id, fund_id').in('investor_id', p.investorIds)
  const entityRows = (entities ?? []) as any[]
  const entityIds = new Set(entityRows.map(e => e.id as string))
  const fundIds = Array.from(new Set(entityRows.map(e => e.fund_id as string)))
  if (entityIds.size === 0 || fundIds.length === 0) return empty

  const { data: settings } = await db.from('fund_settings').select('fund_id, lp_portal_enabled, currency').in('fund_id', fundIds)
  const enabledFundIds = ((settings ?? []) as any[]).filter(s => s.lp_portal_enabled).map(s => s.fund_id as string)
  if (enabledFundIds.length === 0) return empty
  const currency = ((settings ?? []) as any[]).find(s => s.lp_portal_enabled)?.currency ?? 'USD'

  const { data: shares } = await db.from('lp_live_report_shares').select('fund_id').in('fund_id', enabledFundIds).in('lp_investor_id', p.investorIds)
  const sharedFundIds = Array.from(new Set(((shares ?? []) as any[]).map(s => s.fund_id as string)))
  if (sharedFundIds.length === 0) return { investorName, currency, hasData: false as const }

  // The live report for each shared fund, kept to THIS LP's rows. Look-through member rows carry
  // the member's own entity_id, so the entity filter captures them too.
  const liveRows: LiveOverviewRow[] = []
  const vehicleDates = new Map<string, string | null>()
  for (const fid of sharedFundIds) {
    const report = await generateLiveReport(admin, fid)
    const mine = report.rows.filter(r => entityIds.has(r.entity_id))
    for (const r of mine) {
      liveRows.push({ portfolio_group: r.portfolio_group, commitment: r.commitment, paid_in_capital: r.paid_in_capital, distributions: r.distributions, nav: r.nav })
    }
    const groups = Array.from(new Set(mine.map(r => r.portfolio_group)))
    const m = await lastDataDates(admin, fid, groups)
    for (const [name, date] of Array.from(m.entries())) {
      const prev = vehicleDates.get(name) ?? null
      if (date && (!prev || date > prev)) vehicleDates.set(name, date)
      else if (!vehicleDates.has(name)) vehicleDates.set(name, prev)
    }
  }

  const overview = overviewFromLive(liveRows, vehicleDates)
  if (!overview) return { investorName, currency, hasData: false as const }
  return { investorName, currency, hasData: true as const, ...overview }
}

/** The funds whose live capital statement is published to this LP, with the portal on. */
export async function portalStatementFunds(admin: SupabaseClient, p: LpPrincipal): Promise<string[]> {
  if (p.investorIds.length === 0) return []
  const { data: liveShares } = await (admin as any).from('lp_live_report_shares').select('fund_id').in('lp_investor_id', p.investorIds)
  const shareFundIds = Array.from(new Set(((liveShares ?? []) as any[]).map(s => s.fund_id as string)))
  const enabled = await enabledFundsAmong(admin, shareFundIds)
  return shareFundIds.filter(f => enabled.has(f))
}

/**
 * The investor ids whose live statement for `fundId` this LP may download: published to them,
 * portal on. Throws a 404 otherwise.
 */
export async function portalStatementInvestors(admin: SupabaseClient, p: LpPrincipal, fundId: string): Promise<string[]> {
  if (p.investorIds.length === 0) throw new PortalError(403, 'No access')
  const [{ data: shares }, on] = await Promise.all([
    (admin as any).from('lp_live_report_shares').select('lp_investor_id').eq('fund_id', fundId).in('lp_investor_id', p.investorIds),
    portalOnFor(admin, fundId),
  ])
  const sharedInvestorIds = Array.from(new Set(((shares ?? []) as any[]).map(s => s.lp_investor_id as string)))
  if (sharedInvestorIds.length === 0 || !on) throw new PortalError(404, 'Statement not available')
  return sharedInvestorIds
}

/**
 * The investor's own dated capital movements, newest first, from the same funds and vehicles as
 * the overview (portal on, live report published to them). Each vehicle's postings and positions
 * are kept to this investor's entities before anything is built, and lines are described from
 * their kind, never from an entry's memo (lib/portal/activity.ts).
 */
export async function portalActivity(admin: SupabaseClient, p: LpPrincipal) {
  const db = admin as any
  const empty = { currency: 'USD', lines: [], multipleEntities: false }
  if (p.investorIds.length === 0) return empty

  const { data: entities } = await db.from('lp_entities').select('id, fund_id, entity_name').in('investor_id', p.investorIds)
  const entityRows = (entities ?? []) as any[]
  const entityNames = new Map<string, string>(entityRows.map(e => [e.id as string, (e.entity_name as string | null) ?? 'Your account']))
  const fundIds = Array.from(new Set(entityRows.map(e => e.fund_id as string)))
  if (entityNames.size === 0 || fundIds.length === 0) return empty

  const enabled = await enabledFundsAmong(db, fundIds)
  const { data: settings } = await db.from('fund_settings').select('fund_id, currency').in('fund_id', Array.from(enabled))
  const currency = ((settings ?? []) as any[])[0]?.currency ?? 'USD'
  const { data: shares } = await db.from('lp_live_report_shares').select('fund_id').in('fund_id', Array.from(enabled)).in('lp_investor_id', p.investorIds)
  const sharedFundIds = Array.from(new Set(((shares ?? []) as any[]).map(s => s.fund_id as string)))
  if (sharedFundIds.length === 0) return { ...empty, currency }

  const vehicles: VehicleActivityInput[] = []
  const seenEntities = new Set<string>()
  for (const fid of sharedFundIds) {
    const report = await generateLiveReport(admin, fid)
    const mine = report.rows.filter(r => entityNames.has(r.entity_id))
    for (const r of mine) seenEntities.add(r.entity_id)
    for (const group of Array.from(new Set(mine.map(r => r.portfolio_group)))) {
      const [capital, positions] = await Promise.all([
        loadCapitalPostings(admin, fid, group),
        loadPositions(admin, fid, group),
      ])
      vehicles.push({
        vehicle: group,
        postings: capital.postings.filter(x => entityNames.has(x.lpEntityId)),
        positions: positions.filter(x => entityNames.has(x.lpEntityId)),
      })
    }
  }
  return { currency, lines: buildActivity(vehicles, entityNames), multipleEntities: seenEntities.size > 1 }
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export async function portalLetters(admin: SupabaseClient, p: LpPrincipal) {
  if (p.investorIds.length === 0) return []
  const { data: shares, error } = await (admin as any)
    .from('lp_letter_shares')
    .select('letter_id, shared_at, fund_id, lp_letters(id, period_label, period_year, period_quarter, status)')
    .in('lp_investor_id', p.investorIds)
  if (error) throw error
  const enabledFunds = await enabledFundsAmong(admin, Array.from(new Set(((shares ?? []) as any[]).map(s => s.fund_id as string))))

  const byId = new Map<string, { id: string; period_label: string; period_year: number; period_quarter: number; shared_at: string }>()
  for (const s of (shares ?? []) as any[]) {
    if (!enabledFunds.has(s.fund_id)) continue
    const l = s.lp_letters
    // A shared letter surfaces once it has content (anything past 'generating').
    if (l && l.status !== 'generating' && !byId.has(l.id)) {
      byId.set(l.id, { id: l.id, period_label: l.period_label, period_year: l.period_year, period_quarter: l.period_quarter, shared_at: s.shared_at })
    }
  }
  const sorted = Array.from(byId.values()).sort((a, b) => b.period_year - a.period_year || b.period_quarter - a.period_quarter)
  const readState = await getSelfReadState(admin, { lpAccountId: p.lpAccountId, targetType: 'letter', targetIds: sorted.map(l => l.id) })
  return sorted.map(l => ({ ...l, last_viewed_at: readState[l.id] ?? null }))
}

/** One shared letter: shared with one of the LP's investors, portal on, past 'generating'. Logs a view. */
/**
 * A letter shared with one of this LP's investors, in a fund whose portal is on: the fund, and the
 * investors it was shared with. Throws a 404 otherwise. The web view, its PDF and the connector's
 * PDF link all check through this.
 */
export async function portalLetterShare(admin: SupabaseClient, p: LpPrincipal, letterId: string): Promise<{ fundId: string; sharedInvestorIds: string[] }> {
  if (p.investorIds.length === 0 || !letterId) throw notFound()
  const db = admin as any
  const { data: shares } = await db.from('lp_letter_shares').select('lp_investor_id, fund_id').eq('letter_id', letterId).in('lp_investor_id', p.investorIds)
  if (!shares || shares.length === 0) throw notFound()
  const sharedInvestorIds = Array.from(new Set((shares as any[]).map(s => s.lp_investor_id as string)))
  const fundId = shares[0].fund_id as string
  if (!(await portalOnFor(db, fundId))) throw notFound()
  return { fundId, sharedInvestorIds }
}

export async function portalLetter(admin: SupabaseClient, p: LpPrincipal, letterId: string) {
  const db = admin as any
  const { fundId, sharedInvestorIds } = await portalLetterShare(admin, p, letterId)

  const { data: letter } = await db
    .from('lp_letters').select('id, period_label, status, full_draft, portfolio_table_html, company_narratives').eq('id', letterId).maybeSingle()
  if (!letter || letter.status === 'generating') throw notFound()
  // Defense in depth: scrub the GP-authored HTML before it reaches the LP.
  letter.portfolio_table_html = sanitizeLetterHtml(letter.portfolio_table_html)

  await logLpAccessEvent(admin, {
    fundId, lpAccountId: p.lpAccountId, authUserId: p.userId, lpInvestorId: sharedInvestorIds[0] ?? null,
    eventType: 'view', targetType: 'letter', targetId: letterId, targetTitle: letter.period_label,
    metadata: { investor_ids: sharedInvestorIds },
  })
  return letter as { id: string; period_label: string; status: string; full_draft: string | null; portfolio_table_html: string | null; company_narratives: unknown }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function portalDocuments(admin: SupabaseClient, p: LpPrincipal) {
  if (p.investorIds.length === 0) return []
  const db = admin as any
  const { data: invRows } = await db.from('lp_investors').select('fund_id').in('id', p.investorIds)
  const enabledFunds = await enabledFundsAmong(db, Array.from(new Set(((invRows ?? []) as any[]).map(r => r.fund_id as string))))
  if (enabledFunds.size === 0) return []

  const byId = new Map<string, any>()
  const add = (d: any, scope: string) => {
    if (d && !byId.has(d.id)) {
      byId.set(d.id, {
        id: d.id, title: d.title, file_name: d.file_name, mime_type: d.mime_type, size_bytes: d.size_bytes, uploaded_at: d.uploaded_at,
        category: d.category ?? null, doc_date: d.doc_date ?? null, scope, sample: String(d.storage_path ?? '').startsWith('sample/'),
      })
    }
  }
  const { data: fundDocs } = await db
    .from('lp_documents').select('id, title, file_name, mime_type, size_bytes, uploaded_at, category, doc_date, storage_path')
    .eq('scope', 'fund').in('fund_id', Array.from(enabledFunds))
  for (const d of (fundDocs ?? [])) add(d, 'fund')

  const { data: shares } = await db
    .from('lp_document_shares')
    .select('lp_documents(id, title, file_name, mime_type, size_bytes, uploaded_at, scope, fund_id, category, doc_date, storage_path)')
    .in('lp_investor_id', p.investorIds)
  for (const s of (shares ?? []) as any[]) {
    const d = s.lp_documents
    if (d && d.scope === 'investor' && enabledFunds.has(d.fund_id)) add(d, 'investor')
  }

  const sorted = Array.from(byId.values()).sort((a, b) => (b.uploaded_at ?? '').localeCompare(a.uploaded_at ?? ''))
  // Sample docs are never really "downloaded"; leave their read state null.
  const readState = await getSelfReadState(admin, { lpAccountId: p.lpAccountId, targetType: 'document', targetIds: sorted.filter(d => !d.sample).map(d => d.id) })
  return sorted.map(d => ({ ...d, last_viewed_at: d.sample ? null : (readState[d.id] ?? null) }))
}

/**
 * A short-lived signed URL for one document, after checking the LP may see it: portal on, and
 * either fund-wide in a fund they belong to or investor-scoped and shared with them. Logs a view
 * (inline) or a download.
 */
export async function portalDocumentUrl(
  admin: SupabaseClient, p: LpPrincipal, documentId: string, opts: { inline?: boolean; ttlSeconds?: number } = {},
): Promise<{ url: string; title: string; fileName: string }> {
  if (p.investorIds.length === 0) throw notFound()
  const db = admin as any
  const { data: doc } = await db.from('lp_documents').select('id, fund_id, scope, storage_path, file_name, title').eq('id', documentId).maybeSingle()
  if (!doc) throw notFound()
  if (String(doc.storage_path).startsWith('sample/')) throw new PortalError(404, 'This is a sample document.')
  if (!(await portalOnFor(db, doc.fund_id))) throw notFound()

  let allowed = false
  if (doc.scope === 'fund') {
    const { data: inv } = await db.from('lp_investors').select('id').eq('fund_id', doc.fund_id).in('id', p.investorIds).limit(1)
    allowed = (inv ?? []).length > 0
  } else {
    const { data: share } = await db.from('lp_document_shares').select('id').eq('document_id', doc.id).in('lp_investor_id', p.investorIds).limit(1)
    allowed = (share ?? []).length > 0
  }
  if (!allowed) throw notFound()

  const { data: signed, error } = await admin.storage
    .from('lp-documents')
    .createSignedUrl(doc.storage_path, opts.ttlSeconds ?? 300, opts.inline ? {} : { download: doc.file_name })
  if (error || !signed) throw new PortalError(500, 'Could not generate download link')

  await logLpAccessEvent(admin, {
    fundId: doc.fund_id, lpAccountId: p.lpAccountId, authUserId: p.userId,
    eventType: opts.inline ? 'view' : 'download', targetType: 'document', targetId: doc.id, targetTitle: doc.title ?? doc.file_name,
    metadata: { scope: doc.scope },
  })
  return { url: signed.signedUrl, title: doc.title ?? doc.file_name, fileName: doc.file_name }
}

// ---------------------------------------------------------------------------
// Capital calls and distributions
// ---------------------------------------------------------------------------

export interface PortalNotice {
  kind: 'capital_call' | 'distribution'
  lineId: string
  fundId: string
  vehicle: string
  date: string
  number: number | null
  description: string | null
  dueDate: string | null
  amount: number
  settled: number
  outstanding: number
  status: 'open' | 'partial' | 'settled'
  settledOn: string | null
  /** The notice PDF, once the fund has published it. */
  documentId: string | null
  documentViewedAt: string | null
  /** The LP's own acknowledgment, if they made one. */
  ack: { at: string; wiredOn: string | null; reference: string | null; note: string | null } | null
  /** The receipts filed against this line, newest first. */
  receipts: { documentId: string; title: string; date: string | null }[]
  currency: string
}

/**
 * Every capital call and distribution line for the LP's entities, with its status from the fund's
 * books (the same lists the GP reads, so both sides see one number), the notice document once
 * published, and the LP's own acknowledgment.
 */
export async function portalNotices(admin: SupabaseClient, p: LpPrincipal): Promise<PortalNotice[]> {
  if (p.investorIds.length === 0) return []
  const db = admin as any
  const { data: entities } = await db.from('lp_entities').select('id, fund_id, investor_id').in('investor_id', p.investorIds)
  const entityRows = (entities ?? []) as any[]
  const entityIds = new Set(entityRows.map(e => e.id as string))
  const fundIds = Array.from(new Set(entityRows.map(e => e.fund_id as string)))
  if (entityIds.size === 0) return []

  const { data: settings } = await db.from('fund_settings').select('fund_id, lp_portal_enabled, currency').in('fund_id', fundIds)
  const enabled = new Map<string, string>()
  for (const s of ((settings ?? []) as any[])) if (s.lp_portal_enabled) enabled.set(s.fund_id, s.currency ?? 'USD')
  if (enabled.size === 0) return []

  const [{ data: callLines }, { data: distLines }, { data: vehicles }] = await Promise.all([
    db.from('capital_call_lines').select('fund_id, vehicle_id').in('lp_entity_id', Array.from(entityIds)),
    db.from('distribution_lines').select('fund_id, vehicle_id').in('lp_entity_id', Array.from(entityIds)),
    db.from('fund_vehicles').select('id, fund_id, name').in('fund_id', Array.from(enabled.keys())),
  ])
  const vehicleName = new Map<string, { fundId: string; name: string }>(
    ((vehicles ?? []) as any[]).map(v => [v.id as string, { fundId: v.fund_id as string, name: v.name as string }]),
  )
  const targets = new Map<string, { fundId: string; name: string }>()
  for (const r of [...((callLines ?? []) as any[]), ...((distLines ?? []) as any[])]) {
    const v = r.vehicle_id ? vehicleName.get(r.vehicle_id) : undefined
    if (v && enabled.has(v.fundId)) targets.set(r.vehicle_id, v)
  }

  const notices: PortalNotice[] = []
  for (const { fundId, name } of Array.from(targets.values())) {
    const currency = enabled.get(fundId) ?? 'USD'
    const [calls, dists] = await Promise.all([listCapitalCalls(admin, fundId, name), listDistributions(admin, fundId, name)])
    for (const c of calls) for (const l of c.lines) {
      if (!entityIds.has(l.lpEntityId)) continue
      notices.push({
        kind: 'capital_call', lineId: l.id, fundId, vehicle: name, date: c.callDate, number: c.callNumber,
        description: c.description, dueDate: c.dueDate, amount: l.amount, settled: l.settled, outstanding: l.outstanding,
        status: l.status, settledOn: l.settledOn, documentId: l.noticeDocumentId, documentViewedAt: null, ack: l.ack, receipts: [], currency,
      })
    }
    for (const d of dists) for (const l of d.lines) {
      if (!entityIds.has(l.lpEntityId)) continue
      notices.push({
        kind: 'distribution', lineId: l.id, fundId, vehicle: name, date: d.date, number: null,
        description: l.role === 'carry' ? `${d.description ?? 'Distribution'} — carried interest` : d.description,
        dueDate: null, amount: l.amount, settled: l.settled, outstanding: l.outstanding,
        status: l.status, settledOn: l.settledOn, documentId: l.noticeDocumentId, documentViewedAt: null, ack: null, receipts: [], currency,
      })
    }
  }

  // Receipts: investor-scoped documents in the receipt category, matched to lines through the
  // delivery log, the only record of which line a receipt was for.
  const callLineIds = notices.filter(n => n.kind === 'capital_call').map(n => n.lineId)
  if (callLineIds.length > 0) {
    const { data: deliveries } = await db.from('lp_deliveries').select('item_id, sent_at').eq('kind', 'receipt').eq('status', 'sent').in('item_id', callLineIds)
    const receiptedLines = new Set(((deliveries ?? []) as any[]).map(d => d.item_id as string))
    if (receiptedLines.size > 0) {
      const { data: shares } = await db
        .from('lp_document_shares').select('lp_documents(id, title, doc_date, category, fund_id, uploaded_at)').in('lp_investor_id', p.investorIds)
      const receiptDocs = ((shares ?? []) as any[])
        .map(s => s.lp_documents)
        .filter(d => d && d.category === 'Capital Call Receipt' && enabled.has(d.fund_id))
        .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))
      // Without a line id on the document, the best join is the title: it names the call by
      // number and date, as the line's card does.
      for (const n of notices) {
        if (n.kind !== 'capital_call' || !receiptedLines.has(n.lineId)) continue
        const label = `Capital Call${n.number ? ` No. ${n.number}` : ''} — ${n.date}`
        n.receipts = receiptDocs.filter(d => String(d.title).includes(label)).map(d => ({ documentId: d.id, title: d.title, date: d.doc_date ?? null }))
      }
    }
  }

  const docIds = notices.map(n => n.documentId).filter(Boolean) as string[]
  const readState = docIds.length > 0 ? await getSelfReadState(admin, { lpAccountId: p.lpAccountId, targetType: 'document', targetIds: docIds }) : {}
  for (const n of notices) if (n.documentId) n.documentViewedAt = readState[n.documentId] ?? null

  notices.sort((a, b) => b.date.localeCompare(a.date))
  return notices
}

/**
 * "We've wired": the partner's acknowledgment of a capital call. Recorded on the register line for
 * the GP and as a tiebreak for the bank matcher. It is the partner's word, not a settlement: the
 * money is settled when the ledger says so.
 */
export async function acknowledgeCapitalCall(
  admin: SupabaseClient, p: LpPrincipal,
  input: { lineId: unknown; wiredOn?: unknown; reference?: unknown; note?: unknown },
): Promise<{ ok: true; lineId: string }> {
  if (p.investorIds.length === 0) throw new PortalError(403, 'No access')
  const lineId = typeof input.lineId === 'string' ? input.lineId : ''
  if (!lineId) throw new PortalError(400, 'lineId is required')
  const wiredOn = typeof input.wiredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.wiredOn) ? input.wiredOn : null
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 120) : ''
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : ''

  const db = admin as any
  const { data: line } = await db.from('capital_call_lines').select('id, fund_id, lp_entity_id').eq('id', lineId).maybeSingle()
  if (!line) throw notFound()
  // The line must belong to one of the LP's own entities, in a fund whose portal is on.
  const [{ data: entity }, on] = await Promise.all([
    db.from('lp_entities').select('id, investor_id').eq('id', line.lp_entity_id).in('investor_id', p.investorIds).maybeSingle(),
    portalOnFor(db, line.fund_id),
  ])
  if (!entity || !on) throw notFound()

  const { error } = await db.from('capital_call_lines').update({
    ack_at: new Date().toISOString(),
    ack_wired_on: wiredOn,
    ack_reference: reference || null,
    ack_note: note || null,
    ack_lp_account_id: p.lpAccountId,
  }).eq('id', lineId)
  if (error) throw new PortalError(500, 'Could not record the acknowledgment')

  await logLpAccessEvent(admin, {
    fundId: line.fund_id, lpAccountId: p.lpAccountId, authUserId: p.userId, lpInvestorId: entity.investor_id ?? null,
    eventType: 'acknowledge', targetType: 'capital_call', targetId: lineId, targetTitle: 'Capital call wire acknowledged',
    metadata: { wired_on: wiredOn, reference: reference || null },
  })
  return { ok: true, lineId }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function portalMessages(admin: SupabaseClient, p: LpPrincipal) {
  if (p.investorIds.length === 0) return []
  const db = admin as any
  const { data: invRows } = await db.from('lp_investors').select('id, fund_id, name').in('id', p.investorIds)
  const enabled = await enabledFundsAmong(db, Array.from(new Set(((invRows ?? []) as any[]).map(r => r.fund_id as string))))
  if (enabled.size === 0) return []
  const fundName = new Map<string, string>()
  const { data: funds } = await db.from('funds').select('id, name').in('id', Array.from(enabled))
  for (const f of ((funds ?? []) as any[])) fundName.set(f.id, f.name)

  const { data } = await db
    .from('lp_messages')
    .select('id, fund_id, subject, body, created_at, direction, parent_id, announcement_id, lp_investor_id')
    .in('lp_investor_id', p.investorIds)
    .in('fund_id', Array.from(enabled))
    .order('created_at', { ascending: true })
    .limit(500)

  return ((data ?? []) as any[]).map(r => ({
    id: r.id as string,
    fund: fundName.get(r.fund_id) ?? 'Your fund',
    subject: r.subject as string | null,
    body: r.body as string,
    created_at: r.created_at as string,
    // 'you' wrote it, or 'fund' did; an announcement is a fund message with no parent.
    from: (r.direction === 'outbound' ? 'fund' : 'you') as 'fund' | 'you',
    kind: (r.direction === 'outbound' ? (r.announcement_id ? 'announcement' : 'reply') : 'message') as 'announcement' | 'reply' | 'message',
    parent_id: (r.parent_id ?? null) as string | null,
  }))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/**
 * A message to the fund: recorded in the LP inbox (so it is never lost) and emailed to the fund's
 * admins when outbound email is set up (best-effort).
 */
export async function sendPortalMessage(
  admin: SupabaseClient, p: LpPrincipal, input: { subject?: unknown; message?: unknown },
): Promise<{ ok: true; emailed: boolean }> {
  if (!p.investorIds.length) throw new PortalError(403, 'No access')
  const subject = typeof input.subject === 'string' ? input.subject.trim().slice(0, 200) : ''
  const message = typeof input.message === 'string' ? input.message.trim().slice(0, 5000) : ''
  if (!message) throw new PortalError(400, 'Message is required')

  const db = admin as any
  const { data: inv } = await db.from('lp_investors').select('fund_id, name').eq('id', p.investorIds[0]).maybeSingle()
  const fundId = inv?.fund_id as string | undefined
  if (!fundId) throw new PortalError(400, 'No fund found')
  const investorName = inv?.name ?? 'An investor'

  const { data: acct } = await db.from('lp_accounts').select('email').eq('id', p.lpAccountId).maybeSingle()
  const fromEmail = (acct?.email ?? p.email ?? 'unknown') as string

  await db.from('lp_messages').insert({
    fund_id: fundId, lp_account_id: p.lpAccountId, lp_investor_id: p.investorIds[0], from_email: fromEmail,
    subject: subject || null, body: message,
  })
  await logLpAccessEvent(admin, {
    fundId, lpAccountId: p.lpAccountId, authUserId: p.userId, lpInvestorId: p.investorIds[0],
    eventType: 'message', targetType: 'portal', targetTitle: subject || 'Message to the fund',
  })

  const { data: members } = await db.from('fund_members').select('user_id').eq('fund_id', fundId).eq('role', 'admin')
  const adminEmails: string[] = []
  for (const m of (members ?? []) as Array<{ user_id: string }>) {
    const { data: { user: u } } = await db.auth.admin.getUserById(m.user_id)
    if (u?.email) adminEmails.push(u.email)
  }

  let emailed = false
  const config = await getOutboundConfig(admin, fundId)
  if (config && adminEmails.length) {
    const html =
      `<p><strong>${escapeHtml(investorName)}</strong> (${escapeHtml(fromEmail)}) sent a message via your investor portal.</p>` +
      (subject ? `<p><strong>${escapeHtml(subject)}</strong></p>` : '') +
      `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>` +
      `<p style="color:#888;font-size:12px">Reply directly to ${escapeHtml(fromEmail)}.</p>`
    for (const to of adminEmails) {
      try {
        await sendOutboundEmail(config, { to, subject: `LP message: ${subject || `Question from ${investorName}`}`, html })
        emailed = true
      } catch (err) {
        console.error('[portal-contact] email failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  return { ok: true, emailed }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/** The LP's entities in funds whose portal is on, with each fund's requirement set. */
export async function loadOnboardingEntities(admin: any, investorIds: string[]) {
  if (investorIds.length === 0) return { entities: [] as any[], kindsByFund: new Map<string, string[]>() }
  const { data: ents } = await admin
    .from('lp_entities').select('id, fund_id, entity_name, investor_id, onboarding_excluded, lp_investors(name)')
    .in('investor_id', investorIds).eq('onboarding_excluded', false).order('entity_name')
  const fundIds = Array.from(new Set(((ents ?? []) as any[]).map(e => e.fund_id as string)))
  if (fundIds.length === 0) return { entities: [] as any[], kindsByFund: new Map<string, string[]>() }
  const { data: settings } = await admin.from('fund_settings').select('fund_id, lp_portal_enabled, lp_onboarding_kinds').in('fund_id', fundIds)
  const kindsByFund = new Map<string, string[]>()
  for (const s of (settings ?? []) as any[]) {
    if (!s.lp_portal_enabled) continue
    kindsByFund.set(s.fund_id, s.lp_onboarding_kinds == null ? DEFAULT_ONBOARDING_KINDS : normalizeKinds(s.lp_onboarding_kinds))
  }
  return { entities: ((ents ?? []) as any[]).filter(e => kindsByFund.has(e.fund_id)), kindsByFund }
}

/** The LP's onboarding checklist: each entity with the fund's required items and their status. */
export async function portalOnboarding(admin: SupabaseClient, p: LpPrincipal) {
  const db = admin as any
  const { entities, kindsByFund } = await loadOnboardingEntities(db, p.investorIds)
  if (entities.length === 0) return { entities: [] as any[] }

  const { data: items } = await db
    .from('lp_onboarding_items')
    .select('id, lp_entity_id, kind, status, document_id, submitted_at, reviewed_at, expires_on, note')
    .in('lp_entity_id', entities.map(e => e.id))
  const docsByItem = await loadItemDocuments(db, ((items ?? []) as any[]).map(i => i.id))

  const closings = await loadClosingsByEntity(db, entities.map(e => e.id))
  // Electronic K-1 consent is the investor's own election: the principal account gives it.
  const { data: me } = await db.from('lp_accounts').select('kind').eq('id', p.lpAccountId).maybeSingle()
  const canConsent = (me as { kind?: string } | null)?.kind === 'lp'

  const fundIds = Array.from(new Set(entities.map(e => e.fund_id as string)))
  const { data: funds } = await db.from('funds').select('id, name').in('id', fundIds)
  const fundName = new Map<string, string>(((funds ?? []) as any[]).map(f => [f.id, f.name]))

  const out: any[] = []
  for (const fundId of fundIds) {
    const list: OnboardingEntity[] = entities.filter(e => e.fund_id === fundId).map(e => ({
      id: e.id, name: e.entity_name, investorId: e.investor_id, investorName: e.lp_investors?.name ?? '',
      closing: closings.get(e.id) ?? null,
    }))
    const rows = buildOnboardingMatrix(list, kindsByFund.get(fundId) as any, (items ?? []) as OnboardingItemRow[])
    for (const r of rows) {
      out.push({
        id: r.id, name: r.name, fundName: fundName.get(fundId) ?? '', outstanding: r.outstanding, complete: r.complete,
        closing: r.closing ? { name: r.closing.name, closeDate: r.closing.closeDate, phrase: closingPhrase(r.closing, r.daysToClose), daysToClose: r.daysToClose } : null,
        items: r.items.map(i => ({
          kind: i.kind, label: i.label, help: ONBOARDING_KIND_HELP[i.kind], status: i.status, expired: i.expired,
          documentId: i.documentId, submittedAt: i.submittedAt, reviewedAt: i.reviewedAt, expiresOn: i.expiresOn,
          documents: (i.itemId ? docsByItem.get(i.itemId) ?? [] : []).map(d => ({ id: d.id, fileName: d.file_name, addedAt: d.added_at, mine: d.added_by_account === p.lpAccountId })),
          // The fund's note is for the LP only when the item was sent back or waived.
          note: i.status === 'rejected' || i.status === 'waived' ? i.note : null,
        })),
      })
    }
  }
  return { entities: out, maxBytes: ONBOARDING_MAX_UPLOAD_BYTES, canConsent, disclosure: DEFAULT_CONSENT_DISCLOSURE }
}
