// Handlers for the destructive tools (./destructive-tools-manifest.ts), and what the person
// approving one sees before deciding.
//
// Each handler resolves names to ids with the caller's access, then calls the SAME lib function its
// web route calls, so a refusal is worded once. They run only on approval: every call is staged
// (lib/agent/dispatch.ts shouldStage), and approval re-runs the handler as the approving admin
// (lib/agent/tool-call-action.ts executeToolCall).
//
// DESTRUCTIVE_PREVIEWS reads what a change would remove, for the staged preview. It also pins the
// ids the change resolves to into the staged input, so an approval acts on the record that was
// previewed even if a name later matches something else.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { removeMember } from '@/lib/access/remove-member'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { changeEntryState } from '@/lib/accounting/journal-state'
import { mayTouchInvestments } from '@/lib/accounting/investment-access'
import { planRelease } from '@/lib/accounting/ownership'
import { deleteLpPositions } from '@/lib/accounting/positions-delete'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { deleteInactiveCompanyAccounts, readInactiveCompanyAccounts } from '@/lib/accounting/inactive-accounts-delete'
import { deleteCompany } from '@/lib/companies/delete'
import { mergeCompanies } from '@/lib/companies/merge'
import { deleteFundHolding } from '@/lib/portfolio/fund-holding-delete'
import { clearFundRegister, readRegisterRows } from '@/lib/portfolio/fund-register-clear'
import { DILIGENCE_CASCADE_TABLES, deleteDiligenceDeal } from '@/lib/diligence/service'
import { deleteCommitmentEvent, deleteEntity, deleteInvestor, entityLedgerActivity, mergeEntities, mergeInvestors } from '@/lib/lps/records'
import { unwrap } from '@/lib/service-outcome'
import { mergeVehicles } from '@/lib/vehicles-merge'
import type { ActionDeps } from '@/lib/pending-actions/types'
import { requireUser } from './deals-tools'
import { resolveDeal } from './diligence-tools'
import { lpToolScope } from './lp-tools'
import { resolveEntity as resolveLpEntity, resolveInvestor } from './lp-record-tools'
import { resolveCompany } from './portfolio-tools'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function text(v: unknown, label: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new Error(`${label} is required.`)
  return s
}

// ── Resolvers ───────────────────────────────────────────────────────────────────────────────

/** One of this fund's vehicles the caller can see, by id, name or alias. */
async function resolveVehicleRow(admin: SupabaseClient, access: AccessContext, ref: string): Promise<{ id: string; name: string }> {
  const needle = ref.trim().toLowerCase()
  const { data } = await (admin as any).from('fund_vehicles').select('id, name, aliases').eq('fund_id', access.fundId)
  const rows = ((data as any[]) ?? []).filter(v => canSeeVehicle(access, v.id))
  const match = rows.find(v => v.id === ref.trim())
    ?? rows.find(v => String(v.name).trim().toLowerCase() === needle)
    ?? rows.find(v => Array.isArray(v.aliases) && v.aliases.some((a: string) => String(a).trim().toLowerCase() === needle))
  if (!match) throw new Error(`No entity matching "${ref}"${rows.length ? `. This fund has: ${rows.map(v => v.name).join(', ')}` : ''}.`)
  return { id: match.id, name: match.name }
}

/** One member of this fund, by membership id, user id or email. */
async function resolveMember(admin: SupabaseClient, fundId: string, ref: string): Promise<{ id: string; userId: string; role: string; email: string | null }> {
  const { data } = await (admin as any).from('fund_members').select('id, user_id, role').eq('fund_id', fundId)
  const rows = ((data as any[]) ?? []) as { id: string; user_id: string; role: string }[]
  const byId = rows.find(m => m.id === ref || m.user_id === ref)
  const emailOf = async (userId: string): Promise<string | null> => {
    try {
      const { data: u } = await (admin as any).auth.admin.getUserById(userId)
      return u?.user?.email ?? null
    } catch {
      return null
    }
  }
  if (byId) return { id: byId.id, userId: byId.user_id, role: byId.role, email: await emailOf(byId.user_id) }
  if (!ref.includes('@')) throw new Error(`No member matching "${ref}". Pass their email address.`)
  for (const m of rows) {
    const email = await emailOf(m.user_id)
    if (email && email.toLowerCase() === ref.trim().toLowerCase()) return { id: m.id, userId: m.user_id, role: m.role, email }
  }
  throw new Error(`No member of this fund has the email ${ref}.`)
}

