'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Landmark } from 'lucide-react'
import { useCurrency, formatCurrency } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCanRead } from '@/components/access-context'

interface CallLine { name: string; amount: number; settled: number; outstanding: number; status: 'open' | 'partial' | 'settled'; ack?: { wiredOn: string | null } | null }
interface Call { id: string; callDate: string; dueDate: string | null; callNumber: number | null; description: string | null; total: number; settled: number; outstanding: number; status: 'open' | 'partial' | 'settled'; overdue: boolean; lines: CallLine[] }

/**
 * The entity's capital calls at a glance, on its Admin page: each open call's received and
 * outstanding, how many partners have paid, who says they wired, and whether it is overdue —
 * or, with none open, the most recent call. The detail (and recording a receipt) is on Capital
 * accounts. Reads /api/accounting/capital-calls, gated on LP capital like that page.
 */
export function CapitalCallsCard({ capitalHref }: { capitalHref: string }) {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const canRead = useCanRead('lp_capital')
  const [calls, setCalls] = useState<Call[] | null>(null)

  useEffect(() => {
    if (!canRead) return
    let cancelled = false
    lf('/api/accounting/capital-calls')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setCalls((d?.calls as Call[]) ?? []) })
      .catch(() => { if (!cancelled) setCalls([]) })
    return () => { cancelled = true }
  }, [lf, canRead])

  if (!canRead || !calls || calls.length === 0) return null
  const open = calls.filter(c => c.status !== 'settled')
  const shown = open.length > 0 ? open : calls.slice(0, 1)
  const fmt = (n: number) => formatCurrency(n, currency)

  return (
    <div className="rounded-card border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <p className="flex items-center gap-2 text-sm font-medium"><Landmark className="h-4 w-4 text-muted-foreground" />Capital calls</p>
        <Link href={capitalHref} className="text-xs text-muted-foreground hover:text-foreground">
          {open.length > 0 ? `${open.length} open` : 'All paid'} · Details
        </Link>
      </div>
      <ul className="divide-y">
        {shown.map(c => {
          const paid = c.lines.filter(l => l.status === 'settled').length
          const saysWired = c.lines.filter(l => l.status !== 'settled' && l.ack).length
          const pct = c.total > 0 ? Math.min(100, (c.settled / c.total) * 100) : 0
          return (
            <li key={c.id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm">
                  {c.callNumber != null ? `Call #${c.callNumber}` : 'Capital call'} · <span className="tabular-nums">{c.callDate}</span>
                  {c.description && <span className="text-muted-foreground"> · {c.description}</span>}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {c.dueDate ? `due ${c.dueDate}` : 'no due date'}
                  {c.overdue && <span className="ml-2 rounded-sm bg-destructive-subtle px-1.5 py-0.5 text-destructive">Overdue</span>}
                </p>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${Math.round(pct)}% received`}>
                <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {fmt(c.settled)} received of {fmt(c.total)}
                {c.outstanding > 0 && <> · <span className="text-foreground">{fmt(c.outstanding)} outstanding</span></>}
                {' '}· {paid} of {c.lines.length} partners paid
                {saysWired > 0 && <> · {saysWired} say{saysWired === 1 ? 's' : ''} they wired</>}
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
