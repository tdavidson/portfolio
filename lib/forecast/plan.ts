// One plan, compiled: window → rule amounts → overrides → balanced entries.
//
// Pure. The service loads the rows and hands them in; everything that decides a number is here,
// so the route, the MCP tool and the Analyst action cannot disagree about one.

import type { Account, Posting } from '@/lib/accounting/types'
import { roundCents } from '@/lib/accounting/ledger'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { addMonths, firstDay, lastDay, monthKey, monthOf, monthRange, type MonthKey } from './months'
import { evaluateRule, type RuleInput } from './rules'
import { assertEntryBalanced, compileForecast, counterAccountsFor, type CashTiming, type CompiledEntry, type CompileLine } from './compile'
import type { MonthlyConstruction } from './construction-adapter'
import type { GpShareSchedule } from './linked'

export type PlanKind = 'budget' | 'rolling_forecast'

export interface PlanRuleRow {
  id: string
  accountId: string
  rule: RuleInput
  cashTiming: CashTiming
}

export interface PlanOverrideRow {
  id: string
  accountId: string
  month: MonthKey
  amount: number
}

export interface PlanWindowInput {
  kind: PlanKind
  fiscalYear: number | null
  startMonth: MonthKey
  endMonth: MonthKey
  horizonMonths: number | null
  cutoff: MonthKey | null
}

/**
 * The months a plan's entries may fall in. A budget is its fiscal year whatever the actuals say.
 * A rolling forecast starts the month after the cutoff; with a horizon it rolls forward as the
 * cutoff does, otherwise it ends at its fixed end month.
 */
export function planWindow(p: PlanWindowInput): { first: MonthKey; last: MonthKey } {
  if (p.kind === 'budget') {
    const y = p.fiscalYear ?? Number(p.startMonth.slice(0, 4))
    return { first: monthKey(y, 1), last: monthKey(y, 12) }
  }
  const first = p.cutoff ? addMonths(p.cutoff, 1) : p.startMonth
  const last = p.horizonMonths ? addMonths(first, p.horizonMonths - 1) : p.endMonth
  return { first, last }
}

export interface BuildPlanInput extends PlanWindowInput {
  vehicleKind: string
  accounts: Account[]
  /** Posted actuals through the cutoff, dated. */
  actuals: Posting[]
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
  rules: PlanRuleRow[]
  overrides: PlanOverrideRow[]
  currency: string
  /**
   * Settle payables and receivables that already exist in the actuals when the plan starts, this
   * many months in (1 = the first plan month). 0 leaves them on the balance sheet.
   */
  openingSettlementMonths?: number
  /**
   * Amounts for linked rules, by rule id, loaded by the service from their sources — one driver per
   * source (a manco's fee rule has one per linked fund). Each carries its own cash timing.
   */
  linked?: Map<string, LinkedDriver[]>
  /** A fund's monthly construction schedule, when the plan includes its investment flows. */
  construction?: MonthlyConstruction | null
  /** A GP entity's share of its fund's forecast (lib/forecast/linked.ts gpShareOf). */
  gpShare?: GpShareSchedule | null
}

export interface LinkedDriver {
  amounts: Map<MonthKey, number>
  /** Overrides the rule's own cash timing (a fee link's billing cycle). */
  timing?: CashTiming
  basis: string
  warnings: string[]
}

export interface RuleOutcome {
  ruleId: string
  accountId: string
  basis: string
  warnings: string[]
}

export interface BuiltPlan {
  first: MonthKey
  last: MonthKey
  entries: CompiledEntry[]
  rules: RuleOutcome[]
  /** Plan-level problems (no cash account, unknown accounts). */
  warnings: string[]
}

/** Natural-side monthly actuals per P&L account. */
export function actualsByAccount(accounts: Account[], postings: Posting[]): Map<string, Map<MonthKey, number>> {
  const types = new Map(accounts.map(a => [a.id, a.type]))
  const out = new Map<string, Map<MonthKey, number>>()
  for (const p of postings) {
    const t = types.get(p.accountId)
    if ((t !== 'income' && t !== 'expense') || !p.entryDate) continue
    const m = monthOf(p.entryDate)
    const natural = t === 'income' ? -p.amount : p.amount
    const byMonth = out.get(p.accountId) ?? new Map<MonthKey, number>()
    byMonth.set(m, (byMonth.get(m) ?? 0) + natural)
    out.set(p.accountId, byMonth)
  }
  return out
}