/** A commitment event of the caller's LPs, on one vehicle. */
async function resolveCommitmentEvent(ctx: Pick<AgentToolContext, 'admin' | 'fundId' | 'access'>, vehicle: string, eventId: string) {
  const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, vehicle)
  const { data: ev } = await (ctx.admin as any).from('commitment_events')
    .select('id, lp_entity_id, effective_date, amount, kind, transfer_id, counterparty_entity_id, memo')
    .eq('id', eventId).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).maybeSingle()
  const scope = await lpToolScope(ctx.admin, ctx.access)
  if (!ev || (scope.entityIds !== null && !scope.entityIds.includes(ev.lp_entity_id))) throw new Error('Not found')
  return ev as Record<string, any>
}

const vehicleOf = (input: any, access: AccessContext, admin: SupabaseClient, fundId: string) =>
  resolveVehicle(admin, fundId, String(input?.vehicle ?? '') || undefined, { access })

// ── Journal state changes ───────────────────────────────────────────────────────────────────

/**
 * void_entry is for POSTED entries. The shared journal route also discards a draft by voiding it,
 * but from chat that is discard_drafts' job, which needs no admin; refused here (and in the
 * preview, so staging one, alone or as a run step, fails at once) rather than in the shared lib.
 */
export const VOID_DRAFT_REFUSAL =
  'That entry is a draft, and void_entry is for posted entries. Discard drafts with discard_drafts (pass its id in ids), ' +
  'which needs no admin approval.'

