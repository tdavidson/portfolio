// Fund connections: two funds agreeing that some of their LPs are the same LP, so a report card can
// show an LP everything they hold across both. See supabase/migrations/20261016030000_fund_connections.sql
// for the model; the short version is two levels of consent, both from admins:
//
//   1. A connection between two funds: one fund's admin asks, the other fund's admin accepts.
//   2. Each investor pair under it: both funds' admins approve. Proposing a pair approves it for
//      the side that proposed it.
//
// Only an approved pair on an active connection carries positions across. Either fund can remove a
// pair or disconnect at any time, and the report cards drop the other fund's positions at once.
//
// Every function here takes the CALLER's fund and acts only as that fund: it never accepts the
// other side's approval, and it shows the other fund's investors only where they are already in a
// pair or match one of ours (lib/fund-connections/matching.ts). Callers are admin-only routes.

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateLiveReport, type LiveInvestmentRow } from '@/lib/accounting/live-report'
import { lastDataDates } from '@/lib/accounting/lp-positions'
import { carryRecipientIds } from '@/lib/access/carry-visibility'
import { findExact, suggestPairs, type MatchableInvestor, type Suggestion } from './matching'

type Db = SupabaseClient | any

export type ConnectionStatus = 'pending' | 'active' | 'declined' | 'cancelled' | 'disconnected'

export interface ConnectionRow {
  id: string
  requester_fund_id: string
  recipient_fund_id: string
  status: ConnectionStatus
  requested_at: string
  responded_at: string | null
}

export interface ConnectionView {
  id: string
  status: ConnectionStatus
  /** outgoing = we asked; incoming = they asked us. */
  direction: 'outgoing' | 'incoming'
  otherFundId: string
  otherFundName: string
  requestedAt: string
  respondedAt: string | null
  pairs: { approved: number; awaitingUs: number; awaitingThem: number }
}

export interface PairView {
  id: string
  ours: { id: string; name: string }
  theirs: { id: string; name: string }
  ourApproval: boolean
  theirApproval: boolean
  approved: boolean
}

export class ConnectionError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const LIVE: ConnectionStatus[] = ['pending', 'active']

/** Which side of the connection the caller's fund is on, or null when it is on neither. */
export function sideOf(c: Pick<ConnectionRow, 'requester_fund_id' | 'recipient_fund_id'>, fundId: string): 'requester' | 'recipient' | null {
  if (c.requester_fund_id === fundId) return 'requester'
  if (c.recipient_fund_id === fundId) return 'recipient'
  return null
}

async function logEvent(db: Db, connectionId: string, fundId: string, userId: string | null, action: string, detail: Record<string, unknown> = {}) {
  await db.from('fund_connection_events').insert({ connection_id: connectionId, fund_id: fundId, user_id: userId, action, detail })
}

async function loadConnection(db: Db, fundId: string, connectionId: string) {
  const { data, error } = await db.from('fund_connections')
    .select('id, requester_fund_id, recipient_fund_id, status, requested_at, responded_at')
    .eq('id', connectionId).maybeSingle()
  if (error) throw error
  const side = data ? sideOf(data, fundId) : null
  if (!data || !side) throw new ConnectionError('No such connection.', 404)
  const c = data as ConnectionRow
  return { c, side, otherFundId: side === 'requester' ? c.recipient_fund_id : c.requester_fund_id }
}

/** A fund's connections in these states, on either side. Two reads, not an `or` filter on a
 *  string built from the id. */
async function connectionsOf(db: Db, fundId: string, statuses: ConnectionStatus[]): Promise<ConnectionRow[]> {
  const cols = 'id, requester_fund_id, recipient_fund_id, status, requested_at, responded_at'
  const [asked, askedUs] = await Promise.all([
    db.from('fund_connections').select(cols).eq('requester_fund_id', fundId).in('status', statuses),
    db.from('fund_connections').select(cols).eq('recipient_fund_id', fundId).in('status', statuses),
  ])
  if (asked.error) throw asked.error
  if (askedUs.error) throw askedUs.error
  return [...(asked.data ?? []), ...(askedUs.data ?? [])] as ConnectionRow[]
}

const isApproved = (l: { requester_approved_at: string | null; recipient_approved_at: string | null }) =>
  !!l.requester_approved_at && !!l.recipient_approved_at

