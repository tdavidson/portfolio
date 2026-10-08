// Per-company investment accounts on a vehicle's chart (1100-/1150-/1200-/1250-/4000-<company>),
// and the ledger's view of each company's carrying value. Investment VALUE reaches these accounts
// only through investment transactions — derived (from-portfolio.ts) or adopted (adoption.ts). See
// plans/spec-ledger-one-writer.md.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger } from './load'
import { vehicleIdByName } from './vehicle-id'
import { accountBalances, roundCents } from './ledger'

const COST_CODE = '1100'
const UNREALIZED_CODE = '1200'
const FX_CODE = '1250'
// Realized gain PER COMPANY (income), mirroring the per-company unrealized mark (1200). An exit
// books its gain here rather than to the pooled 4000, so the ledger retains which deal produced
// which realized gain — needed for deal-by-deal (American) carry and per-deal performance.
const REALIZED_CODE = '4000'
// Interest a convertible note has EARNED but not been paid. Its own asset, per company, so it
// converts into that company's cost basis when the note converts — and so it never contaminates
// the 1100 cost tie-out against the tracker in the meantime.
const ACCRUED_INTEREST_CODE = '1150'

const short = (id: string) => id.slice(0, 8)
export const investmentCostCode = (companyId: string) => `${COST_CODE}-${short(companyId)}`
export const investmentUnrealizedCode = (companyId: string) => `${UNREALIZED_CODE}-${short(companyId)}`
export const investmentFxCode = (companyId: string) => `${FX_CODE}-${short(companyId)}`
export const investmentAccruedInterestCode = (companyId: string) => `${ACCRUED_INTEREST_CODE}-${short(companyId)}`
export const investmentRealizedCode = (companyId: string) => `${REALIZED_CODE}-${short(companyId)}`

export interface InvestmentAccounts {
  costId: string
  unrealizedId: string
  fxId: string
  /** Realized gain for this company (income). Absent on a chart seeded before per-company
   *  realized gains — exits then fall back to the pooled 4000. */
  realizedId?: string
  /** Accrued but unpaid note interest. Absent on a chart seeded before notes were supported. */
  accruedInterestId?: string
}

/**
 * Ensure each company has its cost and unrealized accounts on this vehicle's chart.
 * Idempotent — mirrors `ensureCapitalAccounts` for LPs.
 */
export async function ensureInvestmentAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  companies: { id: string; name: string }[]
): Promise<Map<string, InvestmentAccounts>> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  const { data: existing } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, company_id, subtype')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .not('company_id', 'is', null)

  const assign = (cur: Partial<InvestmentAccounts>, subtype: string, id: string) => {
    if (subtype === 'investment') cur.costId = id
    if (subtype === 'unrealized') cur.unrealizedId = id
    if (subtype === 'fx_translation') cur.fxId = id
    if (subtype === 'realized_gain') cur.realizedId = id
    if (subtype === 'accrued_interest') cur.accruedInterestId = id
  }

  const byCompany = new Map<string, Partial<InvestmentAccounts>>()
  for (const a of ((existing as any[]) ?? [])) {
    const cur = byCompany.get(a.company_id) ?? {}
    assign(cur, a.subtype, a.id)
    byCompany.set(a.company_id, cur)
  }

  // Additive: a company onboarded before FX accounts existed gets its 1250 backfilled
  // here rather than needing a migration.
  const rows: any[] = []
  for (const c of companies) {
    const cur = byCompany.get(c.id) ?? {}
    if (!cur.costId) {
      rows.push({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: investmentCostCode(c.id), name: `Investment — ${c.name}`,
        type: 'asset', subtype: 'investment', company_id: c.id,
      })
    }
    if (!cur.unrealizedId) {
      rows.push({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: investmentUnrealizedCode(c.id), name: `Unrealized — ${c.name}`,
        type: 'asset', subtype: 'unrealized', company_id: c.id,
      })
    }
    if (!cur.fxId) {
      rows.push({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: investmentFxCode(c.id), name: `FX translation — ${c.name}`,
        type: 'asset', subtype: 'fx_translation', company_id: c.id,
      })
    }
    if (!cur.accruedInterestId) {
      rows.push({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: investmentAccruedInterestCode(c.id), name: `Accrued interest — ${c.name}`,
        type: 'asset', subtype: 'accrued_interest', company_id: c.id,
      })
    }
    if (!cur.realizedId) {
      rows.push({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: investmentRealizedCode(c.id), name: `Realized gain — ${c.name}`,
        type: 'income', subtype: 'realized_gain', company_id: c.id,
      })
    }
  }

  if (rows.length > 0) {
    const { data: created, error } = await admin
      .from('chart_of_accounts' as any)
      .insert(rows)
      .select('id, company_id, subtype')
    if (error) throw new Error(error.message)
    for (const a of ((created as any[]) ?? [])) {
      const cur = byCompany.get(a.company_id) ?? {}
      assign(cur, a.subtype, a.id)
      byCompany.set(a.company_id, cur)
    }
  }

  const out = new Map<string, InvestmentAccounts>()
  for (const c of companies) {
    const cur = byCompany.get(c.id)
    if (cur?.costId && cur?.unrealizedId && cur?.fxId) {
      out.set(c.id, { costId: cur.costId, unrealizedId: cur.unrealizedId, fxId: cur.fxId, realizedId: cur.realizedId, accruedInterestId: cur.accruedInterestId })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Reading the ledger per company
// ---------------------------------------------------------------------------

export interface CompanyLedger {
  companyId: string
  cost: number
  /** The mark: what the position did in its OWN currency. */
  unrealized: number
  /** What the exchange rate did to it. Always 0 for a USD position. */
  fxTranslation: number
  /** cost + unrealized + fxTranslation — what the balance sheet carries. */
  carrying: number
}

/** Ledger cost, mark, and FX per company, from the per-investment accounts. */
export async function ledgerByCompany(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, CompanyLedger>> {
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group)
  const bal = accountBalances(postings)

  const out = new Map<string, CompanyLedger>()
  for (const a of accounts) {
    const companyId = (a as any).companyId as string | undefined
    if (!companyId) continue
    // `unrealized` and `fx_translation` are subtypes on BOTH an asset (1200/1250) and an
    // income account (4200/4300). Only the asset side is the position's carrying value.
    if (a.type !== 'asset') continue
    const cur = out.get(companyId) ?? { companyId, cost: 0, unrealized: 0, fxTranslation: 0, carrying: 0 }
    const amount = roundCents(bal.get(a.id) ?? 0)
    if (a.subtype === 'investment') cur.cost = roundCents(cur.cost + amount)
    if (a.subtype === 'unrealized') cur.unrealized = roundCents(cur.unrealized + amount)
    if (a.subtype === 'fx_translation') cur.fxTranslation = roundCents(cur.fxTranslation + amount)
    cur.carrying = roundCents(cur.cost + cur.unrealized + cur.fxTranslation)
    out.set(companyId, cur)
  }
  return out
}