async function refuseDraftVoid(admin: SupabaseClient, fundId: string, vehicleId: string | null, entryId: string): Promise<void> {
  const { data } = await (admin as any).from('journal_entries').select('status')
    .eq('book', ACTUAL_BOOK).eq('id', entryId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
  if (data?.status === 'draft') throw new Error(VOID_DRAFT_REFUSAL)
}

function entryStateHandler(action: 'unpost' | 'void' | 'reverse'): AgentToolHandler {
  return async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
    if (action === 'void') await refuseDraftVoid(ctx.admin, ctx.fundId, vehicleId, text(input?.entry_id, 'entry_id'))
    const out = await changeEntryState(ctx.admin, {
      fundId: ctx.fundId, role: ctx.access.role, userId,
      mayTouchInvestments: async () => mayTouchInvestments(ctx.access),
    }, ctx.portfolioGroup, vehicleId, {
      id: text(input?.entry_id, 'entry_id'), action, reason: input?.reason,
      ...(action === 'reverse' ? { reverseDate: input?.reverse_date, post: input?.post === true } : {}),
    })
    if (out.status >= 400) throw new Error(String(out.body.error ?? 'The entry could not be changed.'))
    return { vehicle: ctx.portfolioGroup, entryId: input.entry_id, ...out.body }
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────────

export const DESTRUCTIVE_HANDLERS: Record<string, AgentToolHandler> = {
  unpost_entry: entryStateHandler('unpost'),
  reverse_entry: entryStateHandler('reverse'),
  void_entry: entryStateHandler('void'),

  delete_lp_positions: async (ctx: AgentToolContext, input: any) => {
    const asOf = String(input?.as_of_date ?? '')
    unwrap(await deleteLpPositions(ctx.admin, ctx.fundId, ctx.portfolioGroup, asOf))
    return { deleted: true, vehicle: ctx.portfolioGroup, as_of_date: asOf }
  },

  delete_company: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const company = await resolveCompany(ctx.admin, ctx.fundId, text(input?.company, 'company'), ctx.access)
    const out = unwrap(await deleteCompany(ctx.admin, { fundId: ctx.fundId, userId }, company.id, () => entityScopeFor(ctx.admin, ctx.access)))
    return { deleted: { id: out.id, name: out.name } }
  },

  delete_fund_holding: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const holding = await resolveCompany(ctx.admin, ctx.fundId, text(input?.company, 'company'), ctx.access)
    const out = unwrap(await deleteFundHolding(ctx.admin, { fundId: ctx.fundId, userId }, holding.id, () => entityScopeFor(ctx.admin, ctx.access)))
    return { deleted: { id: out.id, name: out.name }, accountsRemoved: out.accountsRemoved, ...(out.warning ? { warning: out.warning } : {}) }
  },

  clear_fund_register: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const company = await resolveCompany(ctx.admin, ctx.fundId, text(input?.company, 'company'), ctx.access)
    const vehicle = await resolveVehicleRow(ctx.admin, ctx.access, await vehicleOf(input, ctx.access, ctx.admin, ctx.fundId))
    const out = unwrap(await clearFundRegister(ctx.admin, { fundId: ctx.fundId, userId }, company.id, vehicle.id))
    return {
      cleared: { id: out.id, name: out.name }, vehicle: vehicle.name,
      deleted: { capitalEvents: out.capitalEvents, navStatements: out.navStatements, terms: out.terms },
      transactionsReleased: out.transactionsReleased,
    }
  },

  delete_inactive_company_accounts: async (ctx: AgentToolContext, input: any) => {
    const company = await resolveCompany(ctx.admin, ctx.fundId, text(input?.company, 'company'), ctx.access)
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
    if (!vehicleId) throw new Error(`No entity named ${ctx.portfolioGroup}.`)
    const out = unwrap(await deleteInactiveCompanyAccounts(ctx.admin, ctx.fundId, vehicleId, company.id))
    return { vehicle: ctx.portfolioGroup, company: { id: company.id, name: company.name }, deleted: out.deleted, activeKept: out.activeKept }
  },

  lp_delete_investor: async (ctx: AgentToolContext, input: any) => {
    const investor = await resolveInvestor(ctx.admin, ctx.fundId, text(input?.investor, 'investor'))
    unwrap(await deleteInvestor(ctx.admin, ctx.fundId, investor.id))
    return { deleted: investor }
  },

  lp_delete_entity: async (ctx: AgentToolContext, input: any) => {
    const entity = await resolveLpEntity(ctx, text(input?.lp, 'lp'))
    unwrap(await deleteEntity(ctx.admin, ctx.fundId, entity.entityId))
    return { deleted: { id: entity.entityId, name: entity.entityName } }
  },

  lp_delete_commitment: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await vehicleOf(input, ctx.access, ctx.admin, ctx.fundId)
    const ev = await resolveCommitmentEvent(ctx, vehicle, text(input?.event_id, 'event_id'))
    const out = unwrap(await deleteCommitmentEvent(ctx.admin, { fundId: ctx.fundId, userId }, vehicle, ev.id, input?.reason))
    return { deleted: ev.id, legs: out.legs, vehicle }
  },

  lp_merge_entities: async (ctx: AgentToolContext, input: any) => {
    const from = await resolveLpEntity(ctx, text(input?.from, 'from'))
    const into = await resolveLpEntity(ctx, text(input?.into, 'into'))
    const out = unwrap(await mergeEntities(ctx.admin, ctx.fundId, from.entityId, into.entityId))
    return { merged: { from: { id: from.entityId, name: from.entityName }, into: { id: into.entityId, name: into.entityName } }, moved: out.moved }
  },

  lp_merge_investors: async (ctx: AgentToolContext, input: any) => {
    const from = await resolveInvestor(ctx.admin, ctx.fundId, text(input?.from, 'from'))
    const into = await resolveInvestor(ctx.admin, ctx.fundId, text(input?.into, 'into'))
    unwrap(await mergeInvestors(ctx.admin, ctx.fundId, from.id, into.id))
    return { merged: { from, into } }
  },

  diligence_delete_deal: async (ctx: AgentToolContext, input: any) => {
    const deal = await resolveDeal(ctx.admin, ctx.fundId, text(input?.deal, 'deal'), ctx.access)
    unwrap(await deleteDiligenceDeal(ctx.admin, ctx.fundId, deal.id))
    return { deleted: { id: deal.id, name: deal.name } }
  },

  remove_member: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const member = await resolveMember(ctx.admin, ctx.fundId, text(input?.member, 'member'))
    unwrap(await removeMember(ctx.admin, { fundId: ctx.fundId, userId }, member.id))
    return { removed: { id: member.id, email: member.email } }
  },

  merge_vehicles: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const from = await resolveVehicleRow(ctx.admin, ctx.access, text(input?.from, 'from'))
    const into = await resolveVehicleRow(ctx.admin, ctx.access, text(input?.into, 'into'))
    const merged = unwrap(await mergeVehicles(ctx.admin, { fundId: ctx.fundId, userId, access: ctx.access }, from.id, into.id))
    return { merged: { from, into }, vehicle: merged }
  },

  merge_companies: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const from = await resolveCompany(ctx.admin, ctx.fundId, text(input?.from, 'from'), ctx.access)
    const into = await resolveCompany(ctx.admin, ctx.fundId, text(input?.into, 'into'), ctx.access)
    const scope = () => entityScopeFor(ctx.admin, ctx.access)
    const { vehicleNames } = await scope()
    return unwrap(await mergeCompanies(ctx.admin, { fundId: ctx.fundId, userId, vehicleNames }, from.id, into.id, scope))
  },
}