export function buildPlan(input: BuildPlanInput): BuiltPlan {
  const { first, last } = planWindow(input)
  const months = monthRange(first, last)
  const warnings: string[] = []
  const byId = new Map(input.accounts.map(a => [a.id, a]))
  const counters = counterAccountsFor(input.vehicleKind, input.accounts)
  if (!counters) {
    return { first, last, entries: [], rules: [], warnings: ['This vehicle has no cash account, so nothing can be forecast'] }
  }

  const history = actualsByAccount(input.accounts, input.actuals)
  const overridesByAccount = new Map<string, PlanOverrideRow[]>()
  for (const o of input.overrides) {
    const list = overridesByAccount.get(o.accountId) ?? []
    list.push(o)
    overridesByAccount.set(o.accountId, list)
  }

  const outcomes: RuleOutcome[] = []
  const lines: CompileLine[] = []
  const seen = new Set<string>()
  for (const r of input.rules) {
    const account = byId.get(r.accountId)
    if (!account) {
      warnings.push(`A rule names an account that is no longer in this chart (${r.accountId})`)
      continue
    }
    seen.add(r.accountId)
    const ovs = overridesByAccount.get(r.accountId) ?? []
    if (r.rule.method === 'linked_fee' || r.rule.method === 'linked_construction') {
      const drivers = input.linked?.get(r.id) ?? []
      if (!drivers.length) {
        outcomes.push({ ruleId: r.id, accountId: r.accountId, basis: r.rule.method, warnings: ['No linked source — nothing is forecast for this account'] })
        continue
      }
      drivers.forEach((d, i) => {
        const amounts = new Map<MonthKey, { amount: number; overrideId?: string | null }>([...d.amounts].map(([m, amount]) => [m, { amount }]))
        // An override replaces the account's whole month: it lands on the first driver, the rest go to zero.
        for (const o of ovs) amounts.set(o.month, i === 0 ? { amount: o.amount, overrideId: o.id } : { amount: 0 })
        lines.push({ account, ruleId: r.id, amounts, timing: d.timing ?? r.cashTiming })
      })
      outcomes.push({ ruleId: r.id, accountId: r.accountId, basis: drivers.map(d => d.basis).join('; '), warnings: drivers.flatMap(d => d.warnings) })
      continue
    }
    const res = evaluateRule(r.rule, months, {
      actuals: history.get(r.accountId) ?? new Map(),
      closedFrom: input.closedFrom,
      closedThrough: input.closedThrough,
      cutoff: input.cutoff,
    })
    const amounts = new Map<MonthKey, { amount: number; overrideId?: string | null }>(
      [...res.amounts].map(([m, amount]) => [m, { amount }]),
    )
    for (const o of ovs) amounts.set(o.month, { amount: o.amount, overrideId: o.id })
    outcomes.push({ ruleId: r.id, accountId: r.accountId, basis: res.basis, warnings: res.warnings })
    lines.push({ account, ruleId: r.id, amounts, timing: r.cashTiming })
  }
  // Construction's fees and expenses, on the plan's management-fee and partnership-expense
  // accounts, when the plan includes construction and the account has no rule of its own. A rule
  // always wins — it is what someone decided for that account (a prepaid fee, a known invoice) —
  // and is told what construction would have said, so a gap between the two is visible.
  if (input.construction) {
    const fromConstruction = (flow: 'fees' | 'expenses', subtypes: string[], label: string) => {
      const account = input.accounts
        .filter(a => a.type === 'expense' && subtypes.includes(a.subtype ?? '') && !a.lpEntityId && !a.companyId)
        .sort((a, b) => a.code.localeCompare(b.code))[0]
      if (!account) return
      const amounts = new Map<MonthKey, { amount: number; overrideId?: string | null }>()
      for (const e of input.construction!.events) {
        if (e.flow !== flow || e.month < first || e.month > last) continue
        amounts.set(e.month, { amount: roundCents((amounts.get(e.month)?.amount ?? 0) + e.amount) })
      }
      const total = roundCents([...amounts.values()].reduce((s, v) => s + v.amount, 0))
      if (seen.has(account.id)) {
        const o = outcomes.find(x => x.accountId === account.id)
        if (o && total) o.warnings.push(`Portfolio construction has ${total.toLocaleString('en-US')} of ${label} in this window; this account's own rule is used instead`)
        return
      }
      if (!total) return
      seen.add(account.id)
      for (const ov of overridesByAccount.get(account.id) ?? []) amounts.set(ov.month, { amount: ov.amount, overrideId: ov.id })
      lines.push({ account, ruleId: null, amounts, timing: { mode: 'same' } as CashTiming })
      outcomes.push({ ruleId: `construction:${flow}`, accountId: account.id, basis: `Portfolio construction ${label}, spread evenly within each construction year`, warnings: [] })
    }
    fromConstruction('fees', ['management_fee'], 'management fees')
    fromConstruction('expenses', ['partnership_expense', 'operating_expense'], 'partnership expenses')
  }

  // An override on an account with no rule still counts — the month was typed in on purpose.
  for (const [accountId, list] of overridesByAccount) {
    if (seen.has(accountId)) continue
    const account = byId.get(accountId)
    if (!account) continue
    lines.push({
      account,
      ruleId: null,
      amounts: new Map(list.map(o => [o.month, { amount: o.amount, overrideId: o.id }])),
      timing: { mode: 'same' } as CashTiming,
    })
  }

  const compiled = compileForecast(lines, { firstMonth: first, lastMonth: last, currency: input.currency, counters })
  for (const o of outcomes) o.warnings.push(...(compiled.warnings.get(o.accountId) ?? []))

  const opening = openingSettlements(input, first, last, counters.cash)
  warnings.push(...opening.warnings)
  const construction = input.construction ? constructionEntries(input, input.construction, first, last, counters.cash) : { entries: [], warnings: [] }
  warnings.push(...construction.warnings)
  const gp = input.gpShare ? gpShareEntries(input, input.gpShare, first, last, counters.cash) : { entries: [], warnings: [] }
  warnings.push(...gp.warnings)
  for (const e of [...opening.entries, ...construction.entries, ...gp.entries]) assertEntryBalanced(e)
  const entries = [...compiled.entries, ...opening.entries, ...construction.entries, ...gp.entries].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.memo.localeCompare(b.memo))
  return { first, last, entries, rules: outcomes, warnings }
}

