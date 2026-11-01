// Handlers for the HOLDING agent tools (./holding-tools-manifest.ts). Each resolves names with the
// caller's access, then calls the same lib function the holding pages' routes use where there is
// one, so a refusal is worded once.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { companyChangeFromInput, setHoldingType, updateCompanyDetails } from '@/lib/companies/holding-edit'
import { saveNavStatement } from '@/lib/portfolio/fof-nav'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
import { noticeChangesFrom, recalculateFundDistributions, recordFundNotice, setFundTerms, TERM_FIELDS, updateFundNotice } from '@/lib/portfolio/fund-register-write'
import { moveInvestmentTransaction } from '@/lib/portfolio/transaction-edit'
import { unwrap } from '@/lib/service-outcome'
import { resolveCompany } from './portfolio-tools'

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))

/** The entity a register row belongs to: the one named, else the one the holding already uses. */
async function holdingVehicle(ctx: AgentToolContext, companyId: string, vehicle: unknown): Promise<string> {
  let requested: string | undefined
  if (typeof vehicle === 'string' && vehicle.trim()) {
    const id = await vehicleIdByName(ctx.admin, ctx.fundId, vehicle.trim())
    if (!id) throw new Error(`No entity named "${vehicle}".`)
    requested = id
  }
  const resolved = await resolveHoldingVehicle(ctx.admin, ctx.fundId, companyId, requested, ctx.access)
  if ('error' in resolved) throw new Error(resolved.error)
  return resolved.vehicleId
}

function needUser(ctx: AgentToolContext): string {
  if (!ctx.userId) throw new Error('This change needs a person behind the credential.')
  return ctx.userId
}

export const HOLDING_HANDLERS: Record<string, AgentToolHandler> = {
  update_company: async (ctx: AgentToolContext, input: any) => {
    const company = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    const vehicleNames = (await entityScopeFor(ctx.admin, ctx.access)).writableNames
    return unwrap(await updateCompanyDetails(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null, vehicleNames }, company.id, companyChangeFromInput(input)))
  },

  set_holding_type: async (ctx: AgentToolContext, input: any) => {
    const company = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    return unwrap(await setHoldingType(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null }, company.id, input?.holding_type))
  },

  move_investment: async (ctx: AgentToolContext, input: any) => {
    if (!input?.transaction_id) throw new Error('transaction_id is required (list_investments gives it)')
    const from = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    const to = await resolveCompany(ctx.admin, ctx.fundId, String(input?.to_company ?? ''), ctx.access)
    const vehicleNames = (await entityScopeFor(ctx.admin, ctx.access)).writableNames
    const out = unwrap(await moveInvestmentTransaction(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null, vehicleNames }, from.id, String(input.transaction_id), to.id))
    return { moved: input.transaction_id, from: out.from, to: out.to, transaction: out.transaction, ledger: out.ledger }
  },

  set_fund_terms: async (ctx: AgentToolContext, input: any) => {
    const holding = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    const vehicleId = await holdingVehicle(ctx, holding.id, input?.vehicle)
    // The tool's snake_case names to the register's fields.
    const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
    const fields: Record<string, unknown> = {}
    for (const key of Object.keys(TERM_FIELDS)) {
      if (input?.[snake(key)] !== undefined) fields[key] = input[snake(key)]
    }
    return unwrap(await setFundTerms(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null }, holding.id, vehicleId, fields))
  },

  record_fund_notice: async (ctx: AgentToolContext, input: any) => {
    const userId = needUser(ctx)
    const holding = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    const vehicleId = await holdingVehicle(ctx, holding.id, input?.vehicle)
    const out = unwrap(await recordFundNotice(ctx.admin, { fundId: ctx.fundId, userId }, {
      companyId: holding.id,
      vehicleId,
      kind: input?.kind,
      eventDate: String(input?.event_date ?? ''),
      amount: Number(input?.amount),
      dueDate: input?.due_date ?? null,
      noticeNumber: input?.notice_number ?? null,
      description: input?.description ?? null,
      purposeInvestments: num(input?.purpose_investments),
      purposeFees: num(input?.purpose_fees),
      purposeExpenses: num(input?.purpose_expenses),
      charReturnOfCapital: num(input?.char_return_of_capital),
      charRealizedGain: num(input?.char_realized_gain),
      charIncome: num(input?.char_income),
      recallableAmount: num(input?.recallable_amount),
      transactionId: typeof input?.transaction_id === 'string' && input.transaction_id ? input.transaction_id : null,
    }))
    return { holding: holding.name, ...out }
  },

  update_fund_notice: async (ctx: AgentToolContext, input: any) => {
    const holding = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    let eventId = typeof input?.event_id === 'string' && input.event_id ? input.event_id : null
    if (!eventId && typeof input?.transaction_id === 'string' && input.transaction_id) {
      const { data, error } = await (ctx.admin as any).from('fund_capital_events').select('id')
        .eq('fund_id', ctx.fundId).eq('company_id', holding.id).eq('investment_transaction_id', input.transaction_id).limit(1)
      if (error) throw new Error(error.message)
      eventId = (data as any[])?.[0]?.id ?? null
      if (!eventId) throw new Error(`No notice on ${holding.name} owns transaction ${input.transaction_id}.`)
    }
    if (!eventId) throw new Error('event_id or transaction_id is required.')
    const vehicleNames = (await entityScopeFor(ctx.admin, ctx.access)).writableNames
    const out = unwrap(await updateFundNotice(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null, vehicleNames },
      holding.id, eventId, noticeChangesFrom(input), { recalculateCharacter: input?.recalculate_character === true }))
    return { holding: holding.name, ...out }
  },

  recalculate_fund_distributions: async (ctx: AgentToolContext, input: any) => {
    const holding = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    const vehicleId = await holdingVehicle(ctx, holding.id, input?.vehicle)
    const vehicleNames = (await entityScopeFor(ctx.admin, ctx.access)).writableNames
    return unwrap(await recalculateFundDistributions(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId ?? null, vehicleNames },
      holding.id, vehicleId, { dryRun: input?.dry_run === true }))
  },

  record_nav_statement: async (ctx: AgentToolContext, input: any) => {
    const holding = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    if (holding.holding_type !== 'fund') {
      throw new Error(`${holding.name} is not a fund holding, so it has no NAV statements. Make it one with set_holding_type first.`)
    }
    const vehicleId = await holdingVehicle(ctx, holding.id, input?.vehicle)
    const result = await saveNavStatement(ctx.admin, ctx.fundId, ctx.userId ?? null, {
      companyId: holding.id,
      vehicleId,
      asOfDate: String(input?.as_of_date ?? ''),
      reportedNav: Number(input?.reported_nav),
      ...(input?.basis !== undefined ? { basis: input.basis } : {}),
      ...(input?.received_date !== undefined ? { receivedDate: input.received_date } : {}),
      ...(input?.reported_contributions !== undefined ? { reportedContributions: num(input.reported_contributions) ?? null } : {}),
      ...(input?.reported_distributions !== undefined ? { reportedDistributions: num(input.reported_distributions) ?? null } : {}),
      ...(input?.reported_unfunded !== undefined ? { reportedUnfunded: num(input.reported_unfunded) ?? null } : {}),
      source: 'manual',
    })
    if (!result.ok) throw new Error(result.error)
    return { holding: holding.name, ...result }
  },
}
