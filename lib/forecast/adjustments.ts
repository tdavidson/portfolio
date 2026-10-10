// Hand edits to a forecast, kept as inputs so a refresh never erases them.
//
// A plan's draft is rebuilt whole from its rules, overrides and sources on every save. A P&L amount
// is edited as a month override (the existing mechanism). Everything else a person changes — an
// exit that will come later than construction says, a distribution construction does not know
// about, an opening balance that will not settle — is an adjustment on the plan:
//
//   entries  entries a person added, balanced; one may name the generated entry it REPLACES
//   removed  keys of generated entries taken out
//
// Applied after compiling, so they sit on top of whatever the sources say today. A replaced or
// removed entry that the sources no longer generate (construction moved the exit) is reported, not
// silently dropped — the person's edit still stands, and they are told to check it.

import { roundCents } from '@/lib/accounting/ledger'
import type { Account } from '@/lib/accounting/types'
import type { CompiledEntry } from './compile'
import { isMonthKey, type MonthKey } from './months'

export interface ManualEntry {
  id: string
  /** YYYY-MM-DD. */
  date: string
  memo: string
  /** Signed, debit-positive, summing to zero. */
  postings: { accountId: string; amount: number }[]
  /** The key of the generated entry this one stands in for (entryKey). */
  replaces?: string | null
}

export interface Adjustments {
  entries: ManualEntry[]
  removed: string[]
}

export const NO_ADJUSTMENTS: Adjustments = { entries: [], removed: [] }

export class AdjustmentError extends Error {}

/**
 * A generated entry's identity across recompiles: where it came from, what it is, when, and its
 * description (which names the deal for a construction flow). Rule and override entries have none —
 * they are edited through their rule or a month override.
 */
export function entryKey(e: Pick<CompiledEntry, 'source' | 'kind' | 'entryDate' | 'memo'>): string | null {
  if (e.source !== 'construction' && e.source !== 'opening') return null
  return `${e.source}|${e.kind}|${e.entryDate}|${e.memo}`
}

/** Read and check a plan's stored (or submitted) adjustments against its chart. */
export function validateAdjustments(raw: unknown, accounts: Pick<Account, 'id'>[]): Adjustments {
  if (raw == null) return { entries: [], removed: [] }
  if (typeof raw !== 'object') throw new AdjustmentError('adjustments must be an object')
  const r = raw as Record<string, unknown>
  const ids = new Set(accounts.map(a => a.id))
  const entries: ManualEntry[] = []
  for (const e of (Array.isArray(r.entries) ? r.entries : []) as any[]) {
    const date = String(e?.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isMonthKey(date.slice(0, 7))) throw new AdjustmentError('Each entry needs a date (YYYY-MM-DD)')
    const memo = String(e?.memo ?? '').trim().slice(0, 300)
    if (!memo) throw new AdjustmentError('Each entry needs a description')
    const postings = ((Array.isArray(e?.postings) ? e.postings : []) as any[])
      .map(p => ({ accountId: String(p?.accountId ?? ''), amount: roundCents(Number(p?.amount)) }))
      .filter(p => p.amount !== 0)
    if (postings.length < 2) throw new AdjustmentError(`"${memo}" needs at least two lines`)
    for (const p of postings) {
      if (!ids.has(p.accountId)) throw new AdjustmentError(`"${memo}" names an account that is not in this chart`)
      if (!Number.isFinite(p.amount)) throw new AdjustmentError(`"${memo}" has an amount that is not a number`)
    }
    const off = roundCents(postings.reduce((s, p) => s + p.amount, 0))
    if (off !== 0) throw new AdjustmentError(`"${memo}" does not balance — debits and credits differ by ${off.toFixed(2)}`)
    entries.push({ id: String(e?.id || cryptoId()), date, memo, postings, replaces: e?.replaces ? String(e.replaces) : null })
  }
  const removed = [...new Set(((Array.isArray(r.removed) ? r.removed : []) as unknown[]).map(String).filter(Boolean))]
  return { entries, removed }
}

const cryptoId = () => (globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/** The month an entry falls in. */
const monthOfDate = (d: string) => d.slice(0, 7) as MonthKey

/**
 * Apply a plan's adjustments to its compiled entries: drop what was removed or replaced, add what
 * was entered by hand (inside the plan window), and say which edits no longer match anything.
 */
export function applyAdjustments(
  entries: CompiledEntry[],
  adj: Adjustments,
  window: { first: MonthKey; last: MonthKey },
  currency: string,
): { entries: CompiledEntry[]; warnings: string[] } {
  const generated = new Set(entries.map(entryKey).filter((k): k is string => !!k))
  const out = new Set([...adj.removed, ...adj.entries.map(e => e.replaces).filter((k): k is string => !!k)])
  const warnings: string[] = []
  for (const k of out) {
    if (!generated.has(k)) warnings.push(`An edited entry (${k.split('|')[3] ?? k}, ${k.split('|')[2] ?? ''}) is no longer generated by its source — check your change still makes sense`)
  }
  const kept = entries.filter(e => {
    const k = entryKey(e)
    return !k || !out.has(k)
  })
  const added: CompiledEntry[] = []
  for (const m of adj.entries) {
    const month = monthOfDate(m.date)
    if (month < window.first || month > window.last) continue
    const pnl = m.postings[0]
    added.push({
      entryDate: m.date,
      kind: 'recognition',
      memo: m.memo,
      accountId: pnl.accountId,
      ruleId: null,
      overrideId: null,
      source: 'manual',
      key: `manual|${m.id}`,
      postings: m.postings.map(p => ({ accountId: p.accountId, amount: p.amount, currency })),
    })
  }
  return { entries: [...kept, ...added].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.memo.localeCompare(b.memo)), warnings }
}

