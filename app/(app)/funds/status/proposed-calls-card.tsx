'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileText, Loader2, AlertTriangle, CircleSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrency } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { useCanRead, useCanWrite, useIsAdmin } from '@/components/access-context'

interface Missing { field: string; label: string; why: string; required: boolean }
interface Flag { code: string; severity: 'blocker' | 'warning'; message: string; date?: string }
interface Line { lpEntityId: string; name: string; commitment: number; share: number; amount: number; remainingAfter: number | null }
interface Draft {
  id: string; status: string; total: number; description: string; noticeDate: string | null; dueDate: string | null
  earliestDueDate: string | null; noticePeriod: { days: number; basis: string } | null
  lines: Line[]; missing: Missing[]; flags: Flag[]; approvable: boolean; needsAcknowledgement: boolean
}

/**
 * Capital calls proposed but not yet issued. Each shows every LP's share from stored commitments,
 * what is missing and which dates fall inside the LPA notice period. An admin approves here: the
 * call is issued and each LP's own notice goes to their portal. No LP sees a proposal. Renders
 * nothing when there are none.
 */
export function ProposedCallsCard({ onApproved }: { onApproved?: () => void }) {
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const currency = useCurrency()
  const canRead = useCanRead('lp_capital')
  const canWrite = useCanWrite('lp_capital')
  const isAdmin = useIsAdmin()
  const [drafts, setDrafts] = useState<Draft[] | null>(null)

  const load = useCallback(async () => {
    const list = await lf('/api/accounting/proposed-calls?status=proposed').then(r => (r.ok ? r.json() : { calls: [] })).catch(() => ({ calls: [] }))
    const full = await Promise.all(((list.calls ?? []) as { id: string }[]).map(d =>
      lf(`/api/accounting/proposed-calls?id=${encodeURIComponent(d.id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null)))
    setDrafts(full.filter(Boolean) as Draft[])
  }, [lf])
  useEffect(() => { if (canRead) load() }, [canRead, load])

  if (!canRead || !drafts || drafts.length === 0) return null
  const fmt = (n: number) => formatCurrency(n, currency)
  const pdfHref = (draftId: string, lp: string) =>
    `/api/accounting/proposed-calls/pdf?id=${encodeURIComponent(draftId)}&lp=${encodeURIComponent(lp)}${group ? `&group=${encodeURIComponent(group)}` : ''}`

  return (
    <div className="rounded-card border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <p className="flex items-center gap-2 text-sm font-medium"><FileText className="h-4 w-4 text-muted-foreground" />Proposed capital calls</p>
        <span className="text-xs text-muted-foreground">Not issued · invisible to LPs</span>
      </div>
      <ul className="divide-y">
        {drafts.map(d => (
          <DraftRow key={d.id} d={d} fmt={fmt} pdfHref={pdfHref} canWrite={canWrite} isAdmin={isAdmin} lf={lf}
            onChange={() => { load(); onApproved?.() }} />
        ))}
      </ul>
    </div>
  )
}

function DraftRow({ d, fmt, pdfHref, canWrite, isAdmin, lf, onChange }: {
  d: Draft; fmt: (n: number) => string; pdfHref: (id: string, lp: string) => string
  canWrite: boolean; isAdmin: boolean; lf: ReturnType<typeof useLedgerFetch>; onChange: () => void
}) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'discard' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function act(action: 'approve' | 'discard') {
    setBusy(action); setErr(null)
    const res = await lf('/api/accounting/proposed-calls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id: d.id, acknowledge: ack }),
    })
    setBusy(null)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not complete that'); return }
    onChange()
  }

  const blockers = d.flags.filter(f => f.severity === 'blocker')
  const warnings = d.flags.filter(f => f.severity === 'warning')

  return (
    <li className="space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          <span className="tabular-nums">{fmt(d.total)}</span>
          <span className="text-muted-foreground"> · {d.description}</span>
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          notice {d.noticeDate ?? 'date missing'} · due {d.dueDate ?? 'date missing'}
          {d.noticePeriod && d.earliestDueDate && <> · earliest due {d.earliestDueDate} ({d.noticePeriod.days} {d.noticePeriod.basis === 'business' ? 'business ' : ''}days)</>}
        </p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-normal">LP</th>
            <th className="py-1 font-normal text-right">Commitment</th>
            <th className="py-1 font-normal text-right">Share</th>
            <th className="py-1 font-normal text-right">This call</th>
            <th className="py-1 font-normal text-right">Uncalled after</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {d.lines.map(l => (
            <tr key={l.lpEntityId} className="border-t">
              <td className="py-1">{l.name}</td>
              <td className="py-1 text-right tabular-nums">{fmt(l.commitment)}</td>
              <td className="py-1 text-right tabular-nums">{(l.share * 100).toFixed(2)}%</td>
              <td className="py-1 text-right tabular-nums">{fmt(l.amount)}</td>
              <td className="py-1 text-right tabular-nums">{l.remainingAfter == null ? '—' : fmt(l.remainingAfter)}</td>
              <td className="py-1 text-right">
                <a href={pdfHref(d.id, l.lpEntityId)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">Preview</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(d.missing.length > 0 || d.flags.length > 0) && (
        <div className="space-y-1.5 text-xs">
          {d.missing.map(m => (
            <p key={m.field} className="flex items-start gap-1.5">
              <CircleSlash className={`h-3.5 w-3.5 mt-px shrink-0 ${m.required ? 'text-destructive' : 'text-muted-foreground'}`} />
              <span><span className="font-medium">Missing: {m.label}.</span> <span className="text-muted-foreground">{m.why}</span></span>
            </p>
          ))}
          {[...blockers, ...warnings].map((f, i) => (
            <p key={`${f.code}-${i}`} className="flex items-start gap-1.5">
              <AlertTriangle className={`h-3.5 w-3.5 mt-px shrink-0 ${f.severity === 'blocker' ? 'text-destructive' : 'text-warning'}`} />
              <span>{f.message}</span>
            </p>
          ))}
        </div>
      )}

      {canWrite && !isAdmin && <p className="text-xs text-muted-foreground">An admin proposes, revises and approves capital calls.</p>}
      {canWrite && isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          {d.approvable && d.needsAcknowledgement && (
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
              I have read the items above and accept them
            </label>
          )}
          <Button size="sm" onClick={() => act('approve')} disabled={!d.approvable || (d.needsAcknowledgement && !ack) || busy !== null}>
            {busy === 'approve' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Approve and issue
          </Button>
          <Button size="sm" variant="outline" onClick={() => act('discard')} disabled={busy !== null}>
            {busy === 'discard' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Discard
          </Button>
          {!d.approvable && <span className="text-xs text-muted-foreground">Resolve the items marked in red before approving.</span>}
          {err && <span className="text-sm text-destructive">{err}</span>}
        </div>
      )}
    </li>
  )
}
