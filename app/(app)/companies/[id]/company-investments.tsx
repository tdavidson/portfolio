'use client'

import { useEffect, useState, useCallback, Fragment } from 'react'
import { DollarSign, Plus, Trash2, Pencil, Loader2, ChevronDown, ChevronRight, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { useCurrency, formatCurrencyFull, formatSharePrice } from '@/components/currency-context'
import { formatFxRate } from '@/lib/fx'
import {
  InvestmentTransactionForm, LedgerSaveNote, PreviewLine, signedFmt, fmtNum,
  type LedgerResult, type TransactionType,
} from '@/components/investment-transaction-form'
import { deleteInvestmentTransaction } from '@/lib/delete-investment-transaction'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'
import type { CompanyInvestmentSummary } from '@/lib/types/investments'

interface Props {
  companyId: string
  companyStatus: CompanyStatus
  portfolioGroups: string[]
  adminOnly?: boolean
}

// 'conversion' is a UI-only mode: it is stored as an `investment` row carrying
// `converts_from_txn_id` (the SAFE/note it converted). See handleSave.

const TYPE_LABELS: Record<TransactionType, string> = {
  investment: 'Investment',
  conversion: 'Conversion',
  proceeds: 'Proceeds',
  escrow_receipt: 'Escrow Receipt',
  unrealized_gain_change: 'Valuation Update',
  round_info: 'Round',
  split: 'Share split',
  income: 'Income',
}

function fmtMoic(val: number | null | undefined): string {
  if (val == null) return '-'
  return `${val.toFixed(2)}x`
}

export function CompanyInvestments({ companyId, companyStatus, portfolioGroups, adminOnly }: Props) {
  const currency = useCurrency()
  const fmt = (val: number | null | undefined) => val == null ? '-' : formatCurrencyFull(val, currency)
  const fmtPrice = (val: number | null | undefined) => val == null ? '-' : formatSharePrice(val, currency)

  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([])
  const [summary, setSummary] = useState<CompanyInvestmentSummary | null>(null)
  // The fund's lot policy, and what it makes of the disposals already recorded. Used to PROPOSE
  // a basis on a new disposal — never to restate one that is already on the books.
  const [lotMethod, setLotMethod] = useState<string>('fifo')
  const [groupSummaries, setGroupSummaries] = useState<Record<string, CompanyInvestmentSummary> | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InvestmentTransaction | null>(null)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [ledger, setLedger] = useState<LedgerResult | null>(null)
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10))

  const load = useCallback(async () => {
    try {
      const params = asOfDate ? `?asOf=${asOfDate}` : ''
      const res = await fetch(`/api/companies/${companyId}/investments${params}`)
      if (res.ok) {
        const data = await res.json()
        setTransactions(data.transactions)
        setSummary(data.summary)
        setGroupSummaries(data.groupSummaries ?? null)
        if (data.lotMethod) setLotMethod(data.lotMethod)
      }
    } finally {
      setLoading(false)
    }
  }, [companyId, asOfDate])

  useEffect(() => { load() }, [load])

  function openAdd() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(txn: InvestmentTransaction) {
    setEditing(txn)
    setDialogOpen(true)
  }

  async function handleDelete(txnId: string) {
    setDeletingId(txnId)
    setDeleteError(null)
    try {
      const result = await deleteInvestmentTransaction(companyId, txnId)
      if (result.ok) load()
      else setDeleteError(result.error)
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-2">
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Investment Details</span>
          {adminOnly && <Lock className="h-3 w-3 text-warning" />}
        </div>
        <div className="animate-pulse space-y-2">
          <div className="h-8 bg-muted rounded w-full" />
          <div className="h-8 bg-muted rounded w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6">
      <LedgerSaveNote ledger={ledger} onDismiss={() => setLedger(null)} />
      {deleteError && <p className="text-sm text-destructive mb-2">{deleteError}</p>}

      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <DollarSign className="h-3.5 w-3.5" />
          Investment Details
          {adminOnly && <Lock className="h-3 w-3 text-warning" />}
          {transactions.length > 0 && (
            <span className="text-xs bg-muted rounded-full px-1.5 py-0.5">{transactions.length}</span>
          )}
        </button>
        <Button size="sm" variant="outline" onClick={openAdd} className="h-7 px-2 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {expanded && summary && summary.totalInvested > 0 && !groupSummaries && (
        <SummaryLine summary={summary} fmt={fmt} fmtMoic={fmtMoic} asOfDate={asOfDate} setAsOfDate={setAsOfDate} />
      )}

      {expanded && groupSummaries && (
        Object.entries(groupSummaries).sort(([a], [b]) => a.localeCompare(b)).map(([group, gs]) => {
          const companyWideTxns = transactions.filter(t =>
            !t.portfolio_group && (t.transaction_type === 'round_info' || t.transaction_type === 'unrealized_gain_change')
          )
          const groupTxns = [...transactions.filter(t => t.portfolio_group === group), ...companyWideTxns]
          return (
            <div key={group} className="mb-5">
              <h3 className="text-base font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{group}</h3>
              <SummaryLine summary={gs} fmt={fmt} fmtMoic={fmtMoic} asOfDate={asOfDate} setAsOfDate={setAsOfDate} />
              <TransactionTable
                transactions={groupTxns}
                summary={gs}
                companyStatus={companyStatus}
                showGroup={false}
                fundCurrency={currency}
                fmt={fmt}
                fmtPrice={fmtPrice}
                openEdit={openEdit}
                handleDelete={handleDelete}
                deletingId={deletingId}
              />
              {companyStatus === 'exited' && gs.rounds.length > 0 && (
                <RoundSummaryTable
                  summary={gs}
                  transactions={groupTxns}
                  showGroup={false}
                  fmt={fmt}
                  fmtMoic={fmtMoic}
                />
              )}
            </div>
          )
        })
      )}

      {expanded && !groupSummaries && transactions.length > 0 && (
        <TransactionTable
          transactions={transactions}
          summary={summary}
          companyStatus={companyStatus}
          showGroup={portfolioGroups.length > 0}
          fundCurrency={currency}
          fmt={fmt}
          fmtPrice={fmtPrice}
          openEdit={openEdit}
          handleDelete={handleDelete}
          deletingId={deletingId}
        />
      )}

      {expanded && !groupSummaries && companyStatus === 'exited' && summary && summary.rounds.length > 0 && (
        <RoundSummaryTable
          summary={summary}
          transactions={transactions}
          showGroup={portfolioGroups.length > 0}
          fmt={fmt}
          fmtMoic={fmtMoic}
        />
      )}

      {expanded && transactions.length === 0 && (
        <p className="text-xs text-muted-foreground px-3 py-2">
          No investment transactions recorded yet.
        </p>
      )}

      {/* Add/Edit Dialog */}
      {/* Add/Edit Dialog. The form itself is shared with /start — see investment-transaction-form.tsx. */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Transaction' : 'Add Transaction'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Update the transaction details.' : 'Record a new investment transaction.'}
            </DialogDescription>
          </DialogHeader>
          {dialogOpen && (
            <InvestmentTransactionForm
              companyId={companyId}
              editing={editing}
              transactions={transactions}
              summary={summary}
              lotMethod={lotMethod}
              portfolioGroups={portfolioGroups}
              onSaved={saved => { setLedger(saved.ledger ?? null); setDialogOpen(false); load() }}
              onCancel={() => setDialogOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FxDetailPanel({
  txn,
  fundCurrency,
  fmt,
  fmtPrice,
}: {
  txn: InvestmentTransaction
  fundCurrency: string
  fmt: (v: number | null | undefined) => string
  fmtPrice: (v: number | null | undefined) => string
}) {
  const ccy = txn.original_currency ?? ''
  const positionValue = txn.original_position_value
  const priorRate = txn.prior_fx_rate
  const newRate = txn.fx_rate
  const change = txn.fx_value_change ?? txn.unrealized_value_change

  const priorFundValue = positionValue != null && priorRate != null ? positionValue * priorRate : null
  const newFundValue = positionValue != null && newRate != null ? positionValue * newRate : null
  const localSharePrice = txn.original_current_share_price

  return (
    <div className="max-w-md space-y-1 text-sm">
      <PreviewLine label="Deal currency" value={ccy || '-'} />
      <PreviewLine
        label="Position value (held)"
        value={positionValue != null && ccy ? formatCurrencyFull(positionValue, ccy) : '-'}
      />
      <PreviewLine
        label="Prior FX rate"
        value={priorRate != null ? `${formatFxRate(priorRate)}  (1 ${ccy} = ${formatFxRate(priorRate)} ${fundCurrency})` : '-'}
      />
      <PreviewLine
        label="New FX rate"
        value={newRate != null ? `${formatFxRate(newRate)}  (1 ${ccy} = ${formatFxRate(newRate)} ${fundCurrency})` : '-'}
      />
      {localSharePrice != null && (
        <PreviewLine
          label="Share price"
          value={`${formatSharePrice(localSharePrice, ccy)} → ${fmtPrice(txn.current_share_price)}`}
        />
      )}
      <div className="border-t pt-1 mt-1 space-y-1">
        <PreviewLine label="Prior carrying value" value={fmt(priorFundValue)} />
        <PreviewLine label="New carrying value" value={fmt(newFundValue)} />
        <PreviewLine
          label="FX change"
          value={change != null ? signedFmt(change, v => fmt(v)) : '-'}
          emphasis={change == null ? undefined : change >= 0 ? 'positive' : 'negative'}
        />
      </div>
      {txn.notes && <p className="pt-2 text-xs text-muted-foreground">{txn.notes}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Extracted sub-components for per-group rendering
// ---------------------------------------------------------------------------

function SummaryLine({
  summary,
  fmt,
  fmtMoic: fmtMoicFn,
  asOfDate,
  setAsOfDate,
}: {
  summary: CompanyInvestmentSummary
  fmt: (v: number | null | undefined) => string
  fmtMoic: (v: number | null | undefined) => string
  asOfDate: string
  setAsOfDate: (v: string) => void
}) {
  if (summary.totalInvested <= 0) return null
  return (
    <div className="flex items-center gap-4 mb-3 text-sm flex-wrap">
      <span>
        <span className="text-muted-foreground">Invested:</span>{' '}
        <span className="font-medium">{fmt(summary.totalInvested)}</span>
      </span>
      {summary.totalRealized > 0 ? (
        <>
          <span>
            <span className="text-muted-foreground">Realized:</span>{' '}
            <span className="font-medium">{fmt(summary.totalRealized)}</span>
          </span>
          {summary.unrealizedValue > 0 && (
            <span>
              <span className="text-muted-foreground">Unrealized:</span>{' '}
              <span className="font-medium">{fmt(summary.unrealizedValue)}</span>
            </span>
          )}
        </>
      ) : (
        <span>
          <span className="text-muted-foreground">FMV:</span>{' '}
          <span className="font-medium">{fmt(summary.fmv)}</span>
        </span>
      )}
      {summary.moic != null && (
        <span>
          <span className="text-muted-foreground">Gross MOIC:</span>{' '}
          <span className="font-medium">{fmtMoicFn(summary.moic)}</span>
        </span>
      )}
      {summary.grossIrr != null && Math.abs(summary.grossIrr) >= 0.0005 && (
        <span>
          <span className="text-muted-foreground">Gross IRR:</span>{' '}
          <span className="font-medium">{(summary.grossIrr * 100).toFixed(1)}%</span>
        </span>
      )}
      {summary.rounds.reduce((sum, r) => sum + r.escrowOutstanding, 0) > 0 && (
        <span>
          <span className="text-muted-foreground">In escrow:</span>{' '}
          <span className="font-medium">{fmt(summary.rounds.reduce((sum, r) => sum + r.escrowOutstanding, 0))}</span>
        </span>
      )}
      {summary.grossIrr != null && Math.abs(summary.grossIrr) >= 0.0005 && summary.unrealizedValue > 0 && (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground">as of</span>
          <input
            type="date"
            value={asOfDate}
            onChange={e => setAsOfDate(e.target.value)}
            className="text-xs border rounded px-1.5 py-0.5 bg-background"
          />
        </span>
      )}
    </div>
  )
}

function TransactionTable({
  transactions,
  summary,
  companyStatus,
  showGroup,
  fundCurrency,
  fmt,
  fmtPrice,
  openEdit,
  handleDelete,
  deletingId,
}: {
  transactions: InvestmentTransaction[]
  summary: CompanyInvestmentSummary | null
  companyStatus: CompanyStatus
  showGroup: boolean
  fundCurrency: string
  fmt: (v: number | null | undefined) => string
  fmtPrice: (v: number | null | undefined) => string
  openEdit: (txn: InvestmentTransaction) => void
  handleDelete: (id: string) => void
  deletingId: string | null
}) {
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())

  function toggleRow(id: string) {
    setOpenRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (transactions.length === 0) return null
  const hasPostmoney = transactions.some(t => t.postmoney_valuation != null)
  const hasFxRows = transactions.some(t => t.valuation_change_source === 'fx')
  const hasEscrow = transactions.some(t => t.transaction_type === 'proceeds' && (t.proceeds_escrow ?? 0) > 0)
  const hasInterestConversion = transactions.some(t =>
    t.transaction_type === 'investment' &&
    !!(t as { converts_from_txn_id?: string | null }).converts_from_txn_id &&
    Number(t.interest_converted ?? 0) > 0,
  )
  let escrowBalance = 0
  const colCount =
    (showGroup ? 1 : 0) +
    (companyStatus === 'exited' ? 6 + (hasInterestConversion ? 1 : 0) + (hasEscrow ? 1 : 0) : 8 + (hasPostmoney ? 1 : 0))
  return (
    <div className="border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {showGroup && <th className="text-left px-3 py-2 font-medium">Vehicle</th>}
            <th className="text-left px-3 py-2 font-medium">Type</th>
            <th className="text-left px-3 py-2 font-medium">Round</th>
            <th className="text-left px-3 py-2 font-medium">Date</th>
            {companyStatus === 'exited' ? (
              <>
                <th className="text-right px-3 py-2 font-medium">Cost</th>
                {hasInterestConversion && <th className="text-right px-3 py-2 font-medium">Conversion</th>}
                <th className="text-right px-3 py-2 font-medium">Proceeds</th>
                {hasEscrow && <th className="text-right px-3 py-2 font-medium">In escrow</th>}
              </>
            ) : (
              <>
                <th className="text-right px-3 py-2 font-medium">Invested</th>
                {hasPostmoney && <th className="text-right px-3 py-2 font-medium">Postmoney</th>}
                <th className="text-right px-3 py-2 font-medium">Shares</th>
                <th className="text-right px-3 py-2 font-medium">Price</th>
                <th className="text-right px-3 py-2 font-medium">FMV</th>
              </>
            )}
            <th className="w-16" />
          </tr>
        </thead>
        <tbody>
          {transactions.map(txn => {
            if (txn.transaction_type === 'proceeds') escrowBalance += Number(txn.proceeds_escrow ?? 0)
            if (txn.transaction_type === 'escrow_receipt') escrowBalance = Math.max(0, escrowBalance - Number(txn.proceeds_received ?? 0))
            const escrowAtEnd = escrowBalance
            const round = summary?.rounds.find(r => r.roundName === txn.round_name)
            const isFx = txn.valuation_change_source === 'fx'
            const isOpen = openRows.has(txn.id)
            return (
              <Fragment key={txn.id}>
              <tr className="border-b last:border-b-0">
                {showGroup && <td className="px-3 py-2 text-xs">{txn.portfolio_group ?? '-'}</td>}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {isFx ? (
                      <button
                        type="button"
                        onClick={() => toggleRow(txn.id)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Hide FX detail' : 'Show FX detail'}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {isOpen
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    ) : hasFxRows ? (
                      <span className="w-3.5" aria-hidden="true" />
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {/* A conversion is stored as an investment; surface it as a Conversion so the
                          row is identifiable and distinct from a plain investment. */}
                      {(txn as any).converts_from_txn_id
                        ? TYPE_LABELS.conversion
                        : TYPE_LABELS[txn.transaction_type as TransactionType] ?? txn.transaction_type}
                    </span>
                    {isFx && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        FX
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">{txn.round_name ?? '-'}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {txn.transaction_date
                    ? new Date(txn.transaction_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                    : '-'}
                </td>
                {companyStatus === 'exited' ? (
                  <>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'investment' ? fmt(txn.investment_cost) : '-'}
                    </td>
                    {hasInterestConversion && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(txn as { converts_from_txn_id?: string | null }).converts_from_txn_id && Number(txn.interest_converted ?? 0) > 0
                          ? fmt(txn.interest_converted)
                          : '-'}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'proceeds'
                        ? fmt(txn.proceeds_received)
                        : txn.transaction_type === 'escrow_receipt'
                        ? fmt(txn.proceeds_received)
                        : '-'}
                    </td>
                    {hasEscrow && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(txn.transaction_type === 'proceeds' || txn.transaction_type === 'escrow_receipt')
                          ? fmt(escrowAtEnd)
                          : '-'}
                      </td>
                    )}
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'investment' ? fmt(txn.investment_cost) : '-'}
                    </td>
                    {hasPostmoney && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(txn.transaction_type === 'investment' || txn.transaction_type === 'round_info')
                          ? fmt(txn.postmoney_valuation)
                          : '-'}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'investment'
                        ? fmtNum(txn.shares_acquired)
                        : txn.transaction_type === 'split'
                        // The ratio belongs in the shares column: a split is an event about the
                        // share count, and it has nothing to put in any of the money columns.
                        ? `× ${fmtNum((txn as { split_ratio?: number | null }).split_ratio)}`
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'investment'
                        ? fmtPrice(txn.share_price)
                        : txn.transaction_type === 'unrealized_gain_change'
                        ? fmtPrice(txn.current_share_price)
                        : txn.transaction_type === 'round_info'
                        ? fmtPrice(txn.share_price)
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {txn.transaction_type === 'investment' && round
                        ? (() => {
                            const isPricedEquity = (txn.shares_acquired ?? 0) > 0 && ((txn.share_price != null && txn.share_price > 0) || (txn.investment_cost ?? 0) > 0)
                            // A priced row's FMV is its share of the round's total value, prorated by
                            // shares. This ties the per-row number to the company/round total — a
                            // round with no remaining cost basis (free shares, or a $0-cost row with
                            // no conversion link) has currentValue 0, so the row reads $0 too, rather
                            // than showing a phantom shares × price the totals don't count.
                            if (isPricedEquity) {
                              return fmt(round.sharesAcquired > 0
                                ? round.currentValue * ((txn.shares_acquired ?? 0) / round.sharesAcquired)
                                : 0)
                            }
                            return fmt(
                              round.investmentCost > 0
                                ? (txn.investment_cost ?? 0) / round.investmentCost * round.currentValue
                                : txn.investment_cost ?? 0
                            )
                          })()
                        : txn.transaction_type === 'unrealized_gain_change'
                        ? fmt(txn.unrealized_value_change)
                        : '-'}
                    </td>
                  </>
                )}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1 justify-end">
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => openEdit(txn)}
                      className="h-7 px-1.5 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      onClick={() => handleDelete(txn.id)}
                      disabled={deletingId === txn.id}
                      className="h-7 px-1.5 text-muted-foreground hover:text-destructive"
                    >
                      {deletingId === txn.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
              {isFx && isOpen && (
                <tr className="border-b last:border-b-0 bg-muted/20">
                  <td colSpan={colCount} className="px-3 py-3">
                    <FxDetailPanel
                      txn={txn}
                      fundCurrency={fundCurrency}
                      fmt={fmt}
                      fmtPrice={fmtPrice}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function RoundSummaryTable({
  summary,
  transactions,
  showGroup,
  fmt,
  fmtMoic: fmtMoicFn,
}: {
  summary: CompanyInvestmentSummary
  transactions: InvestmentTransaction[]
  showGroup: boolean
  fmt: (v: number | null | undefined) => string
  fmtMoic: (v: number | null | undefined) => string
}) {
  // A conversion source and its target can be different tracker rounds even when the target is
  // the same economic security as an existing purchase (for example, a note converting into the
  // existing Series Seed Preferred at the same price). Merge only that case. Different security
  // classes or prices remain separate rows because that distinction is useful for performance.
  const txnById = new Map(transactions.map(txn => [txn.id, txn]))
  const convertedSourceToTarget = new Map<string, string>()
  for (const txn of transactions) {
    const sourceId = (txn as { converts_from_txn_id?: string | null }).converts_from_txn_id
    if (txn.transaction_type === 'investment' && sourceId) {
      const source = txnById.get(sourceId)
      if (source?.round_name && txn.round_name && source.round_name !== txn.round_name) {
        const targetPurchase = transactions.find(candidate =>
          candidate.id !== txn.id &&
          candidate.transaction_type === 'investment' &&
          !(candidate as { converts_from_txn_id?: string | null }).converts_from_txn_id &&
          candidate.round_name === txn.round_name &&
          // Using the same canonical round name is an explicit user decision that these belong
          // together. Different round names remain separate for performance reporting.
          candidate.round_name === txn.round_name,
        )
        if (targetPurchase) convertedSourceToTarget.set(source.round_name, txn.round_name)
      }
    }
  }
  const mergedRounds = new Map<string, typeof summary.rounds[number]>()
  const mergedRoundNames = new Set<string>()
  for (const round of summary.rounds) {
    let displayName = round.roundName
    const seen = new Set<string>()
    while (convertedSourceToTarget.has(displayName) && !seen.has(displayName)) {
      seen.add(displayName)
      displayName = convertedSourceToTarget.get(displayName)!
    }
    const existing = mergedRounds.get(displayName)
    if (existing) {
      existing.investmentCost += round.investmentCost
      existing.sharesAcquired += round.sharesAcquired
      existing.totalRealized += round.totalRealized
      existing.totalEscrow += round.totalEscrow
      existing.escrowOutstanding += round.escrowOutstanding
      existing.costBasisExited += round.costBasisExited
      existing.unrealizedValueChange += round.unrealizedValueChange
    } else {
      mergedRounds.set(displayName, { ...round, roundName: displayName })
    }
    if (displayName !== round.roundName) mergedRoundNames.add(displayName)
  }
  const rounds = Array.from(mergedRounds.values()).map(round =>
    mergedRoundNames.has(round.roundName) ? { ...round, grossIrr: summary.grossIrr } : round,
  )
  const totInvested = rounds.reduce((s, r) => s + r.investmentCost, 0)
  const totProceeds = rounds.reduce((s, r) => s + r.totalRealized, 0)
  const totEscrow = rounds.reduce((s, r) => s + r.escrowOutstanding, 0)
  const totMoic = totInvested > 0 ? totProceeds / totInvested : null
  const roundGroupMap = new Map<string, string>()
  for (const txn of transactions) {
    if (txn.transaction_type === 'investment' && txn.round_name && txn.portfolio_group) {
      roundGroupMap.set(txn.round_name, txn.portfolio_group)
    }
  }
  return (
    <div className="border rounded-lg overflow-hidden mt-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {showGroup && <th className="text-left px-3 py-2 font-medium">Vehicle</th>}
            <th className="text-left px-3 py-2 font-medium">Round</th>
            <th className="text-right px-3 py-2 font-medium">Cost Basis</th>
            <th className="text-right px-3 py-2 font-medium">Proceeds</th>
            <th className="text-right px-3 py-2 font-medium">In escrow</th>
            <th className="text-right px-3 py-2 font-medium">Gross MOIC</th>
            <th className="text-right px-3 py-2 font-medium">Gross IRR</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map(r => {
            const roundProceeds = r.totalRealized
            const roundMoic = r.investmentCost > 0 ? roundProceeds / r.investmentCost : null
            return (
              <tr key={r.roundName} className="border-b last:border-b-0">
                {showGroup && <td className="px-3 py-2 text-xs">{roundGroupMap.get(r.roundName) ?? '-'}</td>}
                <td className="px-3 py-2">{r.roundName}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.investmentCost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(roundProceeds)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.escrowOutstanding > 0 ? fmt(r.escrowOutstanding) : '-'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoicFn(roundMoic)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.grossIrr != null && Math.abs(r.grossIrr) >= 0.0005
                    ? `${(r.grossIrr * 100).toFixed(1)}%`
                    : '-'}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="bg-muted/30 font-medium">
            {showGroup && <td className="px-3 py-2" />}
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(totInvested)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(totProceeds)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{totEscrow > 0 ? fmt(totEscrow) : '-'}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtMoicFn(totMoic)}</td>
            <td className="px-3 py-2 text-right tabular-nums">
              {summary.grossIrr != null && Math.abs(summary.grossIrr) >= 0.0005
                ? `${(summary.grossIrr * 100).toFixed(1)}%`
                : '-'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