/** Liabilities that clear to cash in the ordinary course: bills, accruals, payroll owed. */
const PAYABLE_SUBTYPES = new Set(['accrued', 'accounts_payable', 'accrued_compensation', 'payroll_liability'])

/**
 * The payables and receivables standing in the actuals the day before the plan starts. Rules only
 * settle what the plan itself recognises, so without this an accrual booked in the last closed
 * month would never be paid in the forecast — cash would run high by exactly the open payables.
 * Prepaid and deferred balances are left alone: their release belongs to a P&L line the rule for
 * that account already forecasts in full.
 */
export function openingSettlements(
  input: Pick<BuildPlanInput, 'accounts' | 'actuals' | 'vehicleKind' | 'currency' | 'openingSettlementMonths'>,
  first: MonthKey,
  last: MonthKey,
  cashId: string,
): { entries: CompiledEntry[]; warnings: string[] } {
  const n = input.openingSettlementMonths ?? 1
  const open = firstDay(first)
  const balances = new Map<string, number>()
  for (const p of input.actuals) {
    if (!p.entryDate || p.entryDate >= open) continue
    balances.set(p.accountId, (balances.get(p.accountId) ?? 0) + p.amount)
  }
  const settleable = input.accounts.filter(a =>
    !a.lpEntityId && !a.companyId && (
      (a.type === 'liability' && PAYABLE_SUBTYPES.has(a.subtype ?? '')) ||
      // A fund's only receivable is 1300 Due from LPs — capital, not trade — so only a manco's counts.
      (a.type === 'asset' && a.subtype === 'receivable' && input.vehicleKind === MANCO_KIND)
    ),
  )
  const entries: CompiledEntry[] = []
  const warnings: string[] = []
  const fmt = (x: number) => Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 2 })
  for (const a of settleable) {
    const bal = roundCents(balances.get(a.id) ?? 0)
    if (bal === 0) continue
    if (n === 0) {
      warnings.push(`${a.code} ${a.name}: ${fmt(bal)} open at the start is not forecast to settle`)
      continue
    }
    const month = addMonths(first, n - 1)
    if (month > last) {
      warnings.push(`${a.code} ${a.name}: ${fmt(bal)} open at the start settles after the plan ends`)
      continue
    }
    // Clear the balance into cash: the account takes the opposite of its balance.
    entries.push({
      entryDate: lastDay(month),
      kind: 'settlement',
      memo: `${a.code} ${a.name} — opening balance ${a.type === 'liability' ? 'paid' : 'collected'} ${month}`,
      accountId: a.id,
      ruleId: null,
      overrideId: null,
      source: 'opening',
      postings: [
        { accountId: a.id, amount: roundCents(-bal), currency: input.currency },
        { accountId: cashId, amount: bal, currency: input.currency },
      ],
    })
  }
  return { entries, warnings }
}