/** The caller's fund's pending and active connections, newest first. */
export async function listConnections(db: Db, fundId: string): Promise<ConnectionView[]> {
  const rows = (await connectionsOf(db, fundId, LIVE)).sort((a, b) => b.requested_at.localeCompare(a.requested_at))
  if (rows.length === 0) return []

  const otherIds = rows.map(c => (c.requester_fund_id === fundId ? c.recipient_fund_id : c.requester_fund_id))
  const [{ data: funds }, { data: links }] = await Promise.all([
    db.from('funds').select('id, name').in('id', otherIds),
    db.from('lp_investor_links').select('connection_id, requester_approved_at, recipient_approved_at').in('connection_id', rows.map(c => c.id)),
  ])
  const names = new Map(((funds ?? []) as { id: string; name: string }[]).map(f => [f.id, f.name]))

  return rows.map(c => {
    const side = sideOf(c, fundId)!
    const mine = ((links ?? []) as any[]).filter(l => l.connection_id === c.id)
    const ours = (l: any) => !!(side === 'requester' ? l.requester_approved_at : l.recipient_approved_at)
    const theirs = (l: any) => !!(side === 'requester' ? l.recipient_approved_at : l.requester_approved_at)
    const otherFundId = side === 'requester' ? c.recipient_fund_id : c.requester_fund_id
    return {
      id: c.id,
      status: c.status,
      direction: side === 'requester' ? 'outgoing' : 'incoming',
      otherFundId,
      otherFundName: names.get(otherFundId) ?? 'Another fund',
      requestedAt: c.requested_at,
      respondedAt: c.responded_at,
      pairs: {
        approved: mine.filter(l => ours(l) && theirs(l)).length,
        awaitingUs: mine.filter(l => !ours(l) && theirs(l)).length,
        awaitingThem: mine.filter(l => ours(l) && !theirs(l)).length,
      },
    }
  })
}

/** Ask the fund that `email` is an admin of to connect. */
export async function requestConnection(db: Db, opts: { fundId: string; userId: string; email: string }): Promise<{ id: string; otherFundName: string }> {
  const email = opts.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConnectionError('Enter the email address of an admin of the other fund.')
  const { data: target, error } = await db.rpc('fund_for_admin_email', { p_email: email })
  if (error) throw error
  const fund = ((target ?? []) as { fund_id: string; fund_name: string }[])[0]
  if (!fund) throw new ConnectionError('No fund on this platform has an admin with that email address.', 404)
  if (fund.fund_id === opts.fundId) throw new ConnectionError('That address is an admin of this fund.')

  const { data: row, error: insertError } = await db.from('fund_connections')
    .insert({ requester_fund_id: opts.fundId, recipient_fund_id: fund.fund_id, requested_by: opts.userId })
    .select('id').single()
  if (insertError?.code === '23505') throw new ConnectionError(`This fund already has a connection with ${fund.fund_name}, or a request waiting.`, 409)
  if (insertError) throw insertError
  await logEvent(db, row.id, opts.fundId, opts.userId, 'requested', { recipient_fund_id: fund.fund_id })
  return { id: row.id, otherFundName: fund.fund_name }
}

/** Accept or decline a request made to the caller's fund. */
export async function respondToConnection(db: Db, opts: { fundId: string; userId: string; connectionId: string; accept: boolean }) {
  const { c, side } = await loadConnection(db, opts.fundId, opts.connectionId)
  if (side !== 'recipient') throw new ConnectionError('Only the fund that was asked can answer a request.', 403)
  if (c.status !== 'pending') throw new ConnectionError('This request has already been answered.', 409)
  const status: ConnectionStatus = opts.accept ? 'active' : 'declined'
  const patch: Record<string, unknown> = { status, responded_by: opts.userId, responded_at: new Date().toISOString() }
  if (!opts.accept) Object.assign(patch, { ended_by_fund_id: opts.fundId, ended_at: patch.responded_at })
  const { error } = await db.from('fund_connections').update(patch).eq('id', c.id).eq('status', 'pending')
  if (error) throw error
  await logEvent(db, c.id, opts.fundId, opts.userId, opts.accept ? 'accepted' : 'declined')
}

/**
 * End a connection from either side: cancel our own request, decline theirs, or disconnect an
 * active one. Disconnecting removes every pair under it, so nothing crosses afterwards.
 */
