// Handlers for the LP REPORTING agent tools. Read-only.
//
// Import note: this deliberately imports `listVehicles` from lib/accounting/load rather
// than `resolveVehicle` from lib/accounting/agent-tools. The registry in agent-tools.ts
// imports THIS file, so reaching back into it for a value (not just a type) would close an
// import cycle. The local resolver below is a few lines and keeps the graph acyclic.
//
// Authorization note: every lib called here (`generateLiveReport`, `lpStatement`,
// `lpCapitalSummary`) takes a service-role client and does ZERO access checking — the
// caller is the security boundary. That is fine here precisely because the agent endpoints
// resolve `fundId` from the API key and never from tool input, so a tool cannot be pointed
// at another fund's LPs. Every query below is still explicitly scoped to `fundId` anyway.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { listVehicles } from '@/lib/accounting/load'
import { resolveVehicle as resolveSharedVehicle } from '@/lib/accounting/vehicle-resolver'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { scopeLiveReport, visibleLpEntityIds } from '@/lib/access/lp-scope'
import { scopeCompanyRows } from '@/lib/access/scope'
import { generateLiveReport, type LiveInvestmentRow } from '@/lib/accounting/live-report'
import { lpCapitalSummary, lpStatement, listCapitalCalls } from '@/lib/accounting/capital-calls'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { CarryRecipientStatementError, carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { siteOrigin } from '@/lib/site-links'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const STATEMENT_PRESETS: PeriodPreset[] = ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd']

/**
 * Validate a vehicle name against the registry — never pass a caller's string through raw — and
 * against the caller's entities: a name they cannot see is unknown.
 */
async function resolveVehicle(admin: SupabaseClient, fundId: string, requested: string, access: AccessContext): Promise<string> {
  return resolveSharedVehicle(admin, fundId, requested || undefined, { access })
}

/**
 * The caller's entities, for tools that read across them: their names (rows are keyed by
 * portfolio_group) and the LP entities visible through them. Null = every entity.
 */
async function lpToolScope(admin: SupabaseClient, access: AccessContext): Promise<{ names: string[] | null; entityIds: string[] | null }> {
  const scope = await entityScopeFor(admin, access)
  return { names: scope.vehicleNames, entityIds: await visibleLpEntityIds(admin, scope) }
}

interface EntityIdentity {
  entityId: string
  entityName: string
  investorId: string | null
  investorName: string | null
}

/**
 * Every LP entity with the investor it rolls up to.
 *
 * Positions are keyed on ENTITIES (`lp_investments.entity_id`), never on investors — one
 * investor can hold through several entities. Any roll-up must therefore sum at the
 * investor level and compute the ratios AFTER summing; averaging per-entity DPI/TVPI is
 * wrong and is the convention every existing read path avoids.
 */
async function loadIdentities(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's visible LP entities (null = all): every name lookup and list starts here. */
  visibleEntityIds: string[] | null,
): Promise<Map<string, EntityIdentity>> {
  const { data } = await (admin as any)
    .from('lp_entities')
    .select('id, entity_name, investor_id, lp_investors(id, name)')
    .eq('fund_id', fundId)
  const out = new Map<string, EntityIdentity>()
  for (const e of ((data as any[]) ?? [])) {
    if (visibleEntityIds !== null && !visibleEntityIds.includes(e.id)) continue
    const inv = Array.isArray(e.lp_investors) ? e.lp_investors[0] : e.lp_investors
    out.set(e.id, {
      entityId: e.id,
      entityName: e.entity_name,
      investorId: e.investor_id ?? null,
      investorName: inv?.name ?? null,
    })
  }
  return out
}

/** Resolve an LP by entity id, entity name, or investor name. There is no alias table for LPs. */
function resolveLp(identities: Map<string, EntityIdentity>, ref: string): EntityIdentity[] {
  if (identities.has(ref)) return [identities.get(ref)!]
  const needle = ref.trim().toLowerCase()
  const all = Array.from(identities.values())

  const exact = all.filter(i =>
    i.entityName.trim().toLowerCase() === needle ||
    (i.investorName ?? '').trim().toLowerCase() === needle
  )
  if (exact.length > 0) return exact   // an investor legitimately maps to several entities

  const near = all.filter(i =>
    i.entityName.toLowerCase().includes(needle) ||
    (i.investorName ?? '').toLowerCase().includes(needle)
  )
  if (near.length > 0) return near
  throw new Error(`No LP matching "${ref}" in this fund.`)
}

/** A snapshot by id or name; omitted = the most recent by as_of_date. */
async function resolveSnapshot(admin: SupabaseClient, fundId: string, ref?: string): Promise<any> {
  const { data } = await (admin as any)
    .from('lp_snapshots').select('id, name, as_of_date, created_at').eq('fund_id', fundId)
  const rows = ((data as any[]) ?? [])
  if (rows.length === 0) throw new Error('This fund has no LP snapshots.')

  if (!ref) {
    return rows.slice().sort((a, b) =>
      String(b.as_of_date ?? b.created_at).localeCompare(String(a.as_of_date ?? a.created_at))
    )[0]
  }
  const hit = rows.find(s => s.id === ref)
    ?? rows.find(s => String(s.name).trim().toLowerCase() === ref.trim().toLowerCase())
  if (hit) return hit
  throw new Error(`No snapshot "${ref}". This fund has: ${rows.map(s => s.name).join(', ')}`)
}

const metrics = (r: any) => ({
  commitment: Number(r.commitment ?? 0),
  called_capital: Number(r.called_capital ?? 0),
  paid_in_capital: Number(r.paid_in_capital ?? 0),
  distributions: Number(r.distributions ?? 0),
  nav: Number(r.nav ?? 0),
  total_value: Number(r.total_value ?? 0),
  outstanding_balance: Number(r.outstanding_balance ?? 0),
  dpi: r.dpi === null || r.dpi === undefined ? null : Number(r.dpi),
  rvpi: r.rvpi === null || r.rvpi === undefined ? null : Number(r.rvpi),
  tvpi: r.tvpi === null || r.tvpi === undefined ? null : Number(r.tvpi),
  irr: r.irr === null || r.irr === undefined ? null : Number(r.irr),
})

/** Narrow a row set to one LP / one vehicle, when the caller asked for that. */
function applyFilters<T extends { entity_id?: string; portfolio_group?: string }>(
  rows: T[],
  opts: { entityIds?: Set<string>; vehicle?: string; visibleNames: string[] | null }
): T[] {
  // The caller's entities only, whatever else was asked.
  let out = opts.visibleNames === null ? rows : rows.filter(r => !!r.portfolio_group && opts.visibleNames!.includes(r.portfolio_group))
  if (opts.entityIds) out = out.filter(r => r.entity_id && opts.entityIds!.has(r.entity_id))
  if (opts.vehicle) out = out.filter(r => r.portfolio_group === opts.vehicle)
  return out
}

/**
 * An LP's carried-interest line is the fund's carry and is shown with their statement. A carry
 * RECIPIENT's statement is what they earn — GP economics — and is refused without that grant
 * (lib/access/carry-visibility.ts).
 */
async function refuseRecipientStatement(admin: SupabaseClient, fundId: string, vehicle: string, lp: EntityIdentity, access: AccessContext) {
  if (seesIndividualCarry(access)) return
  if ((await carryRecipientIds(admin, fundId, vehicle)).has(lp.entityId)) throw new CarryRecipientStatementError(lp.entityName)
}

export const LP_HANDLERS: Record<string, AgentToolHandler> = {
  lp_list_snapshots: async ({ admin, fundId, access }: AgentToolContext) => {
    const { data } = await (admin as any)
      .from('lp_snapshots').select('id, name, as_of_date, created_at').eq('fund_id', fundId)
    return ((data as any[]) ?? [])
      .slice()
      .sort((a, b) => String(b.as_of_date ?? b.created_at).localeCompare(String(a.as_of_date ?? a.created_at)))
      .map(s => ({ id: s.id, name: s.name, as_of: s.as_of_date, created_at: s.created_at }))
  },

  lp_list_investors: async ({ admin, fundId, access }: AgentToolContext) => {
    const lp = await lpToolScope(admin, access)
    const identities = await loadIdentities(admin, fundId, lp.entityIds)
    const byInvestor = new Map<string, { investor: string; entities: string[] }>()
    for (const i of Array.from(identities.values())) {
      const key = i.investorName ?? i.entityName
      if (!byInvestor.has(key)) byInvestor.set(key, { investor: key, entities: [] })
      byInvestor.get(key)!.entities.push(i.entityName)
    }
    return {
      note: 'Positions are keyed on entities. Roll up by summing at the investor level, then compute ratios — never average per-entity ratios.',
      investors: Array.from(byInvestor.values()).sort((a, b) => a.investor.localeCompare(b.investor)),
    }
  },

  lp_snapshot: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const snapshot = await resolveSnapshot(admin, fundId, input?.snapshot ? String(input.snapshot) : undefined)
    const lp = await lpToolScope(admin, access)
    const identities = await loadIdentities(admin, fundId, lp.entityIds)

    const { data } = await (admin as any)
      .from('lp_investments').select('*').eq('fund_id', fundId).eq('snapshot_id', snapshot.id)

    let rows = ((data as any[]) ?? [])
    const entityIds = input?.lp
      ? new Set(resolveLp(identities, String(input.lp)).map(i => i.entityId))
      : undefined
    const vehicle = input?.vehicle ? await resolveVehicle(admin, fundId, String(input.vehicle), access) : undefined
    rows = applyFilters(rows, { entityIds, vehicle, visibleNames: lp.names })

    return {
      source: 'snapshot',
      snapshot: { id: snapshot.id, name: snapshot.name, as_of: snapshot.as_of_date },
      rows: rows.map(r => {
        const id = identities.get(r.entity_id)
        return {
          investor: id?.investorName ?? null,
          entity: id?.entityName ?? r.entity_id,
          vehicle: r.portfolio_group,
          ...metrics(r),
        }
      }),
    }
  },

  lp_live_report: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const asOf = input?.as_of ? String(input.as_of) : undefined
    if (asOf && !ISO_DATE.test(asOf)) throw new Error('as_of must be an ISO date (YYYY-MM-DD)')

    const lp = await lpToolScope(admin, access)
    const report = scopeLiveReport(await generateLiveReport(admin, fundId, asOf), lp.names)
    const identities = await loadIdentities(admin, fundId, lp.entityIds)

    let rows: LiveInvestmentRow[] = report.rows
    const entityIds = input?.lp
      ? new Set(resolveLp(identities, String(input.lp)).map(i => i.entityId))
      : undefined
    const vehicle = input?.vehicle ? await resolveVehicle(admin, fundId, String(input.vehicle), access) : undefined
    rows = applyFilters(rows, { entityIds, vehicle, visibleNames: lp.names })

    return {
      source: 'live',
      as_of: report.asOf,
      // Which producer answered per vehicle — a vehicle with no double-entry books is
      // served from lp_capital_events instead, and that provenance matters when the
      // numbers are questioned.
      vehicles: report.vehicles.map(v => ({ vehicle: v.group, source: v.source, lps: v.lps })),
      rows: rows.map(r => {
        const id = identities.get(r.entity_id)
        return {
          investor: id?.investorName ?? report.entityNames.get(r.entity_id) ?? null,
          entity: id?.entityName ?? report.entityNames.get(r.entity_id) ?? r.entity_id,
          vehicle: r.portfolio_group,
          ...metrics(r),
          ...(r.lookThroughVia ? { look_through_via: r.lookThroughVia } : {}),
        }
      }),
    }
  },

  lp_reconcile_snapshot: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const snapshot = await resolveSnapshot(admin, fundId, input?.snapshot ? String(input.snapshot) : undefined)
    const lp = await lpToolScope(admin, access)
    const identities = await loadIdentities(admin, fundId, lp.entityIds)

    // Derive the books as of the SNAPSHOT's date — comparing a dated snapshot against
    // today's ledger would report every entry booked since as a "break", which it isn't.
    const asOf = snapshot.as_of_date ? String(snapshot.as_of_date) : undefined
    const [fullReport, { data: allStored }] = await Promise.all([
      generateLiveReport(admin, fundId, asOf),
      (admin as any).from('lp_investments').select('*').eq('fund_id', fundId).eq('snapshot_id', snapshot.id),
    ])
    // Both sides cut to the caller's entities.
    const report = scopeLiveReport(fullReport, lp.names)
    const stored = scopeCompanyRows((allStored as any[]) ?? [], lp.names, 'portfolio_group')

    const key = (entityId: string, group: string) => `${entityId}::${group}`
    const liveBy = new Map(report.rows.map(r => [key(r.entity_id, r.portfolio_group), r]))
    const storedBy = new Map(((stored as any[]) ?? []).map(r => [key(r.entity_id, r.portfolio_group), r]))

    const FIELDS = ['commitment', 'called_capital', 'paid_in_capital', 'distributions', 'nav'] as const
    const TOLERANCE = 0.01

    const differing: any[] = []
    const liveOnly: any[] = []
    const storedOnly: any[] = []

    for (const [k, live] of Array.from(liveBy.entries())) {
      const s = storedBy.get(k)
      const id = identities.get(live.entity_id)
      const label = {
        investor: id?.investorName ?? null,
        entity: id?.entityName ?? live.entity_id,
        vehicle: live.portfolio_group,
      }
      if (!s) { liveOnly.push(label); continue }

      const deltas: Record<string, { stored: number; live: number; delta: number }> = {}
      for (const f of FIELDS) {
        const a = Number((s as any)[f] ?? 0)
        const b = Number((live as any)[f] ?? 0)
        if (Math.abs(a - b) > TOLERANCE) {
          deltas[f] = { stored: a, live: b, delta: Math.round((b - a) * 100) / 100 }
        }
      }
      if (Object.keys(deltas).length > 0) differing.push({ ...label, deltas })
    }
    for (const [k, s] of Array.from(storedBy.entries())) {
      if (liveBy.has(k)) continue
      const id = identities.get((s as any).entity_id)
      storedOnly.push({
        investor: id?.investorName ?? null,
        entity: id?.entityName ?? (s as any).entity_id,
        vehicle: (s as any).portfolio_group,
      })
    }

    return {
      snapshot: { id: snapshot.id, name: snapshot.name, as_of: snapshot.as_of_date },
      compared_against: `the ledger as of ${report.asOf ?? 'today'}`,
      summary: {
        stored_rows: storedBy.size,
        live_rows: liveBy.size,
        differing: differing.length,
        live_only: liveOnly.length,
        stored_only: storedOnly.length,
        agrees: differing.length === 0 && liveOnly.length === 0 && storedOnly.length === 0,
      },
      differing,
      live_only: liveOnly,
      stored_only: storedOnly,
    }
  },

  lp_capital_summary: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const rows = await lpCapitalSummary(admin, fundId, vehicle)
    return {
      vehicle,
      rows: rows.map(r => ({
        lp: r.name,
        partner_class: r.partnerClass,
        commitment: r.commitment,
        called: r.called,
        funded: r.funded,
        outstanding: r.outstanding,   // remaining to be called (commitment - called)
        receivable: r.receivable,     // called but not yet funded
        ending_balance: r.ending,
      })),
    }
  },

  lp_capital_calls: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const today = new Date().toISOString().slice(0, 10)
    const calls = await listCapitalCalls(admin, fundId, vehicle, today)
    return {
      vehicle,
      calls: calls.map(c => ({
        id: c.id,
        number: c.callNumber,
        date: c.callDate,
        due_date: c.dueDate,
        description: c.description,
        scope: c.scope,
        total: c.total,
        status: c.status,          // open | partial | settled, from the ledger (oldest call first)
        overdue: c.overdue,
        funded: c.settled,
        outstanding: c.outstanding,
        lines: c.lines.map(l => ({
          lp: l.name, amount: l.amount, funded: l.settled, outstanding: l.outstanding, status: l.status, funded_on: l.settledOn,
          overdue: l.outstanding > 0 && !!c.dueDate && c.dueDate < today,
          // The LP's own word from the portal. Not money received: until a payment is matched or
          // recorded the line stays outstanding, but "says wired" is a different conversation.
          says_wired: l.ack && l.outstanding > 0 ? { on: l.ack.wiredOn, reference: l.ack.reference } : null,
        })),
      })),
    }
  },

  lp_statement: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const lpScope = await lpToolScope(admin, access)
    const identities = await loadIdentities(admin, fundId, lpScope.entityIds)
    const matches = resolveLp(identities, String(input?.lp ?? ''))
    if (matches.length > 1) {
      throw new Error(
        `"${input.lp}" resolves to ${matches.length} entities (${matches.map(m => m.entityName).join(', ')}). ` +
        'A statement is per entity — pass one.'
      )
    }
    const lp = matches[0]
    await refuseRecipientStatement(admin, fundId, vehicle, lp, access)

    const start = input?.start ? String(input.start) : null
    const end = input?.end ? String(input.end) : null
    for (const [label, v] of [['start', start], ['end', end]] as const) {
      if (v && !ISO_DATE.test(v)) throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`)
    }

    const result = await lpStatement(
      admin, fundId, vehicle, lp.entityId,
      start || end ? { start, end } : undefined
    )
    // Returns a union, not a throw.
    if ('error' in result) throw new Error(result.error)

    return {
      vehicle,
      investor: lp.investorName,
      entity: lp.entityName,
      period: start || end ? { start, end } : 'since inception',
      position: {
        commitment: result.row.commitment,
        called: result.row.called,
        funded: result.row.funded,
        outstanding: result.row.outstanding,
        receivable: result.row.receivable,
        ending_balance: result.row.ending,
      },
      // Includes the carried-interest line: the carry this LP is charged, which is the fund's carry.
      // A recipient's statement — what they earn — was refused above without gp_economics.
      roll_forward_itd: result.rollForward,
      roll_forward_period: result.periodRollForward,
      transactions: result.transactions.map(t => ({
        date: t.date,
        memo: t.memo,
        type: t.sourceType,
        amount: t.amount,     // signed change to LP capital
        balance: t.balance,
      })),
    }
  },

  // The documents. Each returns a signed link, not the PDF: the document is rendered when the link
  // is opened, after the member's access is checked again (app/api/agent/reports/[token]). So these
  // only resolve and validate what to render, with the same scoping as the figures above.
  lp_statement_pdf: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const lpScope = await lpToolScope(admin, access)
    const matches = resolveLp(await loadIdentities(admin, fundId, lpScope.entityIds), String(input?.lp ?? ''))
    if (matches.length > 1) {
      throw new Error(
        `"${input.lp}" resolves to ${matches.length} entities (${matches.map(m => m.entityName).join(', ')}). ` +
        'A statement is per entity — pass one.'
      )
    }
    const lp = matches[0]
    await refuseRecipientStatement(admin, fundId, vehicle, lp, access)
    const start = input?.start ? String(input.start) : null
    const end = input?.end ? String(input.end) : null
    for (const [label, v] of [['start', start], ['end', end]] as const) {
      if (v && !ISO_DATE.test(v)) throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`)
    }
    const preset = (input?.period ? String(input.period) : 'last_quarter') as PeriodPreset
    if (!start && !end && !STATEMENT_PRESETS.includes(preset)) throw new Error(`period must be one of ${STATEMENT_PRESETS.join(', ')}`)
    const period = start || end ? customPeriod(start, end) : resolvePeriod(preset)

    // Fail here, in the conversation, rather than on a link that 404s later.
    const check = await lpStatement(admin, fundId, vehicle, lp.entityId, { start: period.start, end: period.end })
    if ('error' in check) throw new Error(check.error)

    const { token, expiresAt } = signReportLink({
      fundId, userId, kind: 'lp_statement',
      args: { vehicle, lp: lp.entityId, start: period.start, end: period.end, label: period.label },
    })
    return {
      document: 'Capital account statement (PDF)',
      vehicle, investor: lp.investorName, entity: lp.entityName, period: period.label,
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: 'Give the user this link. It opens the PDF for an hour, and only for this member.',
    }
  },

  lp_report_card_pdf: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const lpScope = await lpToolScope(admin, access)
    const matches = resolveLp(await loadIdentities(admin, fundId, lpScope.entityIds), String(input?.investor ?? ''))
    const investors = new Map<string, string>()
    for (const m of matches) if (m.investorId) investors.set(m.investorId, m.investorName ?? m.entityName)
    if (investors.size === 0) throw new Error(`"${input?.investor}" has no investor record to report on.`)
    if (investors.size > 1) {
      throw new Error(`"${input.investor}" matches ${investors.size} investors (${[...investors.values()].join(', ')}). Pass one.`)
    }
    const [[investorId, investorName]] = [...investors]

    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'lp_report_card', args: { investor: investorId } })
    return {
      document: 'LP report card (PDF)',
      investor: investorName,
      // A member who sees only some entities gets a report card of only those.
      vehicles: lpScope.names ?? 'all',
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: 'Give the user this link. It opens the PDF for an hour, and only for this member.',
    }
  },
}