// ── What the approver sees ──────────────────────────────────────────────────────────────────

export interface DestructivePreview {
  /** Ids to pin into the staged input, so approval acts on what was previewed. */
  pin: Record<string, unknown>
  summary: string
  /** What the change would remove or move, read now. */
  impact: Record<string, unknown>
}

type Previewer = (deps: ActionDeps, input: Record<string, any>) => Promise<DestructivePreview>

async function count(admin: SupabaseClient, table: string, filters: Record<string, unknown>): Promise<number | null> {
  let q = (admin as any).from(table).select('id', { count: 'exact', head: true })
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
  const { count: n, error } = await q
  return error ? null : (n ?? 0)
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function entryPreview(verb: string): Previewer {
  return async (deps, input) => {
    const vehicle = String(input.vehicle ?? '')
    const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, vehicle)
    const id = text(input.entry_id, 'entry_id')
    const { data: entry } = await (deps.admin as any).from('journal_entries')
      .select('id, status, entry_date, memo, reference, source_ref, reversed_by')
      .eq('book', ACTUAL_BOOK).eq('id', id).eq('fund_id', deps.fundId).eq('vehicle_id', vehicleId).maybeSingle()
    if (!entry) throw new Error(`No journal entry ${id} on ${vehicle}.`)
    if (verb === 'Void' && entry.status === 'draft') throw new Error(VOID_DRAFT_REFUSAL)
    const { data: postings } = await (deps.admin as any).from('journal_postings').select('amount').eq('book', ACTUAL_BOOK).eq('journal_entry_id', id)
    const debits = ((postings as any[]) ?? []).reduce((s, p) => s + Math.max(0, Number(p.amount)), 0)
    const plan = await planRelease(deps.admin, deps.fundId, entry)
    const transactions = 'error' in plan ? null : plan.removed
    const extra = verb === 'Reverse' ? ` with a contra-entry dated ${input.reverse_date}${input.post === true ? ', posted' : ', as a draft'}` : ''
    return {
      pin: {},
      summary: `${verb} journal entry ${entry.entry_date} "${entry.memo ?? ''}" (${entry.status}, ${money(debits)}) on ${vehicle}${extra}. Reason: ${input.reason ?? 'none given'}`,
      impact: {
        entry: { id: entry.id, date: entry.entry_date, memo: entry.memo ?? null, reference: entry.reference ?? null, status: entry.status, total: debits },
        investmentTransactionsDeleted: transactions ?? 'could not be read; the change will be refused if they cannot be',
      },
    }
  }
}

