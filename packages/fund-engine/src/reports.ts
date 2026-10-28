// The engine's reports over plain-text books: statements (trial balance, roll-forward, NAV, carry
// accrual) and a distribution's waterfall split, as JSON or a readable table. The CLI prints these;
// a close bundle stores the statements JSON so it can be recomputed.

import { parseLedgerText } from './text-ledger.ts'
import { booksFromText } from './books.ts'
import { trialBalance } from './trial-balance.ts'
import {
  ACTIVITY_FIELDS,
  CAPITAL_ACCOUNT_LABELS,
  computeCapitalAccounts,
  emptyAccount,
  rollForwardTies,
  totalNav,
  type CapitalAccount,
} from './capital-account.ts'
import { carryAccrual, carryFreeIds } from './carry.ts'
import { carryAccrualInputs, distributionSplitInputs } from './economics.ts'
import { splitDistribution, suggestedCharacter } from './distribution-waterfall.ts'
import { runWaterfall, type CarryStep, type WaterfallState } from './waterfall.ts'
import { waterfallTermsOf } from './replay.ts'
import { allocateAmount } from './allocation.ts'
import { roundCents } from './ledger.ts'
import type { VehicleTerms } from './terms-file.ts'

function lastDate(dates: string[]): string | null {
  return dates.length === 0 ? null : dates.reduce((a, b) => (b > a ? b : a))
}

function sortedObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)))
}

// ---------------------------------------------------------------------------------------------
// statements

export interface StatementsReport {
  vehicle: string | null
  asOf: string
  from: string | null
  entries: { included: number; skippedDrafts: number; skippedAfterAsOf: number }
  currencies: string[]
  trialBalance: {
    rows: { code: string; name: string; type: string; debit: number; credit: number; balance: number }[]
    totalDebits: number
    totalCredits: number
    balanced: boolean
  }
  partners: {
    id: string
    name: string
    account: string | null
    commitment: number | null
    carryRecipient: boolean
    capitalAccount: CapitalAccount
    ties: boolean
  }[]
  nav: number
  checks: {
    trialBalanceBalanced: boolean
    everyRollForwardTies: boolean
    /** Σ partner ending capital = the partner capital accounts' balance in the trial balance. */
    navTiesToLedger: boolean
    ledgerPartnerCapital: number
  }
  carry: null | {
    kind: string
    carryRate: number
    prefRate: number
    catchupRate: number
    catchupSize: number
    prefCompounds: boolean
    prefBase: string
    prefMultiple?: number
    prefDayCount?: string
    catchupMeasure?: string
    carrySteps?: CarryStep[]
    capitalIncludes?: string[]
    /** The GP commit bears carry: the recipients are in `perPartner` too, on both sides. */
    gpCommitBearsCarry?: boolean
    target: number
    alreadyAccrued: number
    delta: number
    perPartner: Record<string, number>
  }
  warnings: string[]
}

export function statementsReport(
  ledgerText: string,
  terms: VehicleTerms,
  opts: { asOf?: string | null; from?: string | null; includeDrafts?: boolean } = {},
): StatementsReport {
  const parsed = parseLedgerText(ledgerText)
  if (parsed.errors.length > 0) throw new Error(`The ledger has ${parsed.errors.length} error(s):\n  ${parsed.errors.join('\n  ')}`)
  return statementsFromEntries(parsed.entries, terms, opts)
}