/**
 * A fund's investment and capital flows from construction, as balanced entries. Fees and expenses
 * are NOT here — they reach the plan as P&L lines (buildPlan's fromConstruction, or a
 * linked_construction / linked_fee rule), one per account, so a plan can never carry construction's
 * fees twice.
 *
 *   investment    Dr investments at cost      / Cr cash
 *   proceeds      Dr cash                     / Cr investments at cost (the deal's cost) / Cr realized gain
 *   capital call  Dr cash                     / Cr LP capital
 *   distribution  Dr LP capital               / Cr cash
 *
 * Capital calls and distributions are capital, not revenue or expense, and never touch the P&L.
 * Distributions are construction's GROSS figures (before the GP's carry split) — what leaves the
 * fund's bank account.
 */
export function constructionEntries(
  input: Pick<BuildPlanInput, 'accounts' | 'currency'>,
  mc: MonthlyConstruction,
  first: MonthKey,
  last: MonthKey,
  cashId: string,
): { entries: CompiledEntry[]; warnings: string[] } {
  const find = (subtype: string) =>
    input.accounts.filter(a => a.subtype === subtype && !a.lpEntityId && !a.companyId).sort((a, b) => a.code.localeCompare(b.code))[0]
  const inv = find('investment')
  const gain = find('realized_gain')
  const capital = find('lp_capital')
  const warnings: string[] = []
  const missing = [!inv && 'investments at cost', !gain && 'realized gain', !capital && 'LP capital'].filter(Boolean)
  if (missing.length) {
    return { entries: [], warnings: [`Construction flows need ${missing.join(', ')} account${missing.length === 1 ? '' : 's'} in this chart; none are forecast`] }
  }
  const entries: CompiledEntry[] = []
  let before = 0
  let after = 0
  const c = input.currency
  for (const e of mc.events) {
    if (e.flow === 'fees' || e.flow === 'expenses') continue
    if (e.month < first) { before++; continue }
    if (e.month > last) { after++; continue }
    const date = lastDay(e.month)
    const label = e.deal ? ` — ${e.deal}` : ''
    const base = { entryDate: date, ruleId: null, overrideId: null, source: 'construction' as const }
    const a = roundCents(e.amount)
    switch (e.flow) {
      case 'invested':
        entries.push({ ...base, kind: 'investment', accountId: inv!.id, memo: `Investment${label} (${e.timing})`, postings: [
          { accountId: inv!.id, amount: a, currency: c }, { accountId: cashId, amount: -a, currency: c },
        ] })
        break
      case 'proceeds': {
        const cost = roundCents(e.cost ?? 0)
        entries.push({ ...base, kind: 'proceeds', accountId: gain!.id, memo: `Exit proceeds${label} (${e.timing})`, postings: [
          { accountId: cashId, amount: a, currency: c },
          { accountId: inv!.id, amount: -cost, currency: c },
          { accountId: gain!.id, amount: roundCents(cost - a), currency: c },
        ].filter(p => p.amount !== 0) })
        break
      }
      case 'called':
        entries.push({ ...base, kind: 'capital_call', accountId: capital!.id, memo: 'Capital call (construction, inferred month)', postings: [
          { accountId: cashId, amount: a, currency: c }, { accountId: capital!.id, amount: -a, currency: c },
        ] })
        break
      case 'distributed':
        entries.push({ ...base, kind: 'distribution', accountId: capital!.id, memo: 'Distribution (construction, gross of carry)', postings: [
          { accountId: capital!.id, amount: a, currency: c }, { accountId: cashId, amount: -a, currency: c },
        ] })
        break
    }
  }
  if (before) warnings.push(`${before} construction flow${before === 1 ? '' : 's'} fall before the plan starts and are not included`)
  if (after) warnings.push(`${after} construction flow${after === 1 ? '' : 's'} fall after the plan ends`)
  if (mc.asOfMonth > first) warnings.push(`Construction runs from ${mc.asOfMonth}; months before it carry no investment flows`)
  warnings.push(...mc.warnings)
  return { entries, warnings }
}