export const DESTRUCTIVE_PREVIEWS: Record<string, Previewer> = {
  unpost_entry: entryPreview('Unpost'),
  void_entry: entryPreview('Void'),
  reverse_entry: entryPreview('Reverse'),

  // Not a destructive tool (it is always offered), but staged for an admin the same way, with the
  // periods it would reopen in the preview.
  reopen_period: async (deps, input) => {
    const vehicle = String(input.vehicle ?? '')
    const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, vehicle)
    let cutoff = typeof input.from_date === 'string' && ISO_DATE.test(input.from_date) ? input.from_date : null
    if (input.period_id) {
      const { data: row } = await (deps.admin as any).from('fiscal_periods').select('period_start')
        .eq('id', String(input.period_id)).eq('fund_id', deps.fundId).eq('vehicle_id', vehicleId).maybeSingle()
      if (!row) throw new Error('Period not found')
      cutoff = row.period_start
    }
    if (!cutoff) throw new Error('Pass period_id or from_date (YYYY-MM-DD).')
    const { data: closed } = await (deps.admin as any).from('fiscal_periods').select('id, period_start, period_end, label')
      .eq('fund_id', deps.fundId).eq('vehicle_id', vehicleId).eq('status', 'closed').gte('period_end', cutoff)
      .order('period_start', { ascending: false })
    const periods = ((closed as any[]) ?? []).map(p => p.label ?? `${p.period_start} → ${p.period_end}`)
    return {
      pin: {},
      summary: `Reopen ${periods.length} closed period${periods.length === 1 ? '' : 's'} on ${vehicle} (${periods.join(', ') || 'none found'}), voiding their close allocations. Reason: ${input.reason ?? 'none given'}`,
      impact: { periodsReopened: periods },
    }
  },

  delete_lp_positions: async (deps, input) => {
    const vehicle = String(input.vehicle ?? '')
    const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, vehicle)
    const asOf = String(input.as_of_date ?? '')
    const n = vehicleId ? await count(deps.admin, 'lp_positions', { fund_id: deps.fundId, vehicle_id: vehicleId, as_of_date: asOf }) : 0
    return {
      pin: {},
      summary: `Delete the LP positions dated ${asOf} on ${vehicle}: ${n ?? 'an unknown number of'} LP row${n === 1 ? '' : 's'}.`,
      impact: { positionsDeleted: n },
    }
  },

  delete_company: async (deps, input) => {
    const company = await resolveCompany(deps.admin, deps.fundId, text(input.company, 'company'), deps.access)
    const where = { fund_id: deps.fundId, company_id: company.id }
    const [transactions, documents, notes, metrics] = await Promise.all([
      count(deps.admin, 'investment_transactions', where), count(deps.admin, 'company_documents', where),
      count(deps.admin, 'company_notes', where), count(deps.admin, 'metrics', where),
    ])
    return {
      pin: { company: company.id },
      summary: `Delete ${company.holding_type === 'crypto' ? 'digital asset' : 'company'} ${company.name} for every entity, with ` +
        `${documents ?? '?'} document(s), ${notes ?? '?'} note(s) and ${metrics ?? '?'} metric(s).` +
        (transactions ? ` It has ${transactions} investment transaction(s), so the delete will be refused until they are deleted.` : ''),
      impact: { company: { id: company.id, name: company.name }, investmentTransactions: transactions, documents, notes, metrics },
    }
  },

  delete_fund_holding: async (deps, input) => {
    const holding = await resolveCompany(deps.admin, deps.fundId, text(input.company, 'company'), deps.access)
    const where = { fund_id: deps.fundId, company_id: holding.id }
    const [events, navs, terms, transactions, accounts] = await Promise.all([
      count(deps.admin, 'fund_capital_events', where), count(deps.admin, 'fund_nav_statements', where),
      count(deps.admin, 'fund_holding_terms', where), count(deps.admin, 'investment_transactions', where),
      count(deps.admin, 'chart_of_accounts', where),
    ])
    const notFund = holding.holding_type !== 'fund'
    return {
      pin: { company: holding.id },
      summary: `Delete fund holding ${holding.name} for every entity, with ${terms ?? '?'} terms row(s), ${events ?? '?'} capital ` +
        `notice(s), ${navs ?? '?'} NAV statement(s) and ${accounts ?? '?'} chart account(s).` +
        (notFund ? ` It is not a fund holding, so the delete will be refused: use delete_company.` : '') +
        (transactions ? ` It has ${transactions} investment transaction(s), so the delete will be refused until they are deleted.` : ''),
      impact: { holding: { id: holding.id, name: holding.name }, terms, capitalEvents: events, navStatements: navs, investmentTransactions: transactions, chartAccounts: accounts },
    }
  },

  clear_fund_register: async (deps, input) => {
    const company = await resolveCompany(deps.admin, deps.fundId, text(input.company, 'company'), deps.access)
    const vehicle = await resolveVehicleRow(deps.admin, deps.access, await vehicleOf(input, deps.access, deps.admin, deps.fundId))
    const rows = unwrap(await readRegisterRows(deps.admin, deps.fundId, company.id, vehicle.id))
    const released = rows.transactionsReleased.length
    return {
      pin: { company: company.id, vehicle: vehicle.name },
      summary: `Delete ${company.name}'s fund-register rows on ${vehicle.name}: ${rows.terms} terms row(s), ${rows.capitalEvents} capital ` +
        `notice(s) and ${rows.navStatements} NAV statement(s). ` +
        (released ? `The ${released} investment transaction(s) they booked stay, with their journal entries.` : 'No investment transactions are linked to them.') +
        (company.holding_type === 'fund' ? ' It is a fund holding, so this will be refused.' : ''),
      impact: { company: { id: company.id, name: company.name, holdingType: company.holding_type ?? null }, vehicle, ...rows },
    }
  },

  delete_inactive_company_accounts: async (deps, input) => {
    const vehicle = String(input.vehicle ?? '')
    const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, vehicle)
    if (!vehicleId) throw new Error(`No entity named ${vehicle}.`)
    const company = await resolveCompany(deps.admin, deps.fundId, text(input.company, 'company'), deps.access)
    const read = unwrap(await readInactiveCompanyAccounts(deps.admin, deps.fundId, vehicleId, company.id))
    const blocked = read.postings > 0 || read.scheduleLines > 0
    return {
      pin: { company: company.id },
      summary: `Delete ${read.accounts.length} inactive chart account(s) of ${company.name} on ${vehicle}` +
        `${read.accounts.length ? ` (${read.accounts.map(a => a.code).join(', ')})` : ''}; ${read.activeKept} active account(s) stay.` +
        (blocked ? ` They carry ${read.postings} posting(s) and ${read.scheduleLines} schedule line(s), so the delete will be refused.` : ''),
      impact: { company: { id: company.id, name: company.name }, ...read },
    }
  },

  lp_delete_investor: async (deps, input) => {
    const investor = await resolveInvestor(deps.admin, deps.fundId, text(input.investor, 'investor'))
    const { data: ents } = await (deps.admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', deps.fundId).eq('investor_id', investor.id)
    const entities = await Promise.all(((ents as any[]) ?? []).map(async e => ({
      id: e.id, name: e.entity_name, ...(await entityLedgerActivity(deps.admin, deps.fundId, e.id)),
    })))
    const active = entities.filter(e => e.postings > 0 || e.callLines > 0)
    return {
      pin: { investor: investor.id },
      summary: `Delete LP investor ${investor.name} and its ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}` +
        `${entities.length ? ` (${entities.map(e => e.name).join(', ')})` : ''}.` +
        (active.length ? ` WARNING: ${active.map(e => e.name).join(', ')} ${active.length === 1 ? 'has' : 'have'} ledger activity.` : ''),
      impact: { investor, entities },
    }
  },

  lp_delete_entity: async (deps, input) => {
    const entity = await resolveLpEntity(deps, text(input.lp, 'lp'))
    const activity = await entityLedgerActivity(deps.admin, deps.fundId, entity.entityId)
    const blocked = activity.postings > 0 || activity.callLines > 0
    return {
      pin: { lp: entity.entityId },
      summary: `Delete LP entity ${entity.entityName}${entity.investorName ? ` (investor ${entity.investorName})` : ''}.` +
        (blocked ? ` It has ledger activity (${activity.postings} posting(s), ${activity.callLines} capital-call line(s)), so the delete will be refused.` : ''),
      impact: { entity: { id: entity.entityId, name: entity.entityName, investor: entity.investorName ?? null }, ...activity },
    }
  },

  lp_delete_commitment: async (deps, input) => {
    const vehicle = await vehicleOf(input, deps.access, deps.admin, deps.fundId)
    const ev = await resolveCommitmentEvent(deps, vehicle, text(input.event_id, 'event_id'))
    const names = new Map<string, string>()
    const ids = [ev.lp_entity_id, ev.counterparty_entity_id].filter(Boolean)
    if (ids.length) {
      const { data } = await (deps.admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', deps.fundId).in('id', ids)
      for (const e of (data as any[]) ?? []) names.set(e.id, e.entity_name)
    }
    const lp = names.get(ev.lp_entity_id) ?? ev.lp_entity_id
    return {
      pin: { vehicle },
      summary: `Delete the ${ev.kind} commitment event of ${money(Number(ev.amount))} for ${lp} on ${ev.effective_date} (${vehicle})` +
        (ev.transfer_id ? `, and the other leg of its transfer with ${names.get(ev.counterparty_entity_id) ?? 'another partner'}` : '') +
        `. Reason: ${input.reason ?? 'none given'}`,
      impact: {
        event: { id: ev.id, lp, date: ev.effective_date, amount: Number(ev.amount), kind: ev.kind, memo: ev.memo ?? null },
        legsDeleted: ev.transfer_id ? 2 : 1,
      },
    }
  },

  lp_merge_entities: async (deps, input) => {
    const from = await resolveLpEntity(deps, text(input.from, 'from'))
    const into = await resolveLpEntity(deps, text(input.into, 'into'))
    if (from.entityId === into.entityId) throw new Error('Cannot merge an LP entity into itself')
    const activity = await entityLedgerActivity(deps.admin, deps.fundId, from.entityId)
    const { data: positions } = await (deps.admin as any).from('commitment_events').select('vehicle_id, lp_entity_id')
      .eq('fund_id', deps.fundId).in('lp_entity_id', [from.entityId, into.entityId])
    const vehiclesOf = (id: string) => new Set(((positions as any[]) ?? []).filter(p => p.lp_entity_id === id).map(p => p.vehicle_id as string))
    const fromVehicles = vehiclesOf(from.entityId)
    const intoVehicles = vehiclesOf(into.entityId)
    const shared = Array.from(fromVehicles).filter(v => intoVehicles.has(v))
    return {
      pin: { from: from.entityId, into: into.entityId },
      summary: `Merge LP entity ${from.entityName} into ${into.entityName}: its commitments in ${fromVehicles.size} vehicle${fromVehicles.size === 1 ? '' : 's'}, ` +
        `${activity.postings} capital posting${activity.postings === 1 ? '' : 's'} and ${activity.callLines} capital-call line${activity.callLines === 1 ? '' : 's'} move to ${into.entityName}, ` +
        `then ${from.entityName} is deleted. No balance changes.` +
        (shared.length ? ` Both hold commitments in ${shared.length} of the same vehicle${shared.length === 1 ? '' : 's'}; the merge may be refused there.` : ''),
      impact: { from: { id: from.entityId, name: from.entityName }, into: { id: into.entityId, name: into.entityName }, vehicles: fromVehicles.size, sharedVehicles: shared.length, ...activity },
    }
  },

  lp_merge_investors: async (deps, input) => {
    const from = await resolveInvestor(deps.admin, deps.fundId, text(input.from, 'from'))
    const into = await resolveInvestor(deps.admin, deps.fundId, text(input.into, 'into'))
    const { data: ents } = await (deps.admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', deps.fundId).eq('investor_id', from.id)
    const moving = ((ents as any[]) ?? []).map(e => e.entity_name as string)
    return {
      pin: { from: from.id, into: into.id },
      summary: `Merge LP investor ${from.name} into ${into.name}: ${moving.length} entit${moving.length === 1 ? 'y moves' : 'ies move'}` +
        `${moving.length ? ` (${moving.join(', ')})` : ''}, then ${from.name} is deleted.`,
      impact: { from, into, entitiesMoved: moving },
    }
  },

  diligence_delete_deal: async (deps, input) => {
    const deal = await resolveDeal(deps.admin, deps.fundId, text(input.deal, 'deal'), deps.access)
    const counts: Record<string, number | null> = {}
    for (const table of DILIGENCE_CASCADE_TABLES) counts[table] = await count(deps.admin, table, { fund_id: deps.fundId, deal_id: deal.id })
    const shown = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0).map(([t, n]) => `${n} ${t.replace(/^diligence_|^memo_agent_/, '').replace(/_/g, ' ')}`)
    return {
      pin: { deal: deal.id },
      summary: `Delete diligence deal ${deal.name} and everything in it${shown.length ? `: ${shown.join(', ')}` : ''}. Uploaded files stay in storage.`,
      impact: { deal: { id: deal.id, name: deal.name, status: deal.deal_status ?? null }, deleted: counts },
    }
  },

  remove_member: async (deps, input) => {
    const member = await resolveMember(deps.admin, deps.fundId, text(input.member, 'member'))
    const grants = await count(deps.admin, 'fund_member_vehicles', { fund_id: deps.fundId, user_id: member.userId })
    return {
      pin: { member: member.id },
      summary: `Remove ${member.email ?? member.userId} (${member.role}) from the fund, with ${grants ?? '?'} entity grant(s).` +
        (member.role === 'admin' ? ' They are an admin, so the removal will be refused.' : ''),
      impact: { member, entityGrants: grants },
    }
  },

  merge_vehicles: async (deps, input) => {
    const from = await resolveVehicleRow(deps.admin, deps.access, text(input.from, 'from'))
    const into = await resolveVehicleRow(deps.admin, deps.access, text(input.into, 'into'))
    const where = { fund_id: deps.fundId, vehicle_id: from.id }
    const [entries, accounts, bank] = await Promise.all([
      count(deps.admin, 'journal_entries', where), count(deps.admin, 'chart_of_accounts', where), count(deps.admin, 'bank_transactions', where),
    ])
    const books = (entries ?? 0) + (bank ?? 0)
    return {
      pin: { from: from.id, into: into.id },
      summary: `Merge entity ${from.name} into ${into.name}; ${from.name} is deleted and becomes an alias of ${into.name}.` +
        (books > 0 ? ` WARNING: ${from.name}'s own books are deleted with it: ${entries ?? 0} journal entr${entries === 1 ? 'y' : 'ies'} and ${bank ?? 0} bank row(s).` : ''),
      impact: { from, into, deletedWithSource: { journalEntries: entries, chartAccounts: accounts, bankTransactions: bank } },
    }
  },

  merge_companies: async (deps, input) => {
    const from = await resolveCompany(deps.admin, deps.fundId, text(input.from, 'from'), deps.access)
    const into = await resolveCompany(deps.admin, deps.fundId, text(input.into, 'into'), deps.access)
    if (from.id === into.id) throw new Error('Choose two different records to merge.')
    const where = { fund_id: deps.fundId, company_id: from.id }
    const [transactions, events, navs, terms, notes, documents, metrics] = await Promise.all([
      count(deps.admin, 'investment_transactions', where), count(deps.admin, 'fund_capital_events', where),
      count(deps.admin, 'fund_nav_statements', where), count(deps.admin, 'fund_holding_terms', where),
      count(deps.admin, 'company_notes', where), count(deps.admin, 'company_documents', where), count(deps.admin, 'metrics', where),
    ])
    const register = (events ?? 0) + (navs ?? 0) + (terms ?? 0)
    const kind = (c: any) => (c.holding_type === 'fund' ? 'fund holding' : c.holding_type === 'crypto' ? 'digital asset' : 'company')
    return {
      pin: { from: from.id, into: into.id },
      summary: `Merge ${kind(from)} ${from.name} into ${kind(into)} ${into.name}: move ${transactions ?? '?'} investment transaction(s) ` +
        `(re-derived on ${into.name}'s accounts), ${register} fund-register row(s), ${notes ?? '?'} note(s) and ${documents ?? '?'} ` +
        `document(s); ${from.name} becomes an alias of ${into.name} and is deleted, or kept empty if its accounts carry voided entries.` +
        (metrics ? ` Its ${metrics} metric(s) move too, except any ${into.name} already tracks under the same name.` : '') +
        (register && into.holding_type !== 'fund' ? ` ${into.name} is not a fund holding, so the merge will be refused.` : ''),
      impact: {
        from: { id: from.id, name: from.name, holdingType: from.holding_type ?? 'company' },
        into: { id: into.id, name: into.name, holdingType: into.holding_type ?? 'company' },
        investmentTransactions: transactions, capitalEvents: events, navStatements: navs, terms, notes, documents, metrics,
      },
    }
  },
}
