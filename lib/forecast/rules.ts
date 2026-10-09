// Account rules: how one account's monthly amount is produced.
//
// Every evaluator returns amounts on the account's NORMAL side — revenue and expense both
// positive — because that is how a person states a budget ("$12,000 of tax prep"). The
// compiler turns them into signed, balanced postings; nothing here knows about debits.
//
// A month with no amount is absent from the result, not zero. "We don't know" and "nothing
// happens" are different answers, and only the rule can say which one it means.

import { roundCents } from '@/lib/accounting/ledger'
import { addMonths, isMonthKey, monthDiff, parseMonth, type MonthKey } from './months'

export type RuleMethod =
  | 'manual'
  | 'fixed'
  | 'recurring'
  | 'run_rate'
  | 'growth'
  | 'linked_fee'
  | 'linked_construction'

export const RULE_METHODS: RuleMethod[] = ['manual', 'fixed', 'recurring', 'run_rate', 'growth', 'linked_fee', 'linked_construction']

/** Methods the engine can evaluate today. Linked drivers arrive with their source mappings. */
export const SUPPORTED_METHODS: RuleMethod[] = RULE_METHODS

/** Methods whose amounts come from another part of the app, supplied by the service, not evaluated here. */
export const LINKED_METHODS: RuleMethod[] = ['linked_fee', 'linked_construction']

export interface LinkedFeeParams {
  /** Only this managed fund (by name). Omitted on a manco = every linked fund; on a fund = its link. */
  fundVehicle?: string
}

export interface LinkedConstructionParams {
  /** Which of the construction model's operating flows this account carries. */
  flow: 'fees' | 'expenses'
}

export interface ManualParams {
  amounts: Record<MonthKey, number>
}

export interface FixedParams {
  amount: number
  /** First and last month the amount applies (inclusive). Open-ended when omitted. */
  start?: MonthKey
  end?: MonthKey
}

export interface RecurringParams {
  amount: number
  /** 1 = monthly, 3 = quarterly, 6 = semiannual, 12 = annual. */
  everyMonths: number
  /** A month the charge lands in; the cadence runs forwards and backwards from it. */
  anchor: MonthKey
  start?: MonthKey
  end?: MonthKey
  /** Increase applied once per full year after the anchor, e.g. 0.03. */
  annualEscalation?: number
  /** Occurrences to skip. */
  exceptions?: MonthKey[]
  /** Additional one-off amounts, added on top of any regular occurrence. */
  oneOffs?: { month: MonthKey; amount: number }[]
}

export interface RunRateParams {
  /** Trailing closed months to average. */
  window?: 3 | 6 | 12
  /** A custom history window instead of the trailing one. */
  from?: MonthKey
  to?: MonthKey
  /** Count actual months that are not closed yet. Off by default: an open month is not final. */
  includeUnclosed?: boolean
}

export interface GrowthParams {
  /** The amount in `baseMonth`. */
  base: number
  baseMonth: MonthKey
  /** Rate per `per`, e.g. 0.05. */
  rate: number
  /** 'month' compounds every month; 'year' steps once every 12 months from baseMonth. */
  per: 'month' | 'year'
}

export interface RuleInput {
  method: RuleMethod
  params: unknown
}

export interface HistoryContext {
  /** Actual natural-side activity for this account by month. Months with no postings are absent. */
  actuals: ReadonlyMap<MonthKey, number>
  /**
   * The closed span of the books. Months before `closedFrom` predate the books (missing, not
   * zero); months after `closedThrough` are open. Null when nothing is closed.
   */
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
  /** Last month of actuals the plan uses. */
  cutoff: MonthKey | null
}

export interface RuleResult {
  amounts: Map<MonthKey, number>
  /** Human-readable account of what the numbers rest on — shown on drill-down. */
  basis: string
  warnings: string[]
}

export class RuleError extends Error {}

const num = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RuleError(`${field} must be a number`)
  return v
}

const month = (v: unknown, field: string): MonthKey => {
  if (!isMonthKey(v)) throw new RuleError(`${field} must be a month (YYYY-MM)`)
  return v
}

const optMonth = (v: unknown, field: string): MonthKey | undefined => (v == null ? undefined : month(v, field))

const obj = (p: unknown): Record<string, unknown> => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RuleError('params must be an object')
  return p as Record<string, unknown>
}

/**
 * Validate and normalise a rule's params. Throws RuleError with the field at fault. This is
 * the one validator — routes, MCP tools and staged Analyst actions all call it.
 */