export async function endConnection(db: Db, opts: { fundId: string; userId: string; connectionId: string }) {
  const { c, side } = await loadConnection(db, opts.fundId, opts.connectionId)
  if (!LIVE.includes(c.status)) throw new ConnectionError('This connection has already ended.', 409)
  const status: ConnectionStatus = c.status === 'active' ? 'disconnected' : side === 'requester' ? 'cancelled' : 'declined'
  const now = new Date().toISOString()
  const { count } = await db.from('lp_investor_links').delete({ count: 'exact' }).eq('connection_id', c.id)
  const patch: Record<string, unknown> = { status, ended_by_fund_id: opts.fundId, ended_at: now }
  if (c.status === 'pending' && side === 'recipient') Object.assign(patch, { responded_by: opts.userId, responded_at: now })
  const { error } = await db.from('fund_connections').update(patch).eq('id', c.id)
  if (error) throw error
  await logEvent(db, c.id, opts.fundId, opts.userId, status, { pairs_removed: count ?? 0 })
}

async function investorsOf(db: Db, fundId: string): Promise<MatchableInvestor[]> {
  const { data, error } = await db.from('lp_investors').select('id, name, contact_email').eq('fund_id', fundId).order('name')
  if (error) throw error
  return (data ?? []) as MatchableInvestor[]
}

async function activeConnection(db: Db, fundId: string, connectionId: string) {
  const loaded = await loadConnection(db, fundId, connectionId)
  if (loaded.c.status !== 'active') throw new ConnectionError('This connection is not active.', 409)
  return loaded
}

interface LinkRow {
  id: string
  requester_investor_id: string
  recipient_investor_id: string
  requester_approved_at: string | null
  recipient_approved_at: string | null
}

async function linksOf(db: Db, connectionId: string): Promise<LinkRow[]> {
  const { data, error } = await db.from('lp_investor_links')
    .select('id, requester_investor_id, recipient_investor_id, requester_approved_at, recipient_approved_at')
    .eq('connection_id', connectionId)
  if (error) throw error
  return (data ?? []) as LinkRow[]
}

/** The pairs on a connection, and the suggested ones not yet proposed, from the caller's side. */
export async function connectionPairs(db: Db, opts: { fundId: string; connectionId: string }): Promise<{
  pairs: PairView[]
  suggestions: Suggestion[]
  /** Our own investors not yet in a pair, to pair by hand. */
  unpaired: { id: string; name: string }[]
}> {
  const { c, side, otherFundId } = await activeConnection(db, opts.fundId, opts.connectionId)
  const [ours, theirs, links] = await Promise.all([investorsOf(db, opts.fundId), investorsOf(db, otherFundId), linksOf(db, c.id)])
  const name = (list: MatchableInvestor[], id: string) => ({ id, name: list.find(i => i.id === id)?.name ?? 'Unknown investor' })

  const pairs = links.map(l => {
    const ourId = side === 'requester' ? l.requester_investor_id : l.recipient_investor_id
    const theirId = side === 'requester' ? l.recipient_investor_id : l.requester_investor_id
    const ourApproval = !!(side === 'requester' ? l.requester_approved_at : l.recipient_approved_at)
    const theirApproval = !!(side === 'requester' ? l.recipient_approved_at : l.requester_approved_at)
    return { id: l.id, ours: name(ours, ourId), theirs: name(theirs, theirId), ourApproval, theirApproval, approved: ourApproval && theirApproval }
  }).sort((a, b) => a.ours.name.localeCompare(b.ours.name))

  const paired = new Set(links.flatMap(l => [l.requester_investor_id, l.recipient_investor_id]))
  // Only the id and name of a suggested investor of theirs; never their contact details.
  const suggestions = suggestPairs(ours, theirs, paired).map(s => ({
    ours: { id: s.ours.id, name: s.ours.name },
    theirs: { id: s.theirs.id, name: s.theirs.name },
    reason: s.reason,
  }))
  const unpaired = ours.filter(i => !paired.has(i.id)).map(i => ({ id: i.id, name: i.name }))
  return { pairs, suggestions, unpaired }
}

export interface PairRequest {
  ourInvestorId: string
  /** Their investor, by id: one that is suggested for ours, or already paired with it. */
  theirInvestorId?: string
  /** Or by hand: their investor's exact name or contact email. */
  theirMatch?: string
}

