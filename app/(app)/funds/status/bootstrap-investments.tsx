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

import type { BackfillResult } from '@/lib/accounting/investment-backfill'
type Backfill = BackfillResult
const waiting = (p: Backfill) => p.toAdopt + p.toDerive + p.toPost
const conflictedOf = (p: Backfill | null) => p?.conflicted ?? []

export function BootstrapInvestmentsCard({ onBooked }: { onBooked?: () => void } = {}) {
  const lf = useLedgerFetch()
  const [preview, setPreview] = useState<Backfill | null>(null)
  const [result, setResult] = useState<Backfill | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const call = useCallback(async (dryRun: boolean): Promise<Backfill | null> => {
    const res = await lf('/api/accounting/investments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill', dryRun }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error ?? 'Failed'); return null }
    return data as Backfill
  }, [lf])

  // The preview is a POST (it shares the backfill's code path), so a member who can read accounting
  // but not write it is refused. That is not an error worth showing: the card simply isn't theirs.
  useEffect(() => {
    lf('/api/accounting/investments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill', dryRun: true }),
    }).then(r => (r.ok ? r.json() : null)).then(setPreview).catch(() => setPreview(null))
  }, [lf])

  async function run() {
    setBusy(true); setError(null)
    const r = await call(false)
    setBusy(false)
    if (!r) return
    setResult(r)
    setPreview(await call(true))
    onBooked?.()
  }

  if (!preview && !result && !error) return null
  if (preview && waiting(preview) === 0 && conflictedOf(preview).length === 0 && !result && !error) return null
  const conflicted = conflictedOf(preview ?? result)

  return (
    <div id="book-investments" className="space-y-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-1.5 text-success">
            <Check className="h-4 w-4" />
            Booked {result.posted} {result.posted === 1 ? 'entry' : 'entries'}{result.adopted > 0 ? `, recorded ${result.adopted} ${result.adopted === 1 ? 'transaction' : 'transactions'} from existing entries` : ''}{result.linked > 0 ? `, and matched ${result.linked} to the bank` : ''}.
          </p>
          {result.refused.length > 0 && (
            <div className="rounded-card border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-center gap-1.5 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" />{result.refused.length} not booked
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {result.refused.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
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

      {preview && waiting(preview) > 0 && (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-3 space-y-2">
          <p className="text-sm font-medium text-warning flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            {waiting(preview)} {waiting(preview) === 1 ? 'item has' : 'items have'} not reached the ledger.
          </p>
          <p className="text-xs text-muted-foreground">
            Each transaction books on its own date. Entries already on the books that record investments are read as the transactions they record. Running this again books nothing twice.
          </p>
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <BookOpen className="h-4 w-4 mr-1" />}
            Put them on the ledger
          </Button>
        </div>
      )}
    </div>
  )
}