export function validateRule(method: unknown, raw: unknown): RuleInput {
  if (typeof method !== 'string' || !RULE_METHODS.includes(method as RuleMethod)) {
    throw new RuleError(`method must be one of ${RULE_METHODS.join(', ')}`)
  }
  const m = method as RuleMethod
  if (!SUPPORTED_METHODS.includes(m)) throw new RuleError(`${m} is not available yet`)
  const p = obj(raw)
  switch (m) {
    case 'manual': {
      const amounts = obj(p.amounts ?? {})
      const out: Record<MonthKey, number> = {}
      for (const [k, v] of Object.entries(amounts)) out[month(k, 'amounts key')] = roundCents(num(v, `amounts.${k}`))
      return { method: m, params: { amounts: out } satisfies ManualParams }
    }
    case 'fixed': {
      const params: FixedParams = {
        amount: roundCents(num(p.amount, 'amount')),
        start: optMonth(p.start, 'start'),
        end: optMonth(p.end, 'end'),
      }
      if (params.start && params.end && params.start > params.end) throw new RuleError('start is after end')
      return { method: m, params }
    }
    case 'recurring': {
      const every = num(p.everyMonths, 'everyMonths')
      if (!Number.isInteger(every) || every < 1 || every > 120) throw new RuleError('everyMonths must be a whole number from 1 to 120')
      const esc = p.annualEscalation == null ? undefined : num(p.annualEscalation, 'annualEscalation')
      if (esc != null && (esc <= -1 || esc > 10)) throw new RuleError('annualEscalation is out of range')
      const exceptions = Array.isArray(p.exceptions) ? p.exceptions.map((e, i) => month(e, `exceptions[${i}]`)) : undefined
      const oneOffs = Array.isArray(p.oneOffs)
        ? p.oneOffs.map((o, i) => {
            const oo = obj(o)
            return { month: month(oo.month, `oneOffs[${i}].month`), amount: roundCents(num(oo.amount, `oneOffs[${i}].amount`)) }
          })
        : undefined
      const params: RecurringParams = {
        amount: roundCents(num(p.amount, 'amount')),
        everyMonths: every,
        anchor: month(p.anchor, 'anchor'),
        start: optMonth(p.start, 'start'),
        end: optMonth(p.end, 'end'),
        annualEscalation: esc,
        exceptions,
        oneOffs,
      }
      if (params.start && params.end && params.start > params.end) throw new RuleError('start is after end')
      return { method: m, params }
    }
    case 'run_rate': {
      const hasCustom = p.from != null || p.to != null
      const params: RunRateParams = { includeUnclosed: p.includeUnclosed === true }
      if (hasCustom) {
        params.from = month(p.from, 'from')
        params.to = month(p.to, 'to')
        if (params.from > params.to) throw new RuleError('from is after to')
      } else {
        const w = p.window ?? 12
        if (w !== 3 && w !== 6 && w !== 12) throw new RuleError('window must be 3, 6 or 12')
        params.window = w
      }
      return { method: m, params }
    }
    case 'linked_fee': {
      const params: LinkedFeeParams = {}
      if (p.fundVehicle != null) {
        if (typeof p.fundVehicle !== 'string' || !p.fundVehicle.trim()) throw new RuleError('fundVehicle must be a vehicle name')
        params.fundVehicle = p.fundVehicle.trim()
      }
      return { method: m, params }
    }
    case 'linked_construction': {
      if (p.flow !== 'fees' && p.flow !== 'expenses') throw new RuleError("flow must be 'fees' or 'expenses'")
      return { method: m, params: { flow: p.flow } satisfies LinkedConstructionParams }
    }
    case 'growth': {
      if (p.per !== 'month' && p.per !== 'year') throw new RuleError("per must be 'month' or 'year'")
      const rate = num(p.rate, 'rate')
      if (rate <= -1 || rate > 10) throw new RuleError('rate is out of range')
      const params: GrowthParams = {
        base: roundCents(num(p.base, 'base')),
        baseMonth: month(p.baseMonth, 'baseMonth'),
        rate,
        per: p.per,
      }
      return { method: m, params }
    }
    default:
      throw new RuleError(`${m} is not available yet`)
  }
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

const inWindow = (m: MonthKey, start?: MonthKey, end?: MonthKey) => (!start || m >= start) && (!end || m <= end)

/** Evaluate a validated rule over the target months. */
export function evaluateRule(rule: RuleInput, months: MonthKey[], history: HistoryContext): RuleResult {
  const amounts = new Map<MonthKey, number>()
  const warnings: string[] = []

  switch (rule.method) {
    case 'manual': {
      const p = rule.params as ManualParams
      for (const m of months) if (p.amounts[m] != null) amounts.set(m, p.amounts[m])
      return { amounts, basis: 'Entered by month', warnings }
    }

    case 'fixed': {
      const p = rule.params as FixedParams
      for (const m of months) if (inWindow(m, p.start, p.end)) amounts.set(m, p.amount)
      return { amounts, basis: `${fmt(p.amount)} every month`, warnings }
    }

    case 'recurring': {
      const p = rule.params as RecurringParams
      const skip = new Set(p.exceptions ?? [])
      for (const m of months) {
        if (!inWindow(m, p.start, p.end)) continue
        const offset = monthDiff(p.anchor, m)
        let amount = 0
        if (offset % p.everyMonths === 0 && !skip.has(m)) {
          const years = Math.floor(offset / 12)
          amount = p.amount * Math.pow(1 + (p.annualEscalation ?? 0), Math.max(0, years))
        }
        for (const o of p.oneOffs ?? []) if (o.month === m) amount += o.amount
        if (amount !== 0) amounts.set(m, roundCents(amount))
      }
      const { month: anchorMonth } = parseMonth(p.anchor)
      const cadence = p.everyMonths === 1 ? 'every month' : p.everyMonths === 12 ? 'every year' : `every ${p.everyMonths} months`
      const esc = p.annualEscalation ? `, +${fmt(p.annualEscalation * 100)}%/yr` : ''
      return {
        amounts,
        basis: `${fmt(p.amount)} ${cadence} from ${p.anchor} (month ${anchorMonth})${esc}`,
        warnings,
      }
    }

    case 'run_rate': {
      const p = rule.params as RunRateParams
      const last = history.cutoff
      if (!last) {
        return { amounts, basis: 'Run rate — no actuals', warnings: ['No actuals before the cutoff to average'] }
      }
      const from = p.from ?? addMonths(last, -((p.window ?? 12) - 1))
      const to = p.to ?? last
      const eligible: MonthKey[] = []
      const excluded: MonthKey[] = []
      for (let m = from; m <= to; m = addMonths(m, 1)) {
        if (m > last) break
        if (history.closedFrom != null && m < history.closedFrom) continue
        const closed = history.closedThrough != null && m <= history.closedThrough
        if (closed || p.includeUnclosed) eligible.push(m)
        else excluded.push(m)
      }
      if (excluded.length > 0) {
        warnings.push(`Left out ${excluded.length} unclosed month${excluded.length === 1 ? '' : 's'} (${excluded[0]}${excluded.length > 1 ? `–${excluded[excluded.length - 1]}` : ''})`)
      }
      if (eligible.length === 0) {
        warnings.push('No eligible months to average')
        return { amounts, basis: `Run rate over ${from}–${to} — nothing eligible`, warnings }
      }
      const expected = monthDiff(from, to) + 1
      if (eligible.length < expected) warnings.push(`Averaged ${eligible.length} of ${expected} months`)
      // A closed month with no postings to this account is a real zero — the books for it are final.
      const total = eligible.reduce((s, m) => s + (history.actuals.get(m) ?? 0), 0)
      const avg = roundCents(total / eligible.length)
      for (const m of months) amounts.set(m, avg)
      return {
        amounts,
        basis: `Average of ${eligible.length} month${eligible.length === 1 ? '' : 's'} ${eligible[0]}–${eligible[eligible.length - 1]}: ${fmt(avg)}/mo`,
        warnings,
      }
    }

    case 'growth': {
      const p = rule.params as GrowthParams
      for (const m of months) {
        const d = monthDiff(p.baseMonth, m)
        if (d < 0) continue
        const steps = p.per === 'month' ? d : Math.floor(d / 12)
        amounts.set(m, roundCents(p.base * Math.pow(1 + p.rate, steps)))
      }
      return {
        amounts,
        basis: `${fmt(p.base)} in ${p.baseMonth}, +${fmt(p.rate * 100)}% per ${p.per}`,
        warnings,
      }
    }

    default:
      // Linked methods are evaluated by the service from their sources (lib/forecast/linked.ts).
      return { amounts, basis: rule.method, warnings: [`${rule.method} has no linked source loaded`] }
  }
}
