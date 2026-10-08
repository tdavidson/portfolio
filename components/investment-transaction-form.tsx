'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, X, AlertTriangle, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCurrency, formatCurrencyFull, formatSharePrice, getCurrencySymbol } from '@/components/currency-context'
import {
  computeFxRevaluation, buildFxRevaluationPayload, derivePriorFxRate, deriveLocalSharePrice,
  deriveOriginalCurrency, deriveOriginalPositionValue,
} from '@/lib/fx'
import { LOT_METHOD_LABELS, isLotMethod } from '@/lib/portfolio/lots'
import type { FxRevaluationResult } from '@/lib/fx'
import { SECURITY_LABELS } from '@/lib/accounting/soi'
import { useCanRead } from '@/components/access-context'
import type { InvestmentTransaction } from '@/lib/types/database'
import type { CompanyInvestmentSummary } from '@/lib/types/investments'

/**
 * The ONE investment-transaction form.
 *
 * It grew up inside the company page's Investment Details section, and for a long time that was
 * the only place a transaction could be recorded. /start now offers "Add investment" as well, and
 * the temptation was a second, smaller form for the common case. Resisted: every rule in here —
 * which terms an instrument has, what a conversion carries, what a split restates, when nothing
 * reaches the ledger and why — was learned the hard way once, and a second form would have to
 * learn it all again. So the form is a component of its own, with no dialog chrome and no
 * knowledge of where it is rendered; the company page wraps it in an Add/Edit dialog, and /start
 * puts a company picker in front of it.
 *
 * What it needs from its host is the company's existing transactions and summary (for round-name
 * suggestions, the "Converts from" picker, and FX seeding) and the fund's lot policy. What it
 * hands back is the API's response — the saved row plus `ledger`, which says whether a journal
 * entry was drafted. `LedgerSaveNote` below renders that answer; both hosts show it.
 */

// 'conversion' is a UI-only mode: it is stored as an `investment` row carrying
// `converts_from_txn_id` (the SAFE/note it converted). See handleSave.
export type TransactionType = 'investment' | 'conversion' | 'proceeds' | 'escrow_receipt' | 'unrealized_gain_change' | 'round_info' | 'split' | 'income'

