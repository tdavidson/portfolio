// The shadow: what the app itself holds for a vehicle and period, to compare a package with.
//
// Built from the vehicle's posted books (capital activity, cash, every account) and its portfolio
// tracker (the schedule of investments), through the same loader the financial statements use.
// For a vehicle the app keeps the books of, this is the books. For an admin-reported vehicle it is
// whatever the app holds, and never shown as the vehicle's figures. A part the app holds nothing
// for is null, so the check that needs it says so instead of comparing with zero.

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeCapitalAccounts } from '@/lib/accounting/capital-account'
import { accountBalances, normalBalance } from '@/lib/accounting/ledger'
import { fetchAllRows } from '@/lib/accounting/load'
import { computePayload, loadLedgerData, type LedgerData } from '@/lib/accounting/statement-package'
import { customPeriod } from '@/lib/accounting/statement-period'
import { openingCashBefore } from '@/lib/accounting/bank'
import type { Shadow, ShadowAccount, ShadowHolding, ShadowPartner } from './types'

const r2 = (n: number) => Math.round(n * 100) / 100

/** The shadow from already-loaded books. Pure, so the tests build it from fixtures. */
export function shadowFromLedger(
  data: Pick<LedgerData, 'accounts' | 'postings' | 'capitalPostings' | 'names'>,
  period: { start: string; end: string },
  holdings: ShadowHolding[] | null,
  bank: { amounts: { date: string; amount: number }[] } | null,
): Shadow {
  // Capital activity in the window, per partner.
  const hasCapital = data.capitalPostings.some(p => p.lpEntityId)
  let partners: ShadowPartner[] | null = null
  if (hasCapital) {
    const accounts = computeCapitalAccounts(data.capitalPostings, period)
    partners = Array.from(accounts.entries()).map(([id, a]) => ({
      lpEntityId: id,
      name: data.names.get(id) ?? id,
      contributions: r2(a.contributions),
      // The roll-forward carries distributions negative; a package states them positive.
      distributions: r2(-a.distributions) || 0,
    }))
  }

  const upTo = data.postings.filter(p => !p.entryDate || p.entryDate <= period.end)
  const within = upTo.filter(p => p.entryDate && p.entryDate >= period.start)
  const balance = accountBalances(upTo)
  const moved = accountBalances(within)
  const accounts: ShadowAccount[] = data.accounts.map(a => ({
    code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null,
    balance: normalBalance(a, balance.get(a.id) ?? 0),
    movement: normalBalance(a, moved.get(a.id) ?? 0),
  }))

  const cashAccounts = data.accounts.filter(a => a.subtype === 'cash')
  let cash: Shadow['cash'] = null
  if (cashAccounts.length) {
    const ledger = r2(cashAccounts.reduce((s, a) => s + normalBalance(a, balance.get(a.id) ?? 0), 0))
    let bankBalance: number | null = null
    let bankThrough: string | null = null
    const rows = (bank?.amounts ?? []).filter(t => t.date <= period.end)
    if (rows.length) {
      bankThrough = rows.reduce((m, t) => (t.date > m ? t.date : m), rows[0].date)
      // The feed reaches the period end only if it has activity in the period or after it.
      const reaches = (bank?.amounts ?? []).some(t => t.date >= period.start)
      if (reaches) {
        const main = cashAccounts.find(a => a.code === '1000') ?? cashAccounts[0]
        const opening = openingCashBefore(data.postings, main.id, rows.map(t => t.date))
        bankBalance = r2(opening + rows.reduce((s, t) => s + t.amount, 0))
      }
    }
    cash = { ledger, bank: bankBalance, bankThrough }
  }

  return { partners, cash, holdings, accounts: accounts.length ? accounts : null }
}

/** Load the vehicle's books, portfolio and bank feed, and build the shadow for the period. */
export async function loadShadow(
  admin: SupabaseClient, fundId: string, vehicle: { id: string; name: string }, period: { start: string; end: string },
): Promise<Shadow | null> {
  try {
    const data = await loadLedgerData(admin, fundId, vehicle.name)
    let holdings: ShadowHolding[] | null = null
    try {
      const payload = computePayload(data, customPeriod(period.start, period.end))
      const rows = payload.scheduleOfInvestments.source === 'tracker' ? payload.scheduleOfInvestments.rows : []
      holdings = rows.length
        ? rows.map(h => ({ companyId: h.companyId ?? h.name, name: h.name, cost: r2(h.cost), fairValue: r2(h.fairValue) }))
        : null
    } catch (e: any) {
      console.error('[statement-review-shadow-soi]', e?.message)
    }
    let bank: { amounts: { date: string; amount: number }[] } | null = null
    try {
      const rows = await fetchAllRows<any>((f, t) => (admin as any).from('bank_transactions')
        .select('id, txn_date, amount, status').eq('fund_id', fundId).eq('vehicle_id', vehicle.id).neq('status', 'ignored')
        .order('id').range(f, t))
      bank = { amounts: rows.map(t => ({ date: String(t.txn_date), amount: Number(t.amount) })) }
    } catch { /* no feed */ }
    return shadowFromLedger(data, period, holdings, bank)
  } catch (e: any) {
    console.error('[statement-review-shadow]', e?.message)
    return null
  }
}
