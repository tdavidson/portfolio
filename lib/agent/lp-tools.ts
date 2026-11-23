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
import { fetchAllRows, listVehicles } from '@/lib/accounting/load'
import { currentLiveReport } from '@/lib/accounting/live-report-cache'
import { resolveVehicle as resolveSharedVehicle } from '@/lib/accounting/vehicle-resolver'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { scopeLiveReport, visibleLpEntityIds } from '@/lib/access/lp-scope'
import { scopeCompanyRows } from '@/lib/access/scope'
import { generateLiveReport, type LiveInvestmentRow } from '@/lib/accounting/live-report'
import { lpCapitalSummary, lpStatement, listCapitalCalls } from '@/lib/accounting/capital-calls'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { BASIS_LABELS, BASIS_NOTES } from '@/lib/accounting/statement-basis'
import { resolveStatementBasis } from '@/lib/accounting/statement-basis-default'
import { statementColumns } from '@/lib/accounting/capital-statement-layout'
import { linkNote, reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { COMBINED_RECIPIENTS_ID, CarryRecipientStatementError, carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { siteOrigin } from '@/lib/site-links'
import { reviewCallNotices } from '@/lib/accounting/call-notice-review'
import { unwrap } from '@/lib/service-outcome'
import { investorGroups, type InvestorRecord } from '@/lib/lps/investor-groups'
import { listDistributions, signOffDistribution } from '@/lib/accounting/distributions'
import { previewWithChecks } from '@/lib/accounting/distribution-review'
import { foldDeclaredCarry, foldFlags, foldNoticePartners, foldPreviewCarry, recipientsToHide } from '@/lib/accounting/distribution-carry-fold'
import { recordAudit } from '@/lib/audit/events'
import { loadWireSummaries } from '@/lib/lps/wire-instructions'
import { normalizeNoticeEmail, reviewDistributionNotices } from '@/lib/accounting/distribution-notice-review'
import { adminOnlyDenial, HANDLER_CHECKED } from '@/lib/access/admin-only'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

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
export async function lpToolScope(admin: SupabaseClient, access: AccessContext): Promise<{ names: string[] | null; entityIds: string[] | null }> {
  const scope = await entityScopeFor(admin, access)
  return { names: scope.vehicleNames, entityIds: await visibleLpEntityIds(admin, scope) }
}

export interface EntityIdentity {
  entityId: string
  entityName: string
  investorId: string | null
  investorName: string | null
  /** The investor's second name (a person behind an entity, a trust's family), for search. */
  alternateName?: string | null
  /** The investor this one rolls up to on the report (lp_investors.parent_id, followed to the
   *  top; itself when ungrouped). Report cards are one per group. */
  groupId?: string | null
  groupName?: string | null
}

/**
 * Every LP entity with the investor it rolls up to.
 *
 * Positions are keyed on ENTITIES (`lp_investments.entity_id`), never on investors — one
 * investor can hold through several entities. Any roll-up must therefore sum at the
 * investor level and compute the ratios AFTER summing; averaging per-entity DPI/TVPI is
 * wrong and is the convention every existing read path avoids.
 */
export async function loadIdentities(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's visible LP entities (null = all): every name lookup and list starts here. */
  visibleEntityIds: string[] | null,
): Promise<Map<string, EntityIdentity>> {
  // Paged: past PostgREST's 1000-row cap the remaining LPs would silently drop out of every LP tool.
  const [data, investors] = await Promise.all([
    fetchAllRows<any>((f, t) => (admin as any)
      .from('lp_entities')
      .select('id, entity_name, investor_id, lp_investors(id, name)')
      .eq('fund_id', fundId)
      .order('id')
      .range(f, t)),
    fetchAllRows<InvestorRecord>((f, t) => (admin as any)
      .from('lp_investors')
      .select('id, name, parent_id, alternate_name')
      .eq('fund_id', fundId)
      .order('id')
      .range(f, t)),
  ])
  const groups = investorGroups(investors)
  const byId = new Map(investors.map(i => [i.id, i]))
  const out = new Map<string, EntityIdentity>()
  for (const e of data) {
    if (visibleEntityIds !== null && !visibleEntityIds.includes(e.id)) continue
    const inv = Array.isArray(e.lp_investors) ? e.lp_investors[0] : e.lp_investors
    const investorId: string | null = e.investor_id ?? null
    const investorName: string | null = inv?.name ?? null
    const groupId = investorId ? groups.topOf(investorId) : null
    out.set(e.id, {
      entityId: e.id,
      entityName: e.entity_name,
      investorId,
      investorName,
      alternateName: investorId ? byId.get(investorId)?.alternate_name ?? null : null,
      groupId,
      groupName: groupId ? groups.nameOf(groupId) ?? investorName : null,
    })
  }
  return out
}

/**
 * Resolve an LP by entity id, entity name, investor name, the investor's alternate name, or the
 * name of the group it rolls up to (which gives every entity in the group).
 */
export function resolveLp(identities: Map<string, EntityIdentity>, ref: string): EntityIdentity[] {
  if (identities.has(ref)) return [identities.get(ref)!]
  const needle = ref.trim().toLowerCase()
  const all = Array.from(identities.values())
  const names = (i: EntityIdentity) => [i.entityName, i.investorName, i.alternateName, i.groupName]
    .filter((n): n is string => !!n).map(n => n.trim().toLowerCase())

  const exact = all.filter(i => names(i).some(n => n === needle))
  if (exact.length > 0) return exact   // an investor legitimately maps to several entities

  const near = all.filter(i => names(i).some(n => n.includes(needle)))
  if (near.length > 0) return near
  throw new Error(`No LP matching "${ref}" in this fund.`)
}

/** The report-card groups among some matches: group id → the name its card prints. */
export function cardGroupsOf(matches: EntityIdentity[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of matches) {
    const id = m.groupId ?? m.investorId
    if (id) out.set(id, m.groupName ?? m.investorName ?? m.entityName)
  }
  return out
}

/** A snapshot by id or name; omitted = the most recent by as_of_date. */
export async function resolveSnapshot(admin: SupabaseClient, fundId: string, ref?: string): Promise<any> {
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

/** The group an investor rolls up to, on a row, when it is not the investor itself. */
const groupField = (id: EntityIdentity | undefined) =>
  (id?.groupName && id.groupName !== id.investorName ? { group: id.groupName } : {})

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
    // One line per GROUP, as the LPs page and the report cards roll them up: an investor grouped
    // under a parent is listed under it, by its own name, with its entities.
    const byGroup = new Map<string, { investor: string; also_known_as: Set<string>; grouped: Set<string>; entities: string[] }>()
    for (const i of Array.from(identities.values())) {
      const key = i.groupName ?? i.investorName ?? i.entityName
      if (!byGroup.has(key)) byGroup.set(key, { investor: key, also_known_as: new Set(), grouped: new Set(), entities: [] })
      const g = byGroup.get(key)!
      if (i.alternateName) g.also_known_as.add(i.alternateName)
      if (i.investorName && i.investorName !== key) g.grouped.add(i.investorName)
      g.entities.push(i.entityName)
    }
    return {
      note: 'Positions are keyed on entities. Roll up by summing at the investor level, then compute ratios — never average per-entity ratios. ' +
        '`grouped_investors` are investors rolled up under this one on the report; they share its report card.',
      investors: Array.from(byGroup.values())
        .map(g => ({
          investor: g.investor,
          ...(g.also_known_as.size ? { also_known_as: [...g.also_known_as].sort() } : {}),
          ...(g.grouped.size ? { grouped_investors: [...g.grouped].sort() } : {}),
          entities: g.entities,
        }))
        .sort((a, b) => a.investor.localeCompare(b.investor)),
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
          ...groupField(id),
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
    const report = scopeLiveReport(asOf ? await generateLiveReport(admin, fundId, asOf) : await currentLiveReport(admin, fundId), lp.names)
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
          ...groupField(id),
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

  // The distribution register, as the Capital accounts page lists it: each partner's capital line
  // and carry line apart, with the stored return of capital / preferred / profit and the sign-off.
  list_distributions: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    // Without gp_economics the carry recipients are one combined row (what each receives is GP economics).
    const hide = await recipientsToHide(admin, fundId, vehicle, access)
    const rows = (await listDistributions(admin, fundId, vehicle)).map(d => (hide ? foldDeclaredCarry(d, hide) : d))
    return {
      vehicle,
      distributions: rows.map(d => ({
        id: d.distributionId,
        date: d.date,
        description: d.description,
        total: d.total,
        lp_total: d.lpTotal,
        carry_total: d.carryTotal,
        split_method: d.splitMethod,
        tiers: d.tiers,
        character: d.characterised ? d.character : null,
        status: d.status,
        paid: d.settled,
        unpaid: d.outstanding,
        signed_off: d.signOff ? { by: d.signOff.by, at: d.signOff.at, note: d.signOff.note } : null,
        lines: d.lines.map(l => ({
          partner: l.name,
          line: l.role === 'carry' ? 'carried interest' : 'distribution on capital',
          amount: l.amount,
          ...(l.breakdown ? { return_of_capital: l.breakdown.returnOfCapital, preferred_return: l.breakdown.preferred, profit: l.breakdown.profit } : {}),
          deductions: l.deductions?.length ? l.deductions : undefined,
          paid: l.settled,
          unpaid: l.outstanding,
          status: l.status,
          paid_on: l.settledOn,
          notice_published: !!l.noticeDocumentId,
        })),
      })),
    }
  },

  // The split a distribution would get, with the checks and a workbook link. Writes nothing.
  preview_distribution: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const total = Math.round(Number(input?.total) * 100) / 100
    if (!Number.isFinite(total) || total <= 0) throw new Error('total must be a positive amount.')
    const asOf = input?.asOf ? String(input.asOf) : new Date().toISOString().slice(0, 10)
    if (!ISO_DATE.test(asOf)) throw new Error('asOf must be YYYY-MM-DD.')
    const method = input?.method === 'pro_rata' ? 'pro_rata' as const : 'waterfall' as const
    const hide = await recipientsToHide(admin, fundId, vehicle, access)
    const raw = await previewWithChecks(admin, fundId, vehicle, total, asOf, method)
    const p = hide ? foldPreviewCarry(raw, hide) : raw
    const name = (id: string) => p.names[id] ?? id
    const breakdown = new Map(p.lineBreakdown.map(b => [b.lpEntityId, b]))
    const workbook = userId
      ? reportLinkUrl(origin ?? siteOrigin(), signReportLink({ fundId, userId, kind: 'distribution_workbook', args: { vehicle, total: String(total), as_of: asOf, method } }).token)
      : null
    const blocked = p.checks.flags.some(f => f.severity === 'blocker') || p.checks.missing.some(m => m.required)
    return {
      vehicle, total, as_of: asOf, method: p.method,
      lines: p.lines.map(l => {
        const b = breakdown.get(l.lpEntityId)
        return {
          partner: name(l.lpEntityId), line: 'distribution on capital', amount: l.amount,
          ...(b ? { return_of_capital: b.returnOfCapital, preferred_return: b.preferred, profit: b.profit } : {}),
        }
      }),
      carry_lines: p.carryLines.map(l => ({ partner: name(l.lpEntityId), line: 'carried interest', amount: l.amount })),
      tiers: p.method === 'waterfall' ? p.tiers : null,
      suggested_character: p.suggestedCharacter,
      missing: p.checks.missing,
      flags: p.checks.flags,
      workbook,
      next: blocked
        ? 'Nothing was written. It cannot be declared while a check is a blocker or a required item is missing: tell the user which.'
        : 'Nothing was written. Show the user each partner\'s lines (the GP\'s capital and its carry apart), the tiers and every ' +
          'flag, and the workbook link (it opens for an hour). Only if they confirm, call declare_distribution with this vehicle, ' +
          'total and method and the date; an admin then approves it.',
    }
  },

  // Always staged as the declare_distribution pending action (its manifest's `stagesAs`).
  declare_distribution: async () => {
    throw new Error('declare_distribution is always staged for an admin to approve; it cannot run directly.')
  },

  distribution_workbook: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    let args: Record<string, string>
    if (input?.distributionId) {
      const id = String(input.distributionId)
      // Fail here rather than on a link that 404s later.
      if (!(await listDistributions(admin, fundId, vehicle)).some(d => d.distributionId === id)) {
        throw new Error(`No declared distribution ${id} in ${vehicle}. list_distributions shows them.`)
      }
      args = { vehicle, id }
    } else {
      const total = Math.round(Number(input?.total) * 100) / 100
      if (!Number.isFinite(total) || total <= 0) throw new Error('Pass distributionId, or a positive total for a preview.')
      const asOf = input?.asOf ? String(input.asOf) : new Date().toISOString().slice(0, 10)
      if (!ISO_DATE.test(asOf)) throw new Error('asOf must be YYYY-MM-DD.')
      args = { vehicle, total: String(total), as_of: asOf, method: input?.method === 'pro_rata' ? 'pro_rata' : 'waterfall' }
    }
    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'distribution_workbook', args })
    return {
      document: args.id ? 'Distribution calculation (Excel)' : 'Distribution calculation, preview (Excel)',
      vehicle,
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: linkNote('It opens the workbook for an hour, and only for this member.'),
    }
  },

  // The person's own sign-off, in their name. The Capital accounts page records the same.
  distribution_sign_off: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('A sign-off is recorded in a member\'s name; this credential has no user.')
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const distributionId = String(input?.distributionId ?? '')
    if (!distributionId) throw new Error('distributionId is required (list_distributions).')
    const clear = input?.clear === true
    const out = await signOffDistribution(admin, fundId, vehicle, userId, distributionId, { note: input?.note ?? null, clear })
    if ('error' in out) throw new Error(out.error)
    await recordAudit(admin, {
      fundId, vehicleId: await vehicleIdByName(admin, fundId, vehicle), actorId: userId,
      action: clear ? 'distribution.sign_off_cleared' : 'distribution.sign_off', subjectType: 'distribution', subjectId: distributionId,
      details: { note: out.signOff?.note ?? null },
    })
    return { vehicle, distributionId, signed_off: clear ? null : out.signOff }
  },

  // Masked: last four digits only. Full numbers never go over this connection.
  lp_bank_details: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const partners = await lpCapitalSummary(admin, fundId, vehicle)
    const wires = await loadWireSummaries(admin, fundId, partners.map(p => p.lpEntityId))
    return {
      vehicle,
      partners: partners.map(p => {
        const w = wires.get(p.lpEntityId)
        return w
          ? {
              partner: p.name, lpEntityId: p.lpEntityId, beneficiary: w.beneficiaryName, bank: w.bankName, account: w.accountMasked,
              routing: w.routingMasked, swift: w.swiftCode, reference: w.reference, status: w.status,
              entered: { by: w.enteredBy, at: w.enteredAt }, verified: w.verifiedAt ? { by: w.verifiedBy, at: w.verifiedAt, callback: w.verificationNote } : null,
            }
          : { partner: p.name, lpEntityId: p.lpEntityId, status: 'none' }
      }),
      note: 'Account numbers are masked. Details are entered and verified in the app; request_bank_details asks partners for them.',
    }
  },

  // Always staged as the request_bank_details pending action (its manifest's `stagesAs`).
  request_bank_details: async () => {
    throw new Error('request_bank_details is always staged for an admin to approve; it cannot run directly.')
  },

  // A link, never the numbers: the file goes to the member's browser. Admin-only (ADMIN_ONLY_TOOLS),
  // and the report route checks the role again on the click.
  distribution_payout_sheet: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const denied = adminOnlyDenial(access.role, HANDLER_CHECKED.payoutSheet)
    if (denied) throw new Error(denied)
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const id = String(input?.distributionId ?? '')
    if (!(await listDistributions(admin, fundId, vehicle)).some(d => d.distributionId === id)) {
      throw new Error(`No declared distribution ${id} in ${vehicle}. list_distributions shows them.`)
    }
    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'distribution_payouts', args: { vehicle, id } })
    return {
      document: 'Distribution payout sheet (Excel)',
      vehicle,
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: linkNote('It contains full account numbers: it opens for an hour, only for this member, and the export is logged. Do not paste its contents into the chat.'),
    }
  },

  // What publishing (and emailing) a distribution's notices would do. The first of two
  // confirmations; the chat then stages publish_distribution_notices with its token.
  preview_distribution_notices: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const distributionId = String(input?.distributionId ?? '')
    const lpEntityIds = Array.isArray(input?.lpEntityIds) ? input.lpEntityIds.map(String) : null
    const review = unwrap(await reviewDistributionNotices(admin, { fundId, group: vehicle }, distributionId, { lpEntityIds, email: normalizeNoticeEmail(input?.email) }))
    if (!userId) throw new Error('A preview link names the member who asked; this credential has none.')
    const base = origin ?? siteOrigin()
    const blocked = review.flags.some(f => f.severity === 'blocker')
    // Without gp_economics the carry recipients are one combined row with no draft link: a
    // recipient's notice is what they receive. The preview token still covers every notice.
    const hide = await recipientsToHide(admin, fundId, vehicle, access)
    return {
      ...review,
      flags: hide ? foldFlags(review.flags, hide) : review.flags,
      partners: (hide ? foldNoticePartners(review.partners, hide) : review.partners).map(p => {
        if (p.lpEntityId === COMBINED_RECIPIENTS_ID) return { ...p, draftPdf: null }
        const { token } = signReportLink({ fundId, userId, kind: 'distribution_notice_preview', args: { vehicle, distribution: distributionId, lp: p.lpEntityId } })
        return { ...p, draftPdf: reportLinkUrl(base, token) }
      }),
      next: blocked
        ? 'Nothing can be published until the blockers in flags are resolved. Tell the user what they are.'
        : 'Nothing has been published or emailed. Show the user every partner, amount (capital and carry apart), recipient and ' +
          'draftPdf link, and every flag, in plain words. Ask them to confirm. Only if they do, call publish_distribution_notices ' +
          'with this vehicle, distributionId, the same lpEntityIds and email, and this previewToken. That stages it; an admin then ' +
          'approves it (approve_action on their explicit yes, or in the app). The draftPdf links open for an hour.',
    }
  },

  // Always staged as the publish_distribution_notices pending action (its manifest's `stagesAs`).
  publish_distribution_notices: async () => {
    throw new Error('publish_distribution_notices is always staged for an admin to approve; it cannot run directly.')
  },

  // What publishing a call's notices would do. The first of the two confirmations: the person reads
  // this, then the chat stages publish_call_notices with its token (lib/pending-actions/call-notices.ts).
  preview_call_notices: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    const vehicle = await resolveVehicle(admin, fundId, String(input?.vehicle ?? ''), access)
    const callId = String(input?.callId ?? '')
    const lpEntityIds = Array.isArray(input?.lpEntityIds) ? input.lpEntityIds.map(String) : null
    const review = unwrap(await reviewCallNotices(admin, { fundId, group: vehicle }, callId, { lpEntityIds }))
    if (!userId) throw new Error('A preview link names the member who asked; this credential has none.')
    const base = origin ?? siteOrigin()
    const blocked = review.flags.some(f => f.severity === 'blocker')
    return {
      ...review,
      partners: review.partners.map(p => {
        const { token } = signReportLink({ fundId, userId, kind: 'call_notice_preview', args: { vehicle, call: callId, lp: p.lpEntityId } })
        return { ...p, draftPdf: reportLinkUrl(base, token) }
      }),
      next: blocked
        ? 'Nothing can be published until the blockers in flags are resolved. Tell the user what they are.'
        : 'Nothing has been published. Show the user every partner, amount and draftPdf link above, and every missing item and flag, ' +
          'in plain words. Ask them to confirm. Only if they do, call publish_call_notices with this vehicle, callId, the same ' +
          'lpEntityIds and this previewToken. That stages the request; an admin then approves it (approve_action from their chat, ' +
          'on their explicit yes, or in the app, confirming twice). ' +
          'The draftPdf links open for an hour.',
    }
  },

  // Always staged as the issue_capital_call pending action (its manifest's `stagesAs`): an admin
  // approves the call in the app, as one the in-app Analyst drafts.
  issue_capital_call: async () => {
    throw new Error('issue_capital_call is always staged for approval in the app; it cannot run directly.')
  },

  // Always staged as the publish_call_notices pending action (its manifest's `stagesAs`), so this
  // never runs; it refuses rather than publish without an admin's approval (approve_action or the app).
  publish_call_notices: async () => {
    throw new Error('publish_call_notices is always staged for an admin to approve; it cannot run directly.')
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

    const basis = await resolveStatementBasis(admin, fundId, vehicle, input?.basis)
    if (typeof basis !== 'string') throw new Error(basis.error)

    const result = await lpStatement(
      admin, fundId, vehicle, lp.entityId,
      start || end ? { start, end } : undefined,
      basis,
    )
    // Returns a union, not a throw.
    if ('error' in result) throw new Error(result.error)
    const columns = new Set(statementColumns({ start, end }, { period: 0, ytd: 0, itd: 0 }).map(c => c.label))

    return {
      vehicle,
      investor: lp.investorName,
      entity: lp.entityName,
      period: start || end ? { start, end } : 'since inception',
      // Every figure below is on this basis. Off fair value, basis_footing shows how it ties to the
      // books: fair-value ending less the excluded lines (inception to date) is this ending.
      basis,
      // False for a partner on administrator snapshots: only fair_value can be asked for.
      bases_available: result.basesAvailable,
      ...(basis !== 'fair_value' ? {
        basis_note: BASIS_NOTES[basis],
        basis_footing: {
          fair_value_ending: result.basisFooting.fairValueEnding,
          excluded_itd: result.basisFooting.excluded,
          ending: result.basisFooting.ending,
        },
      } : {}),
      position: {
        commitment: result.row.commitment,
        called: result.row.called,
        funded: result.row.funded,
        outstanding: result.row.outstanding,
        receivable: result.row.receivable,
        ending_balance: result.row.ending,
      },
      // The statement's three columns, as the PDF prints them. Includes the carried-interest line:
      // the carry this LP is charged, which is the fund's carry. A recipient's statement — what
      // they earn — was refused above without gp_economics.
      // Only the columns the statement prints (statementColumns): no period column on an
      // inception-to-date statement, no YTD column when the period is year to date.
      ...(columns.has('Statement period') ? { roll_forward_period: result.periodRollForward } : {}),
      ...(columns.has('Year to date') ? { roll_forward_ytd: result.ytdRollForward } : {}),
      ytd_period: result.ytdPeriod,
      roll_forward_itd: result.rollForward,
      commitment_summary: {
        commitment: result.row.commitment,
        ...(columns.has('Statement period') ? { called_period: result.periodRollForward.contributions } : {}),
        ...(columns.has('Year to date') ? { called_ytd: result.ytdRollForward.contributions } : {}),
        called_itd: result.row.called,
        remaining_to_be_called: result.row.outstanding,
        ownership: result.ownership,
        ending_capital: result.row.ending,
      },
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

    const basis = await resolveStatementBasis(admin, fundId, vehicle, input?.basis)
    if (typeof basis !== 'string') throw new Error(basis.error)

    // Fail here, in the conversation, rather than on a link that 404s later.
    const check = await lpStatement(admin, fundId, vehicle, lp.entityId, { start: period.start, end: period.end }, basis)
    if ('error' in check) throw new Error(check.error)

    // The basis rides in the link, resolved now, so the document matches what was asked for even
    // if the vehicle's default changes before the click.
    const { token, expiresAt } = signReportLink({
      fundId, userId, kind: 'lp_statement',
      args: { vehicle, lp: lp.entityId, start: period.start, end: period.end, label: period.label, basis },
    })
    return {
      document: basis === 'fair_value' ? 'Capital account statement (PDF)' : `Capital account statement, ${BASIS_LABELS[basis].toLowerCase()} (PDF)`,
      vehicle, investor: lp.investorName, entity: lp.entityName, period: period.label, basis,
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: linkNote('It opens the PDF for an hour, and only for this member. If they ask again later, call this tool again rather than re-sharing this link.'),
    }
  },

  lp_report_card_pdf: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const asOf = input?.as_of == null || input.as_of === '' ? null : String(input.as_of)
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('as_of must be YYYY-MM-DD.')
    const lpScope = await lpToolScope(admin, access)
    const matches = resolveLp(await loadIdentities(admin, fundId, lpScope.entityIds), String(input?.investor ?? ''))
    // One card per group: an investor grouped under a parent is on the parent's card.
    const investors = cardGroupsOf(matches)
    if (investors.size === 0) throw new Error(`"${input?.investor}" has no investor record to report on.`)
    if (investors.size > 1) {
      throw new Error(`"${input.investor}" matches ${investors.size} investors (${[...investors.values()].join(', ')}). Pass one.`)
    }
    const [[investorId, investorName]] = [...investors]

    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'lp_report_card', args: { investor: investorId, as_of: asOf } })
    return {
      document: 'LP report card (PDF)',
      investor: investorName,
      as_of: asOf ?? 'current figures',
      // A member who sees only some entities gets a report card of only those.
      vehicles: lpScope.names ?? 'all',
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: linkNote('It opens the PDF for an hour, and only for this member. If they ask again later, call this tool again rather than re-sharing this link.'),
    }
  },

  // Many report cards in one ZIP: the fund's live report is built once at the click and every card
  // cut from it (lib/lp-report-cards). The link names investor ids, or none for every investor the
  // member can see then; the click re-checks both.
  lp_report_cards_zip: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const asOf = input?.as_of == null || input.as_of === '' ? null : String(input.as_of)
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('as_of must be YYYY-MM-DD.')
    const refs: string[] = Array.isArray(input?.investors) ? input.investors.map(String).filter((r: string) => r.trim()) : []
    const lpScope = await lpToolScope(admin, access)
    const identities = await loadIdentities(admin, fundId, lpScope.entityIds)

    let investorIds: string[] | null = null
    const names = new Map<string, string>()
    if (refs.length > 0) {
      for (const ref of refs) {
        const found = cardGroupsOf(resolveLp(identities, ref))
        if (found.size === 0) throw new Error(`"${ref}" has no investor record to report on.`)
        if (found.size > 1) throw new Error(`"${ref}" matches ${found.size} investors (${[...found.values()].join(', ')}). Pass one.`)
        const [[id, name]] = [...found]
        names.set(id, name)
      }
      investorIds = [...names.keys()]
    } else {
      for (const [id, name] of cardGroupsOf([...identities.values()])) names.set(id, name)
      if (names.size === 0) throw new Error('There are no investors to report on.')
    }

    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'lp_report_cards', args: { investors: investorIds, as_of: asOf } })
    return {
      document: 'LP report cards (ZIP of PDFs)',
      investors: investorIds ? [...names.values()] : `every investor (${names.size})`,
      as_of: asOf ?? 'current figures',
      // A member who sees only some entities gets report cards of only those.
      vehicles: lpScope.names ?? 'all',
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      note: linkNote('It downloads the ZIP for an hour, and only for this member; a large fund can take a minute to build. If they ask again later, call this tool again rather than re-sharing this link.'),
    }
  },
}
