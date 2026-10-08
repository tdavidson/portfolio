'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import type { UnbankedInvestment } from '@/lib/accounting/investment-bank-match'
import { useCanWrite } from '@/components/access-context'

// Posted investment entries with no bank row (lib/accounting/investment-bank-match.ts).
//
// Each one is already on the books — a purchase, exit or cash income posts when it is recorded.
// This is reconciliation: link it to the bank transaction that paid it. Candidates are the rows of
// exactly its amount, nearest date first — suggested, never applied. Renders nothing when there is
// nothing to reconcile, including for a vehicle with no bank feed.

export function InvestmentMatchQueue({ onChanged }: { onChanged?: () => void }) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const lf = useLedgerFetch()
  const canWrite = useCanWrite('accounting')
  const [rows, setRows] = useState<UnbankedInvestment[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    lf('/api/accounting/investment-bank-match')
      .then(r => (r.ok ? r.json() : []))
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
  }, [lf])
  useEffect(() => { load() }, [load])

  async function link(entryId: string, bankTransactionId: string) {
    setBusy(entryId); setError(null)
    const res = await lf('/api/accounting/investment-bank-match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId, bankTransactionId }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setError(data.error ?? 'Could not link the bank transaction.'); return }
    if (data.warning) setError(data.warning)
    load(); onChanged?.()
  }

  if (rows.length === 0) return null

  return (
    <div className="border rounded-card p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Investments with no bank transaction</p>
        <p className="text-xs text-muted-foreground">
          These are on the books. Link each to the bank transaction that paid it — only one of the same amount can match.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y">
        {rows.map(r => (
          <li key={r.entryId} className="py-2 space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="tabular-nums text-muted-foreground">{r.entryDate}</span>
              <span className="flex-1 min-w-0 truncate">{r.memo ?? 'Investment entry'}</span>
              <span className="tabular-nums">{fmt(r.cash)}</span>
            </div>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2">
                {r.candidates.map(c => (
                  <Button key={c.id} size="sm" variant="outline" disabled={busy !== null} onClick={() => link(r.entryId, c.id)}>
                    {busy === r.entryId ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}
                    Link <span className="tabular-nums mx-1">{c.txnDate}</span>{c.description ? `· ${c.description}` : ''}
                  </Button>
                ))}
                {r.candidates.length === 0 && (
                  <span className="text-xs text-muted-foreground">No bank transaction of this amount yet.</span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