export function fmtNum(val: number | null | undefined): string {
  if (val == null) return '-'
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const CURRENCY_OPTIONS = [
  'USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'SGD',
  'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'BRL', 'ZAR', 'ILS', 'KRW',
]

export const EMPTY_FORM: Record<string, string> = {
  transaction_type: 'investment',
  // Set only in 'conversion' mode: the SAFE/note transaction this priced round converts.
  converts_from_txn_id: '',
  round_name: '',
  transaction_date: '',
  notes: '',
  investment_cost: '',
  interest_converted: '',
  // New shares per old share on a `split` row. Only this type writes it.
  split_ratio: '',
  // Income the position produced. `income_amount` is its fair value on the day received, which
  // for in-kind income also becomes the cost basis of the units.
  income_kind: 'staking',
  income_settlement: 'in_kind',
  income_amount: '',
  // Acquisition costs capitalised into basis — gas, brokerage. Not transfer gas or custody fees.
  fee_amount: '',
  // Convertible-note terms. `interest_rate` is the only rate the ledger accrues on;
  // `dividend_rate` (preferred) accrues to the liquidation preference and never hits the books.
  security_type: '',
  interest_rate: '',
  maturity_date: '',
  dividend_rate: '',
  shares_acquired: '',
  share_price: '',
  postmoney_valuation: '',
  ownership_pct: '',
  cost_basis_exited: '',
  proceeds_received: '',
  proceeds_escrow: '',
  proceeds_written_off: '',
  proceeds_per_share: '',
  exit_valuation: '',
  unrealized_value_change: '',
  current_share_price: '',
  latest_postmoney_valuation: '',
  original_currency: '',
  original_investment_cost: '',
  original_share_price: '',
  original_postmoney_valuation: '',
  original_proceeds_received: '',
  original_proceeds_per_share: '',
  original_exit_valuation: '',
  original_unrealized_value_change: '',
  original_current_share_price: '',
  original_latest_postmoney_valuation: '',
  valuation_change_source: 'mark',
  fx_rate: '',
  prior_fx_rate: '',
  original_position_value: '',
  portfolio_group: '',
}

/**
 * The dialog's form state for an existing row. Every key in EMPTY_FORM MUST come back as a
 * string: the save handler calls `.trim()` on the numeric fields, so a key this forgets is a
 * crash on save — which is exactly what happened when split/income/fee fields were added to
 * the form and the payload but not here. Spreading EMPTY_FORM first makes that impossible to
 * repeat; the test pins it.
 */
export function formFromTransaction(txn: InvestmentTransaction): Record<string, string> {
  // A conversion is stored as an `investment` row with a converts_from link. Recognize it so the
  // dialog reopens in Conversion mode with its fields — otherwise editing shows plain-investment
  // fields and, worse, saving nulls the link (turning it back into a $0-cost investment).
  const convertsFrom = (txn as any).converts_from_txn_id ?? ''
  return {
    ...EMPTY_FORM,
    transaction_type: convertsFrom ? 'conversion' : txn.transaction_type,
    converts_from_txn_id: convertsFrom,
    round_name: txn.round_name ?? '',
    transaction_date: txn.transaction_date ?? '',
    notes: txn.notes ?? '',
    investment_cost: txn.investment_cost?.toString() ?? '',
    interest_converted: txn.interest_converted?.toString() ?? '',
    security_type: (txn as any).security_type ?? '',
    // Stored as fractions, shown as percentages — nobody thinks in 0.08.
    interest_rate: (txn as any).interest_rate != null ? String(Number((txn as any).interest_rate) * 100) : '',
    maturity_date: (txn as any).maturity_date ?? '',
    dividend_rate: (txn as any).dividend_rate != null ? String(Number((txn as any).dividend_rate) * 100) : '',
    shares_acquired: txn.shares_acquired?.toString() ?? '',
    share_price: txn.share_price?.toString() ?? '',
    postmoney_valuation: txn.postmoney_valuation?.toString() ?? '',
    ownership_pct: txn.ownership_pct?.toString() ?? '',
    cost_basis_exited: txn.cost_basis_exited?.toString() ?? '',
    proceeds_received: txn.proceeds_received?.toString() ?? '',
    proceeds_escrow: txn.proceeds_escrow?.toString() ?? '',
    proceeds_written_off: txn.proceeds_written_off?.toString() ?? '',
    proceeds_per_share: txn.proceeds_per_share?.toString() ?? '',
    exit_valuation: txn.exit_valuation?.toString() ?? '',
    unrealized_value_change: txn.unrealized_value_change?.toString() ?? '',
    current_share_price: txn.current_share_price?.toString() ?? '',
    latest_postmoney_valuation: txn.latest_postmoney_valuation?.toString() ?? '',
    original_currency: txn.original_currency ?? '',
    original_investment_cost: txn.original_investment_cost?.toString() ?? '',
    original_share_price: txn.original_share_price?.toString() ?? '',
    original_postmoney_valuation: txn.original_postmoney_valuation?.toString() ?? '',
    original_proceeds_received: txn.original_proceeds_received?.toString() ?? '',
    original_proceeds_per_share: txn.original_proceeds_per_share?.toString() ?? '',
    original_exit_valuation: txn.original_exit_valuation?.toString() ?? '',
    original_unrealized_value_change: txn.original_unrealized_value_change?.toString() ?? '',
    original_current_share_price: txn.original_current_share_price?.toString() ?? '',
    original_latest_postmoney_valuation: txn.original_latest_postmoney_valuation?.toString() ?? '',
    valuation_change_source: txn.valuation_change_source ?? 'mark',
    fx_rate: txn.fx_rate?.toString() ?? '',
    prior_fx_rate: txn.prior_fx_rate?.toString() ?? '',
    original_position_value: txn.original_position_value?.toString() ?? '',
    portfolio_group: txn.portfolio_group ?? '',
    split_ratio: (txn as any).split_ratio?.toString() ?? '',
    income_kind: (txn as any).income_kind ?? EMPTY_FORM.income_kind,
    income_settlement: (txn as any).income_settlement ?? EMPTY_FORM.income_settlement,
    income_amount: (txn as any).income_amount?.toString() ?? '',
    fee_amount: (txn as any).fee_amount?.toString() ?? '',
  }
}

/** What the API says about the books after a save. See draftEntryForTransaction. */
export interface LedgerResult {
  drafted: boolean
  /** False only when the partner allocation failed and the entry was kept as a draft. */
  posted?: boolean
  kind?: string
  amount?: number
  vehicle?: string
  reason?: string
  /** Something next to the entry went wrong (an adopted entry's split) — shown ahead of everything. */
  warning?: string
}

/** The API's response to a save: the row, plus what happened on the ledger. */
export type SavedTransaction = InvestmentTransaction & { ledger?: LedgerResult | null }

const LEDGER_KIND_LABEL: Record<string, string> = {
  investment: 'an investment purchase',
  conversion: 'a conversion to equity',
  valuation: 'a mark to fair value',
  fx_revaluation: 'a foreign currency revaluation',
  proceeds: 'an exit',
  income: 'portfolio income',
}

/**
 * What a save did to the ledger, said out loud.
 *
 * Set when saving a transaction touched the ledger — EITHER a draft was created, or one
 * deliberately wasn't. The skip reason used to be dropped on the floor, so a transaction that
 * never reached the books looked identical to one that did: a success banner or silence. Silence
 * is exactly the wrong answer when the tracker and the ledger have just diverged.
 *
 * Every banner is about double-entry bookkeeping: drafts awaiting review, closed periods, vehicles
 * that keep no books. To someone without accounting it is noise about a system they cannot see,
 * linking to pages they cannot open — so they just save their transaction and hear nothing. One
 * call answers both halves: the resolver returns none when the fund has accounting switched off
 * AND when this user was never granted it. Affordance only: the API drafts (or doesn't) regardless;
 * this decides who is told.
 */
export function LedgerSaveNote({ ledger, onDismiss }: { ledger: LedgerResult | null; onDismiss: () => void }) {
  const canReadAccounting = useCanRead('accounting')
  if (!canReadAccounting || !ledger) return null

  if (ledger.warning) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <span>{ledger.warning}</span>
        <button onClick={onDismiss} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // Posted — the normal case. Said, quietly.
  if (ledger.drafted && ledger.posted) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>
          Posted {LEDGER_KIND_LABEL[ledger.kind ?? ''] ?? 'a journal entry'} to{' '}
          <strong>{ledger.vehicle}</strong>&rsquo;s ledger.
        </span>
        <Link href="/funds/journal" className="ml-auto text-xs underline underline-offset-2 hover:text-foreground">
          View the entry
        </Link>
        <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // It could not post — its partner allocation failed (no partner participates yet, say). Kept as
  // a draft rather than lost; say why, and where it is.
  if (ledger.drafted && ledger.reason) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <span>
          Kept {LEDGER_KIND_LABEL[ledger.kind ?? ''] ?? 'a journal entry'} as a <strong>draft</strong> in{' '}
          <strong>{ledger.vehicle}</strong>&rsquo;s ledger. {ledger.reason}
        </span>
        <Link href="/funds/journal" className="ml-auto text-xs underline underline-offset-2 hover:text-foreground">
          Review the entry
        </Link>
        <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // Nothing was booked, for a reason that IS worth a warning: a closed period, a missing account,
  // a row the ledger can't place. Amber, because the tracker and the ledger now say different
  // things and only this message explains why.
  if (ledger.reason) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <span>
          Saved to the tracker, but <strong>nothing was booked</strong> to the ledger.{' '}
          {ledger.reason}
        </span>
        <button
          onClick={onDismiss}
          className="ml-auto text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  return null
}

export interface InvestmentTransactionFormProps {
  companyId: string
  /**
   * The row being edited, or null to add one. Read once, on mount: hosts mount the form fresh
   * per open (the company page renders it only while its dialog is open), so there is nothing
   * to re-seed. A host that keeps one mounted across rows must `key` it on the row's id.
   */
  editing: InvestmentTransaction | null
  /** The company's existing rows: round-name suggestions, conversion sources, FX seeding. */
  transactions: InvestmentTransaction[]
  summary: CompanyInvestmentSummary | null
  /** The fund's lot policy — shown against a disposal's basis, never used to restate one. */
  lotMethod: string
  portfolioGroups: string[]
  onSaved: (saved: SavedTransaction) => void
  onCancel: () => void
}

export function InvestmentTransactionForm({ companyId, editing, transactions, summary, lotMethod, portfolioGroups, onSaved, onCancel }: InvestmentTransactionFormProps) {
  const currency = useCurrency()
  const symbol = getCurrencySymbol(currency)
  const fmt = (val: number | null | undefined) => val == null ? '-' : formatCurrencyFull(val, currency)
  const fmtPrice = (val: number | null | undefined) => val == null ? '-' : formatSharePrice(val, currency)

  const editingId = editing?.id ?? null
  const [form, setForm] = useState<Record<string, string>>(() => editing ? formFromTransaction(editing) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // An FX revaluation owns its own currency selector, so the generic original-amounts block stays
  // collapsed for those rows.
  const [showOrigCurrency, setShowOrigCurrency] = useState(
    () => !!editing?.original_currency && editing.valuation_change_source !== 'fx',
  )

  // Which terms an instrument actually has. Blank security_type shows everything: rows predating
  // the column never set it, and hiding their fields would look like data loss.
  const t = form.security_type
  const showNoteTerms = t === 'convertible_note'
  const showDividend = t === 'preferred'
  // An unpriced instrument has no shares and no per-share price — that is what makes it unpriced.
  // computeSummary() already values SAFEs and notes as cost + value change rather than
  // shares × price, so these inputs never reach the valuation for them anyway.
  const showSharePricing = !(t === 'safe' || t === 'convertible_note')
  // Ownership is a claim on the cap table. A note or a derivative doesn't hold one until it
  // converts or is exercised; a number here would be a guess at a future round's arithmetic.
  const showOwnership = !(t === 'convertible_note' || t === 'warrant' || t === 'option')

  // SAFEs / notes that can still be converted: an investment in an unpriced instrument that
  // nothing has converted yet. Feeds the "Converts from" picker in conversion mode.
  const convertibleSources = useMemo(
    () => transactions.filter(tx =>
      tx.transaction_type === 'investment' &&
      (tx.security_type === 'safe' || tx.security_type === 'convertible_note') &&
      // A row can never convert from itself.
      tx.id !== editingId &&
      // Exclude instruments already converted by SOME OTHER row — but keep the one this row (when
      // editing a conversion) already points to, so it stays selectable.
      !transactions.some(x => x.id !== editingId && (x as any).converts_from_txn_id === tx.id)
    ),
    [transactions, editingId]
  )

  /**
   * Change the instrument, and drop the terms that no longer belong to it.
   *
   * Every field above is hidden for some instrument, so without this a rate typed against a note
   * would still be submitted after switching to common — saved, invisible, and accruing interest at
   * the next close. A field you can't see must not still speak.
   *
   * This fires on the user changing the instrument, not on opening an existing row: a legacy row
   * carrying a share price on a SAFE keeps it until someone actually re-picks the type, rather than
   * being quietly rewritten by the act of opening the dialog.
   */
  const onSecurityTypeChange = (security_type: string) =>
    setForm(f => ({
      ...f,
      security_type,
      interest_rate: security_type === 'convertible_note' ? f.interest_rate : '',
      maturity_date: security_type === 'convertible_note' ? f.maturity_date : '',
      dividend_rate: security_type === 'preferred' ? f.dividend_rate : '',
      shares_acquired: security_type === 'safe' || security_type === 'convertible_note' ? '' : f.shares_acquired,
      share_price: security_type === 'safe' || security_type === 'convertible_note' ? '' : f.share_price,
      ownership_pct:
        security_type === 'convertible_note' || security_type === 'warrant' || security_type === 'option'
          ? ''
          : f.ownership_pct,
    }))

  /**
   * Change the transaction type — on create OR on edit (a "Round" mis-entered as such can be
   * reclassified to a "Valuation Update", and vice-versa). The type-specific value fields are
   * cleared so a number entered for one type can't linger invisibly on another, exactly as
   * onSecurityTypeChange does. Common fields (round, date, vehicle, notes) are kept.
   */
  const changeTransactionType = (transaction_type: string) =>
    setForm(f => ({
      ...f,
      transaction_type,
      // Clear every type-specific amount; the new type's fields start blank for re-entry.
      investment_cost: '', interest_converted: '', converts_from_txn_id: '',
      shares_acquired: '', share_price: '', postmoney_valuation: '', ownership_pct: '',
      cost_basis_exited: '', proceeds_received: '', proceeds_escrow: '', proceeds_written_off: '',
      proceeds_per_share: '', exit_valuation: '',
      unrealized_value_change: '',
      fx_rate: '', prior_fx_rate: '', original_position_value: '',
      // Sensible defaults for the destination type.
      valuation_change_source: transaction_type === 'unrealized_gain_change' ? 'mark' : f.valuation_change_source,
      security_type: transaction_type === 'conversion' && !f.security_type ? 'preferred' : f.security_type,
      // Round → Valuation Update: carry the round's price/post-money across so the mark preserves
      // the valuation instead of blanking it (the common reclassification). Cleared otherwise.
      current_share_price: transaction_type === 'unrealized_gain_change' ? f.share_price : '',
      latest_postmoney_valuation: transaction_type === 'unrealized_gain_change' ? f.postmoney_valuation : '',
    }))

  const isFxReval =
    form.transaction_type === 'unrealized_gain_change' && form.valuation_change_source === 'fx'

  /** The round an FX reval is being booked against, if one is selected. */
  const fxRound = useMemo(
    () => summary?.rounds.find(r => r.roundName === form.round_name) ?? null,
    [summary, form.round_name]
  )

  /**
   * FMV only tracks share price for priced-equity rounds (see computeSummary),
   * so those need a local share price or the revalued mark won't flow through.
   */
  const fxNeedsSharePrice = fxRound
    ? fxRound.sharesAcquired > 0
    : (summary?.totalShares ?? 0) > 0

  /** Seed the rate and position value from the position's existing history. */
  function seedFxFields(next: Record<string, string>): Record<string, string> {
    const ccy = next.original_currency || deriveOriginalCurrency(transactions, editingId) || ''
    if (!ccy) return { ...next, original_currency: '' }

    const priorRate = derivePriorFxRate(transactions, ccy, editingId)
    const localPrice = deriveLocalSharePrice(transactions, ccy, editingId)
    const round = summary?.rounds.find(r => r.roundName === next.round_name) ?? null
    const carrying = round ? round.currentValue : summary?.unrealizedValue ?? 0
    const posValue = priorRate != null ? deriveOriginalPositionValue(carrying, priorRate) : null

    return {
      ...next,
      original_currency: ccy,
      prior_fx_rate: next.prior_fx_rate || (priorRate != null ? String(Number(priorRate.toFixed(6))) : ''),
      original_current_share_price:
        next.original_current_share_price || (localPrice != null ? String(localPrice) : ''),
      original_position_value:
        next.original_position_value || (posValue != null ? String(Number(posValue.toFixed(2))) : ''),
    }
  }

  function setValuationSource(source: string) {
    if (source !== 'fx') {
      setForm(f => ({ ...f, valuation_change_source: source }))
      return
    }
    setShowOrigCurrency(false)
    setForm(f => seedFxFields({ ...f, valuation_change_source: 'fx' }))
  }

  function setFxCurrency(ccy: string) {
    // Re-derive against the newly chosen currency rather than keeping stale rates.
    setForm(f => seedFxFields({
      ...f,
      original_currency: ccy,
      prior_fx_rate: '',
      original_current_share_price: '',
      original_position_value: '',
    }))
  }

  const fxPreview = useMemo(() => {
    if (!isFxReval) return null
    const positionValueOriginal = parseFloat(form.original_position_value)
    const priorRate = parseFloat(form.prior_fx_rate)
    const newRate = parseFloat(form.fx_rate)
    if (
      !Number.isFinite(positionValueOriginal) ||
      !Number.isFinite(priorRate) || priorRate <= 0 ||
      !Number.isFinite(newRate) || newRate <= 0
    ) return null

    const localSharePrice = parseFloat(form.original_current_share_price)
    return computeFxRevaluation({
      positionValueOriginal,
      priorRate,
      newRate,
      localSharePrice: Number.isFinite(localSharePrice) ? localSharePrice : null,
    })
  }, [isFxReval, form.original_position_value, form.prior_fx_rate, form.fx_rate, form.original_current_share_price])

  async function handleSave() {
    if (isFxReval && !form.original_currency) {
      setError('Select the currency this position is denominated in.')
      return
    }
    if (isFxReval && !fxPreview) {
      setError('Enter a position value, a prior rate, and a new rate to compute the change.')
      return
    }
    const isConversion = form.transaction_type === 'conversion'
    if (isConversion && !form.converts_from_txn_id) {
      setError('Select the SAFE or note being converted.')
      return
    }
    if (form.transaction_type === 'income') {
      const amount = parseFloat(form.income_amount)
      if (!Number.isFinite(amount) || amount < 0) {
        setError('Enter the income amount — its fair value on the day you received it.')
        return
      }
      if (!form.transaction_date) {
        setError('Enter the date the income was received — its value on that day becomes the basis of any units.')
        return
      }
      if (form.income_settlement === 'in_kind' && !(parseFloat(form.shares_acquired) > 0)) {
        setError('Enter how many units arrived — for in-kind income the units are the income.')
        return
      }
    }
    if (form.transaction_type === 'split') {
      const ratio = parseFloat(form.split_ratio)
      if (!Number.isFinite(ratio) || ratio <= 0) {
        setError('Enter the split ratio — new shares per old share. A 2-for-1 forward split is 2; a 1-for-10 reverse split is 0.1.')
        return
      }
      // The effective date places the split in the share history: rows before it are restated,
      // rows on or after it are already in new shares. Without one there is nothing to restate
      // against, which is why the database refuses it too.
      if (!form.transaction_date) {
        setError('Enter the effective date of the split — it decides which purchases get restated.')
        return
      }
    }

    setSaving(true)
    setError(null)

    const numOrNull = (v: string) => v.trim() ? parseFloat(v) : null
    // Rates are entered as percentages and stored as fractions. The conversion happens here and
    // nowhere else.
    const rateOrNull = (v: string) => {
      const n = numOrNull(v)
      return n == null ? null : n / 100
    }

    const payload: Record<string, unknown> = {
      // A conversion is stored as the priced-round investment it becomes, linked to its source.
      transaction_type: isConversion ? 'investment' : form.transaction_type,
      converts_from_txn_id: isConversion ? (form.converts_from_txn_id || null) : null,
      round_name: form.round_name || null,
      transaction_date: form.transaction_date || null,
      notes: form.notes || null,
      // A conversion carries no cash of its own — it's a roll-over. New money at the round is a
      // separate Investment row. So a conversion never writes investment_cost.
      investment_cost: isConversion ? null : numOrNull(form.investment_cost),
      interest_converted: numOrNull(form.interest_converted) ?? 0,
      security_type: form.security_type || null,
      interest_rate: rateOrNull(form.interest_rate),
      maturity_date: form.maturity_date || null,
      dividend_rate: rateOrNull(form.dividend_rate),
      shares_acquired: numOrNull(form.shares_acquired),
      share_price: numOrNull(form.share_price),
      // Only a split carries a ratio. Sent as null otherwise so reclassifying a row away from
      // 'split' clears it rather than leaving a ratio that would still restate every earlier row.
      split_ratio: form.transaction_type === 'split' ? numOrNull(form.split_ratio) : null,
      income_kind: form.transaction_type === 'income' ? form.income_kind : null,
      income_settlement: form.transaction_type === 'income' ? form.income_settlement : null,
      income_amount: form.transaction_type === 'income' ? numOrNull(form.income_amount) : null,
      fee_amount: numOrNull(form.fee_amount),
      postmoney_valuation: numOrNull(form.postmoney_valuation),
      ownership_pct: numOrNull(form.ownership_pct),
      cost_basis_exited: numOrNull(form.cost_basis_exited),
      proceeds_received: numOrNull(form.proceeds_received),
      proceeds_escrow: numOrNull(form.proceeds_escrow) ?? 0,
      proceeds_written_off: numOrNull(form.proceeds_written_off) ?? 0,
      proceeds_per_share: numOrNull(form.proceeds_per_share),
      exit_valuation: numOrNull(form.exit_valuation),
      unrealized_value_change: numOrNull(form.unrealized_value_change),
      current_share_price: numOrNull(form.current_share_price),
      latest_postmoney_valuation: numOrNull(form.latest_postmoney_valuation),
      original_currency: showOrigCurrency && form.original_currency ? form.original_currency : null,
      original_investment_cost: showOrigCurrency ? numOrNull(form.original_investment_cost) : null,
      original_share_price: showOrigCurrency ? numOrNull(form.original_share_price) : null,
      original_postmoney_valuation: showOrigCurrency ? numOrNull(form.original_postmoney_valuation) : null,
      original_proceeds_received: showOrigCurrency ? numOrNull(form.original_proceeds_received) : null,
      original_proceeds_per_share: showOrigCurrency ? numOrNull(form.original_proceeds_per_share) : null,
      original_exit_valuation: showOrigCurrency ? numOrNull(form.original_exit_valuation) : null,
      original_unrealized_value_change: showOrigCurrency ? numOrNull(form.original_unrealized_value_change) : null,
      original_current_share_price: showOrigCurrency ? numOrNull(form.original_current_share_price) : null,
      original_latest_postmoney_valuation: showOrigCurrency ? numOrNull(form.original_latest_postmoney_valuation) : null,
      valuation_change_source: form.transaction_type === 'unrealized_gain_change'
        ? form.valuation_change_source
        : null,
      fx_rate: null,
      prior_fx_rate: null,
      fx_value_change: null,
      original_position_value: null,
      portfolio_group: form.portfolio_group || null,
    }

    if (isFxReval) {
      Object.assign(payload, buildFxRevaluationPayload({
        currency: form.original_currency,
        positionValueOriginal: parseFloat(form.original_position_value),
        priorRate: parseFloat(form.prior_fx_rate),
        newRate: parseFloat(form.fx_rate),
        localSharePrice: numOrNull(form.original_current_share_price),
      }))
    }

    try {
      const url = editingId
        ? `/api/companies/${companyId}/investments/${editingId}`
        : `/api/companies/${companyId}/investments`
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to save')
        return
      }

      // The transaction is saved. If the vehicle keeps books, the API also drafted the
      // journal entry it implies — say so and link to it, because a draft nobody knows
      // about is worse than no draft at all. And when it DIDN'T draft one, say that too:
      // the reason ("no accounting vehicle named X", "that period is closed") is precisely
      // what the user needs, and it was being discarded.
      const saved = await res.json().catch(() => null)
      onSaved(saved ?? ({} as SavedTransaction))
    } catch {
      setError('Failed to save transaction')
    } finally {
      setSaving(false)
    }
  }

  const txnType = form.transaction_type as TransactionType

  return (
    <>
      <div className="space-y-4">
        {/* The type is editable on create AND on edit — a row entered as the wrong type (e.g. a
            "Round" that should be a "Valuation Update") can be reclassified. changeTransactionType
            clears the previous type's amounts so nothing lingers. */}
        <div>
          <Label>Transaction Type</Label>
          <Select value={form.transaction_type} onValueChange={changeTransactionType}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="investment">Investment</SelectItem>
                <SelectItem value="conversion">Conversion (SAFE / note → equity)</SelectItem>
                <SelectItem value="proceeds">Proceeds</SelectItem>
                <SelectItem value="escrow_receipt">Escrow receipt</SelectItem>
                <SelectItem value="unrealized_gain_change">Valuation Update</SelectItem>
                <SelectItem value="round_info">Round</SelectItem>
                <SelectItem value="split">Share split</SelectItem>
                <SelectItem value="income">Income (staking, airdrop, dividend)</SelectItem>
              </SelectContent>
            </Select>
          </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Round Name</Label>
            {/* Free text for every type, with existing rounds as autocomplete suggestions. It
                used to be a dropdown of INVESTMENT round names for non-investment types, so a
                Valuation Update / Round whose round the fund never invested in (e.g. an
                external mark) showed a blank name. Free text always shows the value and lets a
                mark reference any round; the suggestions still make it easy to match a real one. */}
            <Input
              className="mt-1"
              value={form.round_name}
              onChange={e => setForm(f => ({ ...f, round_name: e.target.value }))}
              placeholder="e.g. Series A"
              list="round-name-suggestions"
            />
            <datalist id="round-name-suggestions">
              {Array.from(new Set(transactions.filter(t => t.round_name).map(t => t.round_name!))).map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div>
            <Label>Date</Label>
            <Input
              className="mt-1"
              type="date"
              value={form.transaction_date}
              onChange={e => setForm(f => ({ ...f, transaction_date: e.target.value }))}
            />
          </div>
        </div>

        {portfolioGroups.length > 0 && (
          <div>
            <Label>Vehicle</Label>
            <Select
              value={form.portfolio_group || undefined}
              onValueChange={v => setForm(f => ({ ...f, portfolio_group: v }))}
            >
              <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {portfolioGroups.map(g => (
                  <SelectItem key={g} value={g}>{g}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {txnType === 'investment' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Investment Cost ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.investment_cost}
                onChange={e => setForm(f => ({ ...f, investment_cost: e.target.value }))}
              />
            </div>
            <div>
              <Label>Interest Converted ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.interest_converted}
                onChange={e => setForm(f => ({ ...f, interest_converted: e.target.value }))}
              />
            </div>
            <div>
              <Label>Security Type</Label>
              {/* A select, not free text: the column has a CHECK constraint, so anything but
                  these exact values is rejected on insert. It used to be an Input whose
                  placeholder ("Preferred, Convertible note, SAFE…") suggested three values
                  that all fail — the form invited an error the database then refused. The
                  options come from the same map the Schedule of Investments renders. */}
              <select
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={form.security_type}
                onChange={e => onSecurityTypeChange(e.target.value)}
              >
                <option value="">Not set</option>
                {Object.entries(SECURITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">Feeds the Schedule of Investments breakout. Leave unset to let it derive one.</p>
            </div>
            {/* Note terms belong to a note. Shown only for one, so the form stops asking about
                an interest rate on common stock — and `onSecurityTypeChange` clears them when
                you switch away, because a hidden field that still submits is worse than a
                visible wrong one. */}
            {showNoteTerms && (
              <>
                <div>
                  <Label>Note Interest Rate (%)</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    placeholder="0"
                    value={form.interest_rate}
                    onChange={e => setForm(f => ({ ...f, interest_rate: e.target.value }))}
                  />
                  {/* This is the ONLY rate the ledger accrues on. Say so plainly, or someone will
                      type a preferred dividend rate here and the close will book it as income. */}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The close accrues interest on this, simple actual/365, until conversion or
                    maturity.
                  </p>
                </div>
                <div>
                  <Label>Note Maturity</Label>
                  <Input
                    className="mt-1"
                    type="date"
                    value={form.maturity_date}
                    onChange={e => setForm(f => ({ ...f, maturity_date: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">Interest stops here. Leave blank to accrue until conversion.</p>
                </div>
              </>
            )}
            {showDividend && (
              <div>
                <Label>Preferred Dividend Rate (%)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  step="any"
                  placeholder="0"
                  value={form.dividend_rate}
                  onChange={e => setForm(f => ({ ...f, dividend_rate: e.target.value }))}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Accrues to the liquidation preference. <strong>Does not hit the books</strong> —
                  an undeclared preferred dividend is not income; its effect reaches the
                  statements through the valuation.
                </p>
              </div>
            )}
            {showSharePricing && (
              <>
                <div>
                  <Label>Shares Acquired</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.shares_acquired}
                    onChange={e => setForm(f => ({ ...f, shares_acquired: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Share Price ({symbol.trim()})</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.share_price}
                    onChange={e => setForm(f => ({ ...f, share_price: e.target.value }))}
                  />
                </div>
              </>
            )}
            <div>
              <Label>Post-Money Valuation ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.postmoney_valuation}
                onChange={e => setForm(f => ({ ...f, postmoney_valuation: e.target.value }))}
                placeholder="Post-money valuation of the round"
              />
            </div>
            {showOwnership && (
              <div>
                <Label>Ownership %</Label>
                <Input
                  className="mt-1"
                  type="number"
                  step="any"
                  value={form.ownership_pct}
                  onChange={e => setForm(f => ({ ...f, ownership_pct: e.target.value }))}
                  placeholder="e.g. 15.5"
                />
              </div>
            )}
          </div>
        )}

        {txnType === 'conversion' && (() => {
          // A conversion is a pure roll-over of the SAFE/note into shares — no cash. New money
          // written at the same round is recorded as its OWN Investment row (same round name),
          // so it stays a distinct, visible line rather than being buried in the conversion.
          const src = transactions.find(t => t.id === form.converts_from_txn_id)
          const carriedPrincipal = Number(src?.investment_cost ?? 0)
          const interest = parseFloat(form.interest_converted) || 0
          const shares = parseFloat(form.shares_acquired) || 0
          const price = parseFloat(form.share_price) || 0
          const carriedBasis = carriedPrincipal + interest
          const roundValue = shares > 0 && price > 0 ? shares * price : carriedBasis
          const stepUp = roundValue - carriedBasis
          return (
            <div className="space-y-3">
              <div>
                <Label>Converts From</Label>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={form.converts_from_txn_id}
                  onChange={e => setForm(f => ({ ...f, converts_from_txn_id: e.target.value }))}
                >
                  <option value="">Select the SAFE or note being converted…</option>
                  {convertibleSources.map(s => (
                    <option key={s.id} value={s.id}>
                      {(s.round_name || (s.security_type === 'convertible_note' ? 'Note' : 'SAFE'))} · {symbol.trim()}{fmtNum(s.investment_cost)}{s.transaction_date ? ` · ${s.transaction_date}` : ''}
                    </option>
                  ))}
                </select>
                {convertibleSources.length === 0 && (
                  <p className="text-[11px] text-warning mt-1">
                    No open SAFE or note on this company. Record the SAFE/note as an Investment first.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">
                  The instrument&rsquo;s basis carries into this round. Its original cash outflow stays on its own date.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Shares Acquired</Label>
                  <Input className="mt-1" type="number" step="any" value={form.shares_acquired}
                    onChange={e => setForm(f => ({ ...f, shares_acquired: e.target.value }))} />
                </div>
                <div>
                  <Label>Share Price ({symbol.trim()})</Label>
                  <Input className="mt-1" type="number" step="any" value={form.share_price}
                    onChange={e => setForm(f => ({ ...f, share_price: e.target.value }))} />
                </div>
                <div>
                  <Label>Interest Converted ({symbol.trim()})</Label>
                  <Input className="mt-1" type="number" step="any" value={form.interest_converted}
                    onChange={e => setForm(f => ({ ...f, interest_converted: e.target.value }))} />
                  <p className="text-[11px] text-muted-foreground mt-1">Accrued note interest capitalizing into basis at this date. 0 for a SAFE.</p>
                </div>
                <div>
                  <Label>Security Type</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    value={form.security_type}
                    onChange={e => onSecurityTypeChange(e.target.value)}
                  >
                    <option value="">Not set</option>
                    {Object.entries(SECURITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Post-Money Valuation ({symbol.trim()})</Label>
                  <Input className="mt-1" type="number" step="any" value={form.postmoney_valuation}
                    onChange={e => setForm(f => ({ ...f, postmoney_valuation: e.target.value }))} />
                </div>
              </div>

              {/* Live preview so the arithmetic of the conversion is obvious before saving. */}
              {form.converts_from_txn_id && (
                <div className="rounded-card border bg-muted/30 p-3 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Carried basis (principal + interest)</span><span className="font-mono">{symbol.trim()}{fmtNum(carriedBasis)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Round value ({shares > 0 && price > 0 ? `${fmtNum(shares)} × ${symbol.trim()}${fmtNum(price)}` : 'held at cost'})</span><span className="font-mono">{symbol.trim()}{fmtNum(roundValue)}</span></div>
                  <div className="flex justify-between font-medium"><span>{stepUp >= 0 ? 'Step-up recognized' : 'Down-round loss'} at {form.transaction_date || 'conversion date'}</span><span className={`font-mono ${stepUp >= 0 ? 'text-success dark:text-success' : 'text-destructive dark:text-destructive'}`}>{stepUp >= 0 ? '+' : ''}{symbol.trim()}{fmtNum(stepUp)}</span></div>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Wrote a new check at this round too? Add it as a separate <strong>Investment</strong> with the same round name — it stays its own line.
              </p>
            </div>
          )
        })()}

        {txnType === 'proceeds' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cost Basis Exited ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.cost_basis_exited}
                onChange={e => setForm(f => ({ ...f, cost_basis_exited: e.target.value }))}
              />
              {/* Left blank this field defaults to nothing, which keeps the full cost on the
                  books and reports the entire proceeds as gain — an overstated NAV and an
                  overstated return in one stroke. Say so, rather than letting it pass. */}
              {!form.cost_basis_exited && (
                <p className="mt-1 text-sm text-warning">
                  Without a cost basis the whole proceeds report as gain, and the position keeps
                  cost it no longer holds.
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Your fund&rsquo;s policy is <span className="font-medium">{isLotMethod(lotMethod) ? LOT_METHOD_LABELS[lotMethod] : lotMethod}</span>.
                The close reports any disposal whose recorded basis differs from this.
              </p>
            </div>
            <div>
              <Label>Proceeds (gross) ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.proceeds_received}
                onChange={e => setForm(f => ({ ...f, proceeds_received: e.target.value }))}
              />
            </div>
            <div>
              <Label>In escrow ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.proceeds_escrow}
                onChange={e => setForm(f => ({ ...f, proceeds_escrow: e.target.value }))}
              />
            </div>
            <div>
              <Label>Written Off ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.proceeds_written_off}
                onChange={e => setForm(f => ({ ...f, proceeds_written_off: e.target.value }))}
              />
            </div>
            <div>
              <Label>Proceeds Per Share ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.proceeds_per_share}
                onChange={e => setForm(f => ({ ...f, proceeds_per_share: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <Label>Exit Valuation ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.exit_valuation}
                onChange={e => setForm(f => ({ ...f, exit_valuation: e.target.value }))}
                placeholder="Total company exit price"
              />
            </div>
          </div>
        )}

        {txnType === 'escrow_receipt' && (
          <div className="space-y-2">
            <div>
              <Label>Escrow Received ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                min="0"
                step="any"
                value={form.proceeds_received}
                onChange={e => setForm(f => ({ ...f, proceeds_received: e.target.value }))}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Records cash released from escrow. It does not increase total proceeds again; the
              original Proceeds entry already includes the escrow balance.
            </p>
          </div>
        )}

        {txnType === 'round_info' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Share Price ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.share_price}
                onChange={e => setForm(f => ({ ...f, share_price: e.target.value }))}
              />
            </div>
            <div>
              <Label>Post-Money Valuation ({symbol.trim()})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.postmoney_valuation}
                onChange={e => setForm(f => ({ ...f, postmoney_valuation: e.target.value }))}
                placeholder="Post-money valuation of the round"
              />
            </div>
            <div>
              <Label>Ownership %</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.ownership_pct}
                onChange={e => setForm(f => ({ ...f, ownership_pct: e.target.value }))}
                placeholder="e.g. 15.5"
              />
            </div>
          </div>
        )}

        {txnType === 'income' && (() => {
          const inKind = form.income_settlement === 'in_kind'
          const amount = parseFloat(form.income_amount)
          const unitsIn = parseFloat(form.shares_acquired)
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>What produced it</Label>
                  <Select value={form.income_kind} onValueChange={v => setForm(f => ({
                    ...f,
                    income_kind: v,
                    // A dividend is usually cash; a staking reward or airdrop arrives in kind.
                    // Only a nudge — either settlement stays selectable below.
                    income_settlement: v === 'dividend' ? 'cash' : 'in_kind',
                  }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="staking">Staking reward</SelectItem>
                      <SelectItem value="airdrop">Airdrop</SelectItem>
                      <SelectItem value="dividend">Dividend</SelectItem>
                      <SelectItem value="other">Other portfolio income</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>How it settled</Label>
                  <Select value={form.income_settlement} onValueChange={v => setForm(f => ({ ...f, income_settlement: v }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="in_kind">In kind — more units</SelectItem>
                      <SelectItem value="cash">Cash — into the bank</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Value when received ({symbol.trim()})</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.income_amount}
                    onChange={e => setForm(f => ({ ...f, income_amount: e.target.value }))}
                  />
                </div>
                {inKind && (
                  <div>
                    <Label>Units received</Label>
                    <Input
                      className="mt-1"
                      type="number"
                      step="any"
                      value={form.shares_acquired}
                      onChange={e => setForm(f => ({ ...f, shares_acquired: e.target.value }))}
                    />
                  </div>
                )}
              </div>
              {/* Says what the row will DO. Recording this as a Valuation Update instead is
                  the mistake it exists to prevent, and the consequence — income counted
                  twice — is invisible until an exit reports a gain that was never there. */}
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs space-y-1">
                <p>
                  Booked as <span className="font-medium">income</span>, not appreciation — it
                  reaches the statement of operations rather than change in unrealized.
                </p>
                {inKind ? (
                  <p>
                    {Number.isFinite(unitsIn) && unitsIn > 0 && Number.isFinite(amount) ? (
                      <>
                        The position gains <span className="tabular-nums font-medium">{unitsIn}</span> units
                        carrying <span className="tabular-nums font-medium">{amount}</span> of cost basis
                        {unitsIn > 0 && amount >= 0 && (
                          <> (<span className="tabular-nums">{(amount / unitsIn).toLocaleString('en-US', { maximumFractionDigits: 8 })}</span> each)</>
                        )}. Selling them later nets against that basis instead of reporting the
                        whole proceeds as gain.
                      </>
                    ) : (
                      <>The units carry their value on the day as cost basis, so a later sale nets
                        against it rather than reporting the whole proceeds as gain.</>
                    )}
                  </p>
                ) : (
                  <p>Cash income changes no position — it lands in the bank and on the income statement.</p>
                )}
              </div>
            </div>
          )
        })()}

        {txnType === 'split' && (() => {
          const ratio = parseFloat(form.split_ratio)
          const valid = Number.isFinite(ratio) && ratio > 0
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Split ratio</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.split_ratio}
                    onChange={e => setForm(f => ({ ...f, split_ratio: e.target.value }))}
                    placeholder="e.g. 2 for a 2-for-1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    New shares per old share. A 2-for-1 forward split is <span className="tabular-nums">2</span>;
                    a 1-for-10 reverse split is <span className="tabular-nums">0.1</span>.
                  </p>
                </div>
                <div>
                  <Label>Effective date</Label>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Set it in <span className="font-medium">Transaction Date</span> above. Purchases before
                    that date are restated; a purchase on or after it already trades in new shares.
                  </p>
                </div>
              </div>
              {/* Says what the row will DO, in shares, before it is saved. A split is the one
                  entry whose ratio is easy to invert by accident, and a reversed ratio does not
                  look wrong afterwards — it looks like a position that quietly changed size. */}
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                {valid ? (
                  <span>
                    Every share held before this date becomes{' '}
                    <span className="tabular-nums font-medium">{ratio}</span>{' '}
                    {ratio === 1 ? 'share' : 'shares'}, and per-share prices are divided by the same
                    number. The position&rsquo;s value does not change, and nothing is posted to the ledger.
                    {' '}A holding of <span className="tabular-nums">1,000</span> shares becomes{' '}
                    <span className="tabular-nums font-medium">
                      {(1000 * ratio).toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    </span>.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Enter a ratio to see what this will do to the share count.
                  </span>
                )}
              </div>
            </div>
          )
        })()}

        {txnType === 'unrealized_gain_change' && (
          <div className="space-y-4">
            <div>
              <Label>Change Driven By</Label>
              <Select value={form.valuation_change_source} onValueChange={setValuationSource}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mark">New mark / revaluation</SelectItem>
                  <SelectItem value="fx">Foreign exchange rate change</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.valuation_change_source === 'mark' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Unrealized Value Change ({symbol.trim()})</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.unrealized_value_change}
                    onChange={e => setForm(f => ({ ...f, unrealized_value_change: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Current Share Price ({symbol.trim()})</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.current_share_price}
                    onChange={e => setForm(f => ({ ...f, current_share_price: e.target.value }))}
                  />
                </div>
                <div className="col-span-2">
                  <Label>Latest Post-Money Valuation ({symbol.trim()})</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    step="any"
                    value={form.latest_postmoney_valuation}
                    onChange={e => setForm(f => ({ ...f, latest_postmoney_valuation: e.target.value }))}
                    placeholder="Latest post-money valuation"
                  />
                </div>
              </div>
            )}

            {isFxReval && (
              <FxRevaluationFields
                form={form}
                setForm={setForm}
                setFxCurrency={setFxCurrency}
                fundCurrency={currency}
                preview={fxPreview}
                needsSharePrice={fxNeedsSharePrice}
                fmt={fmt}
                fmtPrice={fmtPrice}
              />
            )}
          </div>
        )}

        {/* Multi-currency section — an FX revaluation carries its own currency selector */}
        {isFxReval ? null : !showOrigCurrency ? (
          <button
            type="button"
            onClick={() => setShowOrigCurrency(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            + Different currency?
          </button>
        ) : (
          <div className="border rounded-card p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Original Currency Amounts</span>
              <button
                type="button"
                onClick={() => setShowOrigCurrency(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Remove
              </button>
            </div>
            <div>
              <Label>Currency</Label>
              <Select
                value={form.original_currency}
                onValueChange={v => setForm(f => ({ ...f, original_currency: v }))}
              >
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select currency" /></SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map(c => (
                    <SelectItem key={c} value={c}>{c} ({getCurrencySymbol(c).trim()})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.original_currency && (
              <div className="grid grid-cols-2 gap-3">
                {txnType === 'investment' && (
                  <>
                    <div>
                      <Label>Investment Cost ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_investment_cost} onChange={e => setForm(f => ({ ...f, original_investment_cost: e.target.value }))} />
                    </div>
                    <div>
                      <Label>Share Price ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_share_price} onChange={e => setForm(f => ({ ...f, original_share_price: e.target.value }))} />
                    </div>
                    <div className="col-span-2">
                      <Label>Post-Money Valuation ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_postmoney_valuation} onChange={e => setForm(f => ({ ...f, original_postmoney_valuation: e.target.value }))} />
                    </div>
                  </>
                )}
                {txnType === 'proceeds' && (
                  <>
                    <div>
                      <Label>Proceeds Received ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_proceeds_received} onChange={e => setForm(f => ({ ...f, original_proceeds_received: e.target.value }))} />
                    </div>
                    <div>
                      <Label>Proceeds Per Share ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_proceeds_per_share} onChange={e => setForm(f => ({ ...f, original_proceeds_per_share: e.target.value }))} />
                    </div>
                    <div className="col-span-2">
                      <Label>Exit Valuation ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_exit_valuation} onChange={e => setForm(f => ({ ...f, original_exit_valuation: e.target.value }))} />
                    </div>
                  </>
                )}
                {txnType === 'unrealized_gain_change' && (
                  <>
                    <div>
                      <Label>Value Change ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_unrealized_value_change} onChange={e => setForm(f => ({ ...f, original_unrealized_value_change: e.target.value }))} />
                    </div>
                    <div>
                      <Label>Current Share Price ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_current_share_price} onChange={e => setForm(f => ({ ...f, original_current_share_price: e.target.value }))} />
                    </div>
                    <div className="col-span-2">
                      <Label>Latest Post-Money ({getCurrencySymbol(form.original_currency).trim()})</Label>
                      <Input className="mt-1" type="number" step="any" value={form.original_latest_postmoney_valuation} onChange={e => setForm(f => ({ ...f, original_latest_postmoney_valuation: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <Label>Notes</Label>
          <Input
            className="mt-1"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Optional notes"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {editingId ? 'Update' : 'Add'}
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// FX revaluation entry
// ---------------------------------------------------------------------------

export function signedFmt(val: number, fmt: (v: number) => string): string {
  return `${val >= 0 ? '+' : '-'}${fmt(Math.abs(val))}`
}

export function PreviewLine({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: 'positive' | 'negative'
}) {
  const tone =
    emphasis === 'positive' ? 'font-medium text-success'
    : emphasis === 'negative' ? 'font-medium text-destructive'
    : ''
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${tone}`}>{value}</span>
    </div>
  )
}

function FxRevaluationFields({
  form,
  setForm,
  setFxCurrency,
  fundCurrency,
  preview,
  needsSharePrice,
  fmt,
  fmtPrice,
}: {
  form: Record<string, string>
  setForm: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setFxCurrency: (ccy: string) => void
  fundCurrency: string
  preview: FxRevaluationResult | null
  needsSharePrice: boolean
  fmt: (v: number | null | undefined) => string
  fmtPrice: (v: number | null | undefined) => string
}) {
  const ccy = form.original_currency
  const origSymbol = ccy ? getCurrencySymbol(ccy).trim() : ''
  const missingSharePrice = needsSharePrice && !(parseFloat(form.original_current_share_price) > 0)

  return (
    <div className="border rounded-card p-3 space-y-3">
      <div>
        <Label>Deal Currency</Label>
        <Select value={ccy || undefined} onValueChange={setFxCurrency}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select currency" /></SelectTrigger>
          <SelectContent>
            {CURRENCY_OPTIONS.filter(c => c !== fundCurrency).map(c => (
              <SelectItem key={c} value={c}>{c} ({getCurrencySymbol(c).trim()})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {ccy && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Prior FX Rate</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                min="0"
                value={form.prior_fx_rate}
                onChange={e => setForm(f => ({ ...f, prior_fx_rate: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">Rate the position is carried at</p>
            </div>
            <div>
              <Label>New FX Rate</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                min="0"
                value={form.fx_rate}
                onChange={e => setForm(f => ({ ...f, fx_rate: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                1 {ccy} = {form.fx_rate || '…'} {fundCurrency}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Position Value ({origSymbol})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.original_position_value}
                onChange={e => setForm(f => ({ ...f, original_position_value: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">Held constant — only the rate moves</p>
            </div>
            <div>
              <Label>Share Price ({origSymbol})</Label>
              <Input
                className="mt-1"
                type="number"
                step="any"
                value={form.original_current_share_price}
                onChange={e => setForm(f => ({ ...f, original_current_share_price: e.target.value }))}
              />
            </div>
          </div>

          {missingSharePrice && (
            <p className="text-sm text-warning">
              This position is priced equity, so its FMV tracks share price. Enter the share price
              in {ccy} or the revalued mark won&apos;t reach FMV.
            </p>
          )}

          {preview && (
            <div className="rounded-md bg-muted/50 p-3 space-y-1 text-sm">
              <PreviewLine
                label={`Local value held at`}
                value={formatCurrencyFull(parseFloat(form.original_position_value), ccy)}
              />
              <PreviewLine label="Prior carrying value" value={fmt(preview.priorFundValue)} />
              <PreviewLine label="New carrying value" value={fmt(preview.newFundValue)} />
              {preview.newFundSharePrice != null && (
                <PreviewLine label="New share price" value={fmtPrice(preview.newFundSharePrice)} />
              )}
              <div className="border-t pt-1 mt-1">
                <PreviewLine
                  label="FX change"
                  value={signedFmt(preview.fxValueChange, v => fmt(v))}
                  emphasis={preview.fxValueChange >= 0 ? 'positive' : 'negative'}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
