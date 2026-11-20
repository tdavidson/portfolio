'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Check, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLedgerFetch } from '@/components/accounting-vehicle'

// Putting the portfolio tracker's history on the ledger.
//
// A transaction recorded today derives its entry as it is saved. Ones recorded before that
// existed derived nothing, so a vehicle can track millions and carry nothing. This card runs the
// backfill (lib/accounting/investment-backfill.ts). It adopts the investment entries a QuickBooks
// import or a hand entry posted, derives an entry for every transaction that has none, and posts
// the entries the previous release left waiting for a bank match.
//
// Renders NOTHING unless there is something to book.

import type { BackfillResult, BackfillItem } from '@/lib/accounting/investment-backfill'
type Backfill = BackfillResult
/** What still needs booking: items a run would book, or that the ledger would refuse (with why). */
const actionable = (p: Backfill) => p.items.length > 0
  ? p.items.filter(i => i.status !== 'nothing').length
  : p.toAdopt + p.toDerive + p.toPost
const conflictedOf = (p: Backfill | null) => p?.conflicted ?? []
const money = (n: number) => {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `(${abs})` : abs
}

export function BootstrapInvestmentsCard({ onBooked }: { onBooked?: () => void } = {}) {
  const lf = useLedgerFetch()
  const [preview, setPreview] = useState<Backfill | null>(null)
  const [result, setResult] = useState<Backfill | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const call = useCallback(async (body: Record<string, unknown>): Promise<Backfill | null> => {
    const res = await lf('/api/accounting/investments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill', ...body }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error ?? 'Failed'); return null }
    return data as Backfill
  }, [lf])

  // The review is a POST (it shares the backfill's code path), so a member who can read accounting
  // but not write it is refused. That is not an error worth showing: the card simply isn't theirs.
  // It builds each waiting entry without writing it, so an item with nothing to book is known as
  // such before anyone is asked to book it.
  const loadReview = useCallback(async () => {
    const r = await lf('/api/accounting/investments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill', dryRun: true, review: true }),
    }).then(res => (res.ok ? res.json() : null)).catch(() => null) as Backfill | null
    setPreview(r)
    setPicked(new Set((r?.items ?? []).filter(i => i.status === 'book' || i.status === 'unchecked').map(i => i.key)))
    return r
  }, [lf])
  useEffect(() => { loadReview() }, [loadReview])

  async function run() {
    setBusy(true); setError(null)
    const r = await call({ select: Array.from(picked) })
    setBusy(false)
    if (!r) return
    setResult(r)
    setReviewing(false)
    await loadReview()
    onBooked?.()
  }

  if (!preview && !result && !error) return null
  const waiting = preview ? actionable(preview) : 0
  if (preview && waiting === 0 && conflictedOf(preview).length === 0 && !result && !error) return null
  const conflicted = conflictedOf(preview ?? result)
  const items = preview?.items ?? []
  const bookable = items.filter(i => i.status === 'book' || i.status === 'unchecked')
  const refusedItems = items.filter(i => i.status === 'refused')
  const nothingItems = items.filter(i => i.status === 'nothing')
  const toggle = (key: string) => setPicked(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const allPicked = bookable.length > 0 && bookable.every(i => picked.has(i.key))

  return (
    <div id="book-investments" className="space-y-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-1.5 text-success">
            <Check className="h-4 w-4" />
            {result.posted + result.adopted + result.linked === 0
              ? 'Nothing was booked.'
              : <>Booked {result.posted} {result.posted === 1 ? 'entry' : 'entries'}{result.adopted > 0 ? `, recorded ${result.adopted} ${result.adopted === 1 ? 'transaction' : 'transactions'} from existing entries` : ''}{result.linked > 0 ? `, and matched ${result.linked} to the bank` : ''}.</>}
          </p>
          {result.refused.length > 0 && (
            <div className="rounded-card border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-center gap-1.5 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" />{result.refused.length} could not be booked
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {result.refused.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
          {result.nothingToBook.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <p>{result.nothingToBook.length} had nothing to book, so there is nothing to do for {result.nothingToBook.length === 1 ? 'it' : 'them'}:</p>
              <ul className="mt-1 list-disc pl-5">{result.nothingToBook.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {conflicted.length > 0 && (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
            <AlertTriangle className="h-4 w-4" />
            {conflicted.length} {conflicted.length === 1 ? 'position is' : 'positions are'} carried by both the tracker and the journal
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Their journal entries were likely built from the tracker, so booking either side would count them twice. These are left alone: void the duplicate entries or delete the duplicate transactions, then run this again.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            {conflicted.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}

      {preview && waiting > 0 && (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-3 space-y-2">
          <p className="text-sm font-medium text-warning flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {waiting} investment {waiting === 1 ? 'item is' : 'items are'} not on the ledger yet
          </p>
          <p className="text-xs text-muted-foreground">
            The balance sheet and the schedule of investments leave {waiting === 1 ? 'it' : 'them'} out until booked. Review what each would book, pick the ones to put on the ledger, and each books on its own date. Booking again never books anything twice.
          </p>
          {!reviewing ? (
            <Button size="sm" onClick={() => setReviewing(true)}>
              <BookOpen className="h-4 w-4 mr-1" />Review and book
            </Button>
          ) : (
            <div className="space-y-2">
              {bookable.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="text-left">
                        <th className="w-6 py-1"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(bookable.map(i => i.key)))} aria-label="Select all" /></th>
                        <th className="py-1 pr-2 font-normal">Date</th>
                        <th className="py-1 pr-2 font-normal">Company</th>
                        <th className="py-1 pr-2 font-normal">What it books</th>
                        <th className="py-1 text-right font-normal">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bookable.map(i => <ItemRow key={i.key} item={i} checked={picked.has(i.key)} onToggle={() => toggle(i.key)} />)}
                    </tbody>
                  </table>
                </div>
              )}
              {refusedItems.length > 0 && (
                <div className="text-xs">
                  <p className="font-medium text-warning">{refusedItems.length} can&rsquo;t be booked until fixed:</p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {refusedItems.map(i => <li key={i.key}>{i.company}, {i.date}, {i.label}: {i.reason}</li>)}
                  </ul>
                </div>
              )}
              {items.some(i => i.status === 'unchecked') && (
                <p className="text-xs text-muted-foreground">There are too many to preview one by one; amounts show once each is booked.</p>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={run} disabled={busy || picked.size === 0}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <BookOpen className="h-4 w-4 mr-1" />}
                  Book {picked.size} selected
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setReviewing(false)} disabled={busy}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {preview && nothingItems.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {nothingItems.length} {nothingItems.length === 1 ? 'transaction has' : 'transactions have'} nothing to book (no action needed)
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {nothingItems.map(i => <li key={i.key}>{i.company}, {i.date}, {i.label}: {i.reason}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function ItemRow({ item, checked, onToggle }: { item: BackfillItem; checked: boolean; onToggle: () => void }) {
  const what = item.action === 'adopt' ? `${item.label}, recorded as transactions` : item.label
  return (
    <tr className="border-t border-border/60">
      <td className="py-1"><input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Book ${item.company} ${item.date}`} /></td>
      <td className="py-1 pr-2 tabular-nums whitespace-nowrap">{item.date}</td>
      <td className="py-1 pr-2">{item.company}</td>
      <td className="py-1 pr-2">{what}</td>
      <td className="py-1 text-right tabular-nums">{item.amount == null ? '—' : money(item.amount)}</td>
    </tr>
  )
}
