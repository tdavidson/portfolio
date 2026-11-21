// The shared arithmetic of the checks: comparing a stated figure with what it should be, and turning
// the difference into a finding of the right severity. Pure.

import type { CapitalFigures, CheckId, Citation, Finding, Materiality } from './types'
import { ALLOCATION_KEYS, ROUNDING_TOLERANCE } from './types'

export interface CheckContext {
  /** Differences above this are errors; at or under it (and over the rounding tolerance), info. */
  threshold: number
}

export function contextFor(materiality: Materiality, nav: number | null): CheckContext {
  const share = nav != null && Number.isFinite(nav) ? Math.abs(nav) * Math.max(0, materiality.navShare) : 0
  return { threshold: Math.max(0, materiality.amount, share) }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** An amount as a statement prints it: 1,250.00, and (1,250.00) for a negative. */
export function fmt(n: number): string {
  const r = round2(n)
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return r < 0 ? `(${s})` : s
}

/**
 * The rounding a figure may carry. One stated figure: a cent. A figure made by adding `terms`
 * rounded figures: half a cent for each, since every one of them was rounded on its own.
 */
export function tolerance(terms = 1): number {
  return Math.max(ROUNDING_TOLERANCE, 0.005 * terms)
}

export function compare(ctx: CheckContext, args: {
  check: CheckId
  subject: Finding['subject']
  stated: number
  expected: number
  /** How many rounded figures went into `expected`. */
  terms?: number
  /** One sentence, given the stated and expected figures already formatted. */
  message: (stated: string, expected: string, difference: string) => string
  cites?: Citation[]
}): Finding | null {
  const difference = round2(args.stated - args.expected)
  if (Math.abs(difference) <= tolerance(args.terms)) return null
  return {
    check: args.check,
    severity: Math.abs(difference) > ctx.threshold ? 'error' : 'info',
    subject: args.subject,
    stated: round2(args.stated),
    expected: round2(args.expected),
    difference,
    message: args.message(fmt(args.stated), fmt(args.expected), fmt(difference)),
    cites: args.cites ?? [],
    status: 'open',
  }
}

/** The net allocation: the stated total where there is one, else the sum of the parts. Null when neither. */
export function netAllocation(f: CapitalFigures): { value: number; terms: number; stated: boolean } | null {
  const a = f.allocations
  if (!a) return null
  if (a.total != null) return { value: a.total, terms: 1, stated: true }
  const parts = ALLOCATION_KEYS.map(k => a[k]).filter((v): v is number => v != null)
  if (parts.length === 0) return null
  return { value: parts.reduce((s, v) => s + v, 0), terms: parts.length, stated: false }
}

/** The citations a package gives for some of a figure set's fields. */
export function citesFor(f: { cite?: Record<string, Citation> } | undefined, fields: string[]): Citation[] {
  if (!f?.cite) return []
  const out: Citation[] = []
  for (const k of fields) if (f.cite[k]) out.push(f.cite[k])
  return out
}

export const FIELD_LABELS: Record<string, string> = {
  commitment: 'commitment',
  beginning: 'beginning capital',
  contributions: 'contributions',
  distributions: 'distributions',
  ending: 'ending capital',
  unfunded: 'unfunded commitment',
  paidInToDate: 'paid-in to date',
  distributedToDate: 'distributions to date',
  'allocations.income': 'income allocated',
  'allocations.expenses': 'expenses allocated',
  'allocations.managementFee': 'management fee',
  'allocations.realized': 'realized gain',
  'allocations.unrealized': 'unrealized gain',
  'allocations.carry': 'carried interest',
  'allocations.total': 'net allocation',
}

/** A field of a figure set by its dotted name (`ending`, `allocations.carry`). */
export function fieldValue(f: CapitalFigures, field: string): number | undefined {
  if (field.startsWith('allocations.')) return f.allocations?.[field.slice(12) as keyof NonNullable<CapitalFigures['allocations']>]
  return (f as Record<string, unknown>)[field] as number | undefined
}

/** Every summable field: the capital fields and each allocation. */
export const SUMMABLE_FIELDS = [
  'commitment', 'beginning', 'contributions', 'distributions', 'ending', 'unfunded', 'paidInToDate', 'distributedToDate',
  ...ALLOCATION_KEYS.map(k => `allocations.${k}`), 'allocations.total',
] as const