/**
 * A GP entity's flows from the fund it is GP of, as balanced entries on the GP entity's own chart:
 *
 *   its share of a call          Dr Investment in Fund (cost)          / Cr cash
 *   its share of a distribution  Dr cash / Cr Investment in Fund — as a return of its cost while
 *                                any remains, then Cr Equity in earnings of Fund for the rest
 *   its carry                    Dr cash / Cr Carried interest income
 *
 * The cost it starts from is Investment in Fund on the books at the plan's start, so a distribution
 * that returns more than was put in shows the excess as earnings, not as a negative investment.
 */
export function gpShareEntries(
  input: Pick<BuildPlanInput, 'accounts' | 'currency' | 'actuals'>,
  share: GpShareSchedule,
  first: MonthKey,
  last: MonthKey,
  cashId: string,
): { entries: CompiledEntry[]; warnings: string[] } {
  const find = (subtype: string, type?: string) =>
    input.accounts.filter(a => a.subtype === subtype && (!type || a.type === type) && !a.lpEntityId && !a.companyId).sort((a, b) => a.code.localeCompare(b.code))[0]
  const inv = find('investment_in_fund')
  const earnings = find('equity_method', 'income')
  const carryIncome = find('carried_interest', 'income')
  const missing = [!inv && 'Investment in Fund', !earnings && 'Equity in earnings of Fund', !carryIncome && 'Carried interest income'].filter(Boolean)
  if (missing.length) return { entries: [], warnings: [`A GP entity's share of its fund needs ${missing.join(', ')} in its chart; none is forecast`] }

  const c = input.currency
  let cost = roundCents(input.actuals.filter(p => p.accountId === inv!.id && (p.entryDate ?? '') < `${first}-01`).reduce((s, p) => s + p.amount, 0))
  const entries: CompiledEntry[] = []
  for (const [month, f] of [...share.months].sort(([a], [b]) => a.localeCompare(b))) {
    if (month < first || month > last) {
      if (month < first) cost = roundCents(cost + f.called)
      continue
    }
    const base = { entryDate: lastDay(month), ruleId: null, overrideId: null, source: 'construction' as const }
    if (f.called > 0) {
      entries.push({ ...base, kind: 'capital_call', accountId: inv!.id, memo: `Capital call — share of ${share.fund}`, postings: [
        { accountId: inv!.id, amount: f.called, currency: c }, { accountId: cashId, amount: -f.called, currency: c },
      ] })
      cost = roundCents(cost + f.called)
    }
    if (f.distributed > 0) {
      const returned = roundCents(Math.min(f.distributed, Math.max(0, cost)))
      const gain = roundCents(f.distributed - returned)
      cost = roundCents(cost - returned)
      entries.push({ ...base, kind: 'distribution', accountId: earnings!.id, memo: `Distribution — share of ${share.fund}`, postings: [
        { accountId: cashId, amount: f.distributed, currency: c },
        { accountId: inv!.id, amount: -returned, currency: c },
        { accountId: earnings!.id, amount: -gain, currency: c },
      ].filter(p => p.amount !== 0) })
    }
    if (f.carry > 0) {
      entries.push({ ...base, kind: 'proceeds', accountId: carryIncome!.id, memo: `Carried interest — ${share.fund}`, postings: [
        { accountId: cashId, amount: f.carry, currency: c }, { accountId: carryIncome!.id, amount: -f.carry, currency: c },
      ] })
    }
  }
  return { entries, warnings: [] }
}