// ── Editing a cash figure ───────────────────────────────────────────────────────────────────────
//
// So a forecast can be changed without knowing the entries behind it: type what Distributions (or
// Investments, Exit proceeds, Capital contributions) should be in a month, and this writes the entry.
// That month's generated entries for the line are replaced by ONE hand entry carrying the new cash,
// shaped like the entry it replaces (scaled; an exit keeps its cost and the gain takes the rest), or,
// with nothing to copy, on the chart's standard accounts. Typing it again edits the same entry.

export type CashCategory = 'invested' | 'proceeds' | 'called' | 'distributed'

export const CASH_CATEGORY_KIND: Record<CashCategory, string> = {
  invested: 'investment', proceeds: 'proceeds', called: 'capital_call', distributed: 'distribution',
}

const CATEGORY_LABEL: Record<CashCategory, string> = {
  invested: 'Investments', proceeds: 'Exit proceeds', called: 'Capital contributions', distributed: 'Distributions',
}

export interface CellAccount { id: string; code: string; type: string; subtype?: string | null }
export interface CellEntry { date: string; kind: string; memo: string; source: string; key: string | null; postings: { accountId: string; amount: number }[] }

/** The hand entry a cash cell owns, so editing the cell again changes it rather than adding another. */
export const cellEntryId = (category: CashCategory, month: string) => `cell-${category}-${month}`

export function cashCellAdjustments(
  adj: Adjustments,
  input: { category: CashCategory; month: string; cash: number; entries: CellEntry[]; accounts: CellAccount[]; cashAccountIds: string[] },
): Adjustments {
  const { category, month } = input
  const cashIds = new Set(input.cashAccountIds)
  const id = cellEntryId(category, month)
  const kind = CASH_CATEGORY_KIND[category]
  const inMonth = (e: CellEntry) => e.date.slice(0, 7) === month && e.kind === kind
  const generated = input.entries.filter(e => inMonth(e) && e.key && e.source !== 'manual')
  // A hand entry is stored as kind 'recognition', so this cell's own earlier entry is found by its id.
  const template = generated[0] ?? input.entries.find(e => e.key === `manual|${id}`) ?? null
  const removed = [...new Set([...adj.removed, ...generated.map(e => e.key!)])]
  const others = adj.entries.filter(e => e.id !== id)
  const cash = roundCents(input.cash)
  const signed = category === 'invested' || category === 'distributed' ? -Math.abs(cash) : Math.abs(cash)
  if (signed === 0) return { entries: others, removed }

  const date = template?.date ?? lastDayOfMonth(month)
  let postings: { accountId: string; amount: number }[]
  if (template) {
    const cashLeg = template.postings.filter(p => cashIds.has(p.accountId)).reduce((s, p) => s + p.amount, 0)
    if (category === 'proceeds') {
      // The exit's cost stays; the gain (or loss) takes the difference.
      const gainId = template.postings.find(p => !cashIds.has(p.accountId) && isGain(input.accounts, p.accountId))?.accountId
      const fixed = template.postings.filter(p => !cashIds.has(p.accountId) && p.accountId !== gainId)
      const cashId = template.postings.find(p => cashIds.has(p.accountId))?.accountId ?? input.cashAccountIds[0]
      const rest = roundCents(-signed - fixed.reduce((s, p) => s + p.amount, 0))
      postings = [{ accountId: cashId, amount: signed }, ...fixed, ...(gainId ? [{ accountId: gainId, amount: rest }] : [])]
      if (!gainId && rest !== 0) postings = scale(template.postings, cashLeg, signed)
    } else {
      postings = scale(template.postings, cashLeg, signed)
    }
  } else {
    const pick = (...subtypes: string[]) => input.accounts.find(a => subtypes.includes(a.subtype ?? ''))?.id
    const cashId = input.cashAccountIds[0]
    const other = category === 'invested' ? pick('investment', 'investment_in_fund')
      : category === 'proceeds' ? pick('realized_gain', 'equity_method')
      : pick('lp_capital', 'members_capital')
    if (!cashId || !other) throw new AdjustmentError(`This chart has no account to book ${CATEGORY_LABEL[category].toLowerCase()} against`)
    postings = [{ accountId: cashId, amount: signed }, { accountId: other, amount: -signed }]
  }
  postings = postings.filter(p => p.amount !== 0)
  const memo = `${CATEGORY_LABEL[category]} — ${month} (your figure${generated.length ? `, replacing ${generated.length === 1 ? generated[0].memo : `${generated.length} entries`}` : ''})`
  return { entries: [...others, { id, date, memo, postings, replaces: null }], removed }
}

function scale(postings: { accountId: string; amount: number }[], fromCash: number, toCash: number) {
  if (fromCash === 0) return postings
  const f = toCash / fromCash
  const out = postings.map(p => ({ accountId: p.accountId, amount: roundCents(p.amount * f) }))
  // Rounding lands on the largest leg so the entry still balances to the cent.
  const drift = roundCents(out.reduce((s, p) => s + p.amount, 0))
  if (drift !== 0) {
    const i = out.reduce((best, p, j) => (Math.abs(p.amount) > Math.abs(out[best].amount) ? j : best), 0)
    out[i] = { ...out[i], amount: roundCents(out[i].amount - drift) }
  }
  return out
}

const isGain = (accounts: CellAccount[], id: string) => {
  const a = accounts.find(x => x.id === id)
  return !!a && a.type === 'income'
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