export function statementsFromEntries(
  entries: ReturnType<typeof parseLedgerText>['entries'],
  terms: VehicleTerms,
  opts: { asOf?: string | null; from?: string | null; includeDrafts?: boolean },
): StatementsReport {
  const warnings: string[] = []
  const considered = entries.filter(e => e.flag === '*' || opts.includeDrafts)
  const asOf = opts.asOf ?? lastDate(considered.map(e => e.date))
  if (!asOf) throw new Error('The ledger has no posted entries; pass --as-of, or --include-drafts to count drafts')
  const from = opts.from ?? null
  if (from && from > asOf) throw new Error('--from is after --as-of')

  const books = booksFromText(entries, {
    asOf,
    includeDrafts: opts.includeDrafts,
    capitalAccountPattern: terms.capitalAccountPattern,
    partners: terms.partners,
  })
  if (books.currencies.length > 1) {
    warnings.push(`The ledger has postings in ${books.currencies.join(', ')}; the roll-forward sums them as one currency, as the app's capital account does.`)
  }
  for (const name of books.unknownRoots) warnings.push(`Account ${name} has no recognised root (Assets, Liabilities, Equity, Income, Expenses); treated as an asset.`)
  if (books.skippedDrafts > 0) warnings.push(`${books.skippedDrafts} draft entr${books.skippedDrafts === 1 ? 'y was' : 'ies were'} left out; pass --include-drafts to count them.`)

  const tb = trialBalance(books.accounts, books.postings)
  const accountById = new Map(books.accounts.map(a => [a.id, a]))
  const ledgerPartnerCapital = roundCents(
    tb.rows.filter(r => accountById.get(r.accountId)?.lpEntityId).reduce((s, r) => s + r.balance, 0),
  )

  const capital = computeCapitalAccounts(books.capitalPostings, { start: from, end: asOf })
  const termsById = new Map(terms.partners.map(p => [p.id, p]))
  const accountByPartner = new Map(Array.from(books.partnerByAccount.entries()).map(([code, id]) => [id, code]))
  const recipientIds = new Set(terms.carry.recipients.map(r => r.lpEntityId))

  const ids = new Set<string>([...Array.from(capital.keys()), ...terms.partners.map(p => p.id)])
  const partners = Array.from(ids).sort().map(id => {
    const t = termsById.get(id)
    const account = accountByPartner.get(id) ?? t?.account ?? null
    const capitalAccount = capital.get(id) ?? emptyAccount()
    return {
      id,
      name: t?.name ?? (account ? books.accountNames.get(account) ?? id : id),
      account,
      commitment: t?.commitment ?? null,
      carryRecipient: recipientIds.has(id),
      capitalAccount,
      ties: rollForwardTies(capitalAccount),
    }
  })
  for (const r of terms.carry.recipients) {
    if (!ids.has(r.lpEntityId)) warnings.push(`Carry recipient ${r.lpEntityId} has no capital account in the ledger and is not listed in partners.`)
  }

  const nav = totalNav(capital)

  let carry: StatementsReport['carry'] = null
  const t = terms.carry
  if (t.kind !== 'none' && t.carryRate > 0) {
    if (t.recipients.length === 0) {
      warnings.push('Carry terms are set but no recipient is named, so no carry accrual is computed (the close refuses the same way).')
    } else {
      const inputs = carryAccrualInputs(books.capitalPostings, t.recipients, asOf, t.gpCommitBearsCarry)
      const accrual = inputs.lps.length === 0
        ? { target: 0, alreadyAccrued: inputs.alreadyAccrued, delta: 0, perLp: new Map<string, number>() }
        : carryAccrual({ lps: inputs.lps, contributions: inputs.contributions, distributions: inputs.distributions, asOf }, t, inputs.alreadyAccrued, inputs.bearing)
      carry = {
        kind: t.kind,
        carryRate: t.carryRate,
        prefRate: t.prefRate,
        catchupRate: t.catchupRate,
        catchupSize: t.catchupSize ?? 1,
        prefCompounds: t.prefCompounds,
        prefBase: t.prefBase ?? 'contributed',
        ...(t.prefMultiple != null ? { prefMultiple: t.prefMultiple } : {}),
        ...(t.prefDayCount === '30/360' ? { prefDayCount: t.prefDayCount } : {}),
        ...(t.catchupMeasure === 'profit' ? { catchupMeasure: t.catchupMeasure } : {}),
        ...(t.carrySteps?.length ? { carrySteps: t.carrySteps } : {}),
        ...(t.capitalIncludes ? { capitalIncludes: t.capitalIncludes } : {}),
        ...(t.gpCommitBearsCarry ? { gpCommitBearsCarry: true } : {}),
        target: accrual.target,
        alreadyAccrued: accrual.alreadyAccrued,
        delta: accrual.delta,
        perPartner: sortedObject(accrual.perLp),
      }
    }
  }

  return {
    vehicle: terms.vehicle ?? null,
    asOf,
    from,
    entries: { included: books.included, skippedDrafts: books.skippedDrafts, skippedAfterAsOf: books.skippedAfterAsOf },
    currencies: books.currencies,
    trialBalance: {
      rows: tb.rows.map(r => ({ code: r.code, name: r.name, type: r.type, debit: r.debit, credit: r.credit, balance: r.balance })),
      totalDebits: tb.totalDebits,
      totalCredits: tb.totalCredits,
      balanced: tb.balanced,
    },
    partners,
    nav,
    checks: {
      trialBalanceBalanced: tb.balanced,
      everyRollForwardTies: partners.every(p => p.ties),
      // Only meaningful for an inception-to-date view: a period statement's `beginning` is still
      // part of `ending`, so it ties either way.
      navTiesToLedger: Math.abs(roundCents(nav - ledgerPartnerCapital)) < 0.005,
      ledgerPartnerCapital,
    },
    carry,
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// waterfall

export interface WaterfallReport {
  vehicle: string | null
  asOf: string | null
  amount: number
  method: string
  source: 'ledger' | 'terms-state'
  tiers: {
    returnOfCapital: number
    preferred: number
    catchUp: number
    catchUpToLP?: number
    carry: number
    profitToLP: number
    toLP: number
    toGP: number
  }
  lines: { partner: string; name: string; amount: number }[]
  carryLines: { partner: string; name: string; amount: number }[]
  suggestedCharacter: { returnOfCapital: number; realizedGain: number; income: number }
  stateBefore: WaterfallState
  stateAfter: WaterfallState
  warnings: string[]
}

export function waterfallReport(
  terms: VehicleTerms,
  amount: number,
  opts: { ledgerText?: string | null; asOf?: string | null } = {},
): WaterfallReport {
  const total = roundCents(amount)
  const nameOf = (id: string) => terms.partners.find(p => p.id === id)?.name ?? id

  if (opts.ledgerText != null) {
    const parsed = parseLedgerText(opts.ledgerText)
    if (parsed.errors.length > 0) throw new Error(`The ledger has ${parsed.errors.length} error(s):\n  ${parsed.errors.join('\n  ')}`)
    const asOf = opts.asOf ?? lastDate(parsed.entries.filter(e => e.flag === '*').map(e => e.date))
    if (!asOf) throw new Error('The ledger has no posted entries; pass --as-of')
    const books = booksFromText(parsed.entries, { asOf, capitalAccountPattern: terms.capitalAccountPattern, partners: terms.partners })
    const accountNames = new Map(Array.from(books.partnerByAccount.entries()).map(([code, id]) => [id, books.accountNames.get(code) ?? id]))
    const label = (id: string) => terms.partners.find(p => p.id === id)?.name ?? accountNames.get(id) ?? id

    const inputs = distributionSplitInputs(books.capitalPostings, terms.carry.recipients, asOf, terms.carry.gpCommitBearsCarry)
    const split = splitDistribution({
      total,
      terms: terms.carry,
      partners: inputs.partners,
      contributions: inputs.contributions,
      priors: inputs.priors,
      asOf,
      carryPaidToDate: terms.carry.recipients.length > 0 ? inputs.carryPaidToDate : undefined,
      realizedCapital: terms.realizedCapital,
    })
    return {
      vehicle: terms.vehicle ?? null,
      asOf,
      amount: total,
      method: split.method,
      source: 'ledger',
      tiers: split.tiers,
      lines: split.lines.map(l => ({ partner: l.lpEntityId, name: label(l.lpEntityId), amount: l.amount })),
      carryLines: split.carryLines.map(l => ({ partner: l.lpEntityId, name: label(l.lpEntityId), amount: l.amount })),
      suggestedCharacter: suggestedCharacter(split.tiers, total),
      stateBefore: split.stateBefore,
      stateAfter: split.stateAfter,
      warnings: split.warnings,
    }
  }

  // No ledger: run the waterfall once from the terms file's cumulative state.
  const warnings: string[] = []
  const t = terms.carry
  const zero: WaterfallState = { contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0, gpCatchUpPaid: 0 }
  const stateIn: WaterfallState = terms.state ?? zero
  if (!terms.state) warnings.push('No "state" in the terms file and no --ledger: the waterfall starts from zero contributed capital, so every dollar is profit.')
  const noCarry = t.kind === 'none' || t.carryRate <= 0
  const state: WaterfallState = t.kind === 'straight' ? { ...stateIn, preferredTarget: 0 } : stateIn
  const result = noCarry
    ? { toReturnOfCapital: 0, toPreferred: 0, toCatchUp: 0, toCatchUpLP: 0, toCarryGP: 0, toCarryLP: 0, toLP: total, toGP: 0, state }
    : runWaterfall(total, waterfallTermsOf(t), state)
  const tiers = {
    returnOfCapital: result.toReturnOfCapital,
    preferred: result.toPreferred,
    catchUp: result.toCatchUp,
    catchUpToLP: result.toCatchUpLP,
    carry: result.toCarryGP,
    profitToLP: result.toCarryLP,
    toLP: result.toLP,
    toGP: result.toGP,
  }

  // LP lines pro-rata by commitment — the only basis a terms file has. A GP commit that bears
  // carry is one of them.
  const carryFree = carryFreeIds(t)
  const lps = terms.partners.filter(p => !carryFree.has(p.id) && (p.commitment ?? 0) > 0)
  if (lps.length === 0 && tiers.toLP > 0) warnings.push('No partner with a commitment in the terms file, so the LP share is not split by partner.')
  const lines = lps.length === 0 || tiers.toLP <= 0 ? [] : Array.from(
    allocateAmount(tiers.toLP, lps.map(p => ({ lpEntityId: p.id, commitment: p.commitment ?? 0 }))).entries(),
  ).map(([id, amt]) => ({ partner: id, name: nameOf(id), amount: amt })).filter(l => l.amount > 0)

  const carryLines: WaterfallReport['carryLines'] = []
  if (tiers.toGP > 0) {
    if (t.recipients.length === 0) warnings.push('The GP share is not split: no carry recipient is named.')
    let allocated = 0
    t.recipients.forEach((r, i) => {
      const amt = i === t.recipients.length - 1 ? roundCents(tiers.toGP - allocated) : roundCents((tiers.toGP * r.pct) / 100)
      allocated = roundCents(allocated + amt)
      if (amt > 0) carryLines.push({ partner: r.lpEntityId, name: nameOf(r.lpEntityId), amount: amt })
    })
  }

  return {
    vehicle: terms.vehicle ?? null,
    asOf: opts.asOf ?? null,
    amount: total,
    method: noCarry ? 'pro_rata' : 'waterfall',
    source: 'terms-state',
    tiers,
    lines,
    carryLines,
    suggestedCharacter: suggestedCharacter(tiers, total),
    stateBefore: state,
    stateAfter: result.state,
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// table output

function money(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `(${s})` : s
}

function table(header: string[], rows: string[][], numericFrom = 1): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
  const fmt = (r: string[]) => r.map((c, i) => (i >= numericFrom ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ')
  return [fmt(header), widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n')
}

export function statementsTable(r: StatementsReport): string {
  const out: string[] = []
  out.push(`${r.vehicle ?? 'Vehicle'} — statements as of ${r.asOf}${r.from ? ` (period from ${r.from})` : ''}`)
  out.push(`${r.entries.included} entries included`)
  out.push('')
  out.push('Trial balance')
  out.push(table(['Code', 'Account', 'Debit', 'Credit'], [
    ...r.trialBalance.rows.map(x => [x.code, x.name, x.debit ? money(x.debit) : '', x.credit ? money(x.credit) : '']),
    ['', 'Total', money(r.trialBalance.totalDebits), money(r.trialBalance.totalCredits)],
  ], 2))
  out.push('')
  out.push("Partners' capital roll-forward")
  const fields: (keyof CapitalAccount)[] = ['beginning', ...ACTIVITY_FIELDS, 'ending']
  const used = fields.filter(f => f === 'beginning' || f === 'ending' || r.partners.some(p => p.capitalAccount[f] !== 0))
  out.push(table(['', ...r.partners.map(p => p.name), 'Total'], used.map(f => [
    CAPITAL_ACCOUNT_LABELS[f],
    ...r.partners.map(p => money(p.capitalAccount[f])),
    money(roundCents(r.partners.reduce((s, p) => s + p.capitalAccount[f], 0))),
  ])))
  out.push('')
  out.push(`NAV: ${money(r.nav)}`)
  out.push(`Trial balance balances: ${r.checks.trialBalanceBalanced ? 'yes' : 'NO'}`)
  out.push(`Every roll-forward ties: ${r.checks.everyRollForwardTies ? 'yes' : 'NO'}`)
  out.push(`NAV ties to partner capital in the ledger (${money(r.checks.ledgerPartnerCapital)}): ${r.checks.navTiesToLedger ? 'yes' : 'NO'}`)
  if (r.carry) {
    out.push('')
    out.push(`Carried interest (${r.carry.kind}, ${r.carry.carryRate * 100}% carry, ${r.carry.prefRate * 100}% pref) — hypothetical liquidation at ${r.asOf}`)
    out.push(table(['', 'Amount'], [
      ['Target entitlement', money(r.carry.target)],
      ['Already accrued', money(r.carry.alreadyAccrued)],
      ['To post', money(r.carry.delta)],
      ...Object.entries(r.carry.perPartner).map(([id, amt]) => [`  charged to ${r.partners.find(p => p.id === id)?.name ?? id}`, money(amt)]),
    ]))
  }
  if (r.warnings.length) { out.push(''); out.push('Warnings:'); for (const w of r.warnings) out.push(`  - ${w}`) }
  return out.join('\n') + '\n'
}

export function waterfallTable(r: WaterfallReport): string {
  const out: string[] = []
  out.push(`${r.vehicle ?? 'Vehicle'} — distribution of ${money(r.amount)}${r.asOf ? ` on ${r.asOf}` : ''} (${r.method}, state from ${r.source})`)
  out.push('')
  out.push(table(['Tier', 'Amount'], [
    ['Return of capital', money(r.tiers.returnOfCapital)],
    ['Preferred return', money(r.tiers.preferred)],
    ['GP catch-up', money(r.tiers.catchUp)],
    ...(r.tiers.catchUpToLP ? [['Catch-up — LPs', money(r.tiers.catchUpToLP)]] : []),
    ['Carry split — GP', money(r.tiers.carry)],
    ['Carry split — LPs', money(r.tiers.profitToLP)],
    ['To LPs', money(r.tiers.toLP)],
    ['To GP', money(r.tiers.toGP)],
  ]))
  out.push('')
  out.push(table(['Partner', 'Kind', 'Amount'], [
    ...r.lines.map(l => [l.name, 'distribution', money(l.amount)]),
    ...r.carryLines.map(l => [l.name, 'carry', money(l.amount)]),
  ], 2))
  if (r.warnings.length) { out.push(''); out.push('Warnings:'); for (const w of r.warnings) out.push(`  - ${w}`) }
  return out.join('\n') + '\n'
}