/**
 * Propose pairs, or approve the ones the other fund proposed. Each pair is approved for the
 * caller's side only; it carries positions once the other side has approved it too.
 * Returns how many pairs changed, and the requests that could not be applied, with why.
 */
export async function approvePairs(db: Db, opts: { fundId: string; userId: string; connectionId: string; requests: PairRequest[] }) {
  const { c, side, otherFundId } = await activeConnection(db, opts.fundId, opts.connectionId)
  const [ours, theirs, links] = await Promise.all([investorsOf(db, opts.fundId), investorsOf(db, otherFundId), linksOf(db, c.id)])
  const ourCol = side === 'requester' ? 'requester_investor_id' : 'recipient_investor_id'
  const theirCol = side === 'requester' ? 'recipient_investor_id' : 'requester_investor_id'
  const approvalCols = side === 'requester'
    ? { requester_approved_by: opts.userId, requester_approved_at: new Date().toISOString() }
    : { recipient_approved_by: opts.userId, recipient_approved_at: new Date().toISOString() }
  const paired = new Set(links.flatMap(l => [l.requester_investor_id, l.recipient_investor_id]))
  const suggested = new Map(suggestPairs(ours, theirs, paired).map(s => [s.ours.id, s.theirs.id]))

  let changed = 0
  const skipped: { ourInvestorId: string; reason: string }[] = []
  for (const r of opts.requests) {
    if (!ours.some(i => i.id === r.ourInvestorId)) { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'Not an investor of this fund.' }); continue }
    const existing = links.find(l => (l as any)[ourCol] === r.ourInvestorId)
    const theirId = r.theirInvestorId
      ?? (r.theirMatch ? findExact(theirs, r.theirMatch)?.id : undefined)
      ?? (existing ? (existing as any)[theirCol] : undefined)
    if (!theirId) { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'No single investor of the other fund has that exact name or email.' }); continue }

    if (existing) {
      if ((existing as any)[theirCol] !== theirId) { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'Already paired with a different investor. Remove that pair first.' }); continue }
      const { error } = await db.from('lp_investor_links').update(approvalCols).eq('id', existing.id)
      if (error) throw error
      await logEvent(db, c.id, opts.fundId, opts.userId, 'pair_approved', { link_id: existing.id })
      changed++
      continue
    }

    // A new pair. Their investor must be one we were shown (a suggestion) or named exactly; an id
    // we were never shown is refused, so the other fund's list cannot be walked by guessing ids.
    const allowed = suggested.get(r.ourInvestorId) === theirId || (!!r.theirMatch && findExact(theirs, r.theirMatch)?.id === theirId)
    if (!allowed) { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'That investor is not one suggested for this LP.' }); continue }
    if (links.some(l => (l as any)[theirCol] === theirId)) { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'The other fund already paired that investor with someone else.' }); continue }

    const { data: row, error } = await db.from('lp_investor_links')
      .insert({ connection_id: c.id, [ourCol]: r.ourInvestorId, [theirCol]: theirId, ...approvalCols })
      .select('id, requester_investor_id, recipient_investor_id, requester_approved_at, recipient_approved_at').single()
    if (error?.code === '23505') { skipped.push({ ourInvestorId: r.ourInvestorId, reason: 'One of these investors was just paired.' }); continue }
    if (error) throw error
    links.push(row as LinkRow)
    await logEvent(db, c.id, opts.fundId, opts.userId, 'pair_proposed', { link_id: row.id })
    changed++
  }
  return { changed, skipped }
}

/** Remove a pair (either side may, whoever proposed it). */
export async function removePair(db: Db, opts: { fundId: string; userId: string; connectionId: string; linkId: string }) {
  const { c } = await loadConnection(db, opts.fundId, opts.connectionId)
  const { data, error } = await db.from('lp_investor_links').delete().eq('id', opts.linkId).eq('connection_id', c.id).select('id')
  if (error) throw error
  if (!((data ?? []) as unknown[]).length) throw new ConnectionError('No such pair.', 404)
  await logEvent(db, c.id, opts.fundId, opts.userId, 'pair_removed', { link_id: opts.linkId })
}

export interface Counterpart {
  /** Our investor. */
  investorId: string
  linkedFundId: string
  linkedInvestorId: string
}

/** Our investors' counterparts in other funds, through approved pairs on active connections only. */
export async function approvedCounterparts(db: Db, fundId: string, investorIds?: string[]): Promise<Counterpart[]> {
  let rows: ConnectionRow[]
  try {
    rows = await connectionsOf(db, fundId, ['active'])
  } catch {
    // Before the migration is pushed the table does not exist: no connections, not an error.
    return []
  }
  if (rows.length === 0) return []
  const { data: links } = await db.from('lp_investor_links')
    .select('connection_id, requester_investor_id, recipient_investor_id, requester_approved_at, recipient_approved_at')
    .in('connection_id', rows.map(c => c.id))
  const wanted = investorIds ? new Set(investorIds) : null
  const out: Counterpart[] = []
  for (const l of ((links ?? []) as any[]).filter(isApproved)) {
    const c = rows.find(r => r.id === l.connection_id)!
    const weRequested = c.requester_fund_id === fundId
    const investorId = weRequested ? l.requester_investor_id : l.recipient_investor_id
    if (wanted && !wanted.has(investorId)) continue
    out.push({
      investorId,
      linkedFundId: weRequested ? c.recipient_fund_id : c.requester_fund_id,
      linkedInvestorId: weRequested ? l.recipient_investor_id : l.requester_investor_id,
    })
  }
  return out
}

export interface LinkedRow {
  /** Our investor the row belongs to on our report card. */
  investorId: string
  fundId: string
  fundName: string
  entityName: string
  row: LiveInvestmentRow
}

/**
 * The positions our investors hold in connected funds, from those funds' live reports, through
 * approved pairs only. `omitCarryRecipients`: leave out positions on which the LP receives carry in
 * that fund, for a caller who may not see individual carry (lib/access/carry-visibility.ts).
 */
export async function linkedLiveRows(
  db: Db,
  opts: { fundId: string; investorIds?: string[]; asOf?: string; omitCarryRecipients?: boolean },
): Promise<{ rows: LinkedRow[]; vehicleDates: { vehicle: string; date: string | null }[] }> {
  const counterparts = await approvedCounterparts(db, opts.fundId, opts.investorIds)
  if (counterparts.length === 0) return { rows: [], vehicleDates: [] }

  const byFund = new Map<string, Counterpart[]>()
  for (const cp of counterparts) byFund.set(cp.linkedFundId, [...(byFund.get(cp.linkedFundId) ?? []), cp])

  const rows: LinkedRow[] = []
  const vehicleDates: { vehicle: string; date: string | null }[] = []
  for (const [otherFundId, cps] of byFund) {
    const ourOf = new Map(cps.map(cp => [cp.linkedInvestorId, cp.investorId]))
    const [report, { data: fund }, { data: ents }] = await Promise.all([
      generateLiveReport(db, otherFundId, opts.asOf),
      db.from('funds').select('name').eq('id', otherFundId).maybeSingle(),
      db.from('lp_entities').select('id, entity_name, investor_id').eq('fund_id', otherFundId).in('investor_id', Array.from(ourOf.keys())),
    ])
    const entInfo = new Map(((ents ?? []) as any[]).map(e => [e.id as string, e as { entity_name: string; investor_id: string }]))
    let mine = report.rows.filter(r => entInfo.has(r.entity_id))
    if (opts.omitCarryRecipients) {
      const groups = Array.from(new Set(mine.map(r => r.portfolio_group)))
      const recipients = new Map(await Promise.all(groups.map(async g => [g, await carryRecipientIds(db, otherFundId, g)] as const)))
      mine = mine.filter(r => !recipients.get(r.portfolio_group)?.has(r.entity_id))
    }
    const fundName = (fund as any)?.name ?? 'Connected fund'
    for (const r of mine) {
      const e = entInfo.get(r.entity_id)!
      rows.push({ investorId: ourOf.get(e.investor_id)!, fundId: otherFundId, fundName, entityName: e.entity_name, row: r })
    }
    const groups = Array.from(new Set(mine.map(r => r.portfolio_group)))
    const dates = await lastDataDates(db, otherFundId, groups)
    for (const g of groups.sort()) vehicleDates.push({ vehicle: g, date: dates.get(g) ?? null })
  }
  return { rows, vehicleDates }
}
