'use client'

import { useState } from 'react'
import { CheckCircle2, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'

/**
 * A distribution's calculation as a workbook: terms, tiers, the waterfall's position before and
 * after, and each partner's line as return of capital, preferred return, profit and carry. For a
 * declared distribution pass `id`; for a preview pass the inputs the preview ran on.
 */
export function DistributionWorkbookLink(props: { id: string } | { total: number; asOf: string; method: 'waterfall' | 'pro_rata'; description?: string | null }) {
  const { group } = useVehicle()
  const qs = new URLSearchParams(group ? { group } : {})
  if ('id' in props) qs.set('id', props.id)
  else {
    qs.set('total', String(props.total))
    qs.set('asOf', props.asOf)
    qs.set('method', props.method)
    if (props.description) qs.set('description', props.description)
  }
  return (
    <Button size="sm" variant="outline" asChild className="gap-1.5" title="The calculation, line by line, with the checks">
      <a href={`/api/accounting/distributions/workbook?${qs.toString()}`}><Download className="h-3.5 w-3.5" />Calculation (.xlsx)</a>
    </Button>
  )
}

export interface SignOff { by: string | null; at: string; note: string | null }

/**
 * Who checked a declared distribution's calculation against the waterfall and the LPA. Nothing is
 * gated on it; it records that a person looked, and says so when nobody has.
 */
export function DistributionSignOff({ id, signOff, onChanged }: { id: string; signOff: SignOff | null | undefined; onChanged: () => void }) {
  const lf = useLedgerFetch()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(clear: boolean) {
    setBusy(true); setError(null)
    const res = await lf('/api/accounting/distributions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sign_off', distributionId: id, note: clear ? null : note || null, clear }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(data.error ?? 'Could not record the sign-off'); return }
    setOpen(false); setNote('')
    onChanged()
  }

  if (signOff) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        <span>Calculation reviewed by {signOff.by ?? 'a team member'} on {signOff.at.slice(0, 10)}{signOff.note ? ` — ${signOff.note}` : ''}</span>
        <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={busy} onClick={() => send(true)}>Withdraw</button>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    )
  }
  return (
    <div className="mt-2 text-xs">
      {!open ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>Calculation not yet reviewed.</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setOpen(true)}>Mark reviewed</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What you checked (optional)"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            maxLength={2000}
          />
          <Button size="sm" onClick={() => send(false)} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Sign off'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null) }} disabled={busy}>Cancel</Button>
          {error && <span className="w-full text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Void a declared distribution (admins): its declaration comes off the books and the register row
 * is kept, marked void. Refused while anything has been paid against it. A declaration in a closed
 * period is reversed on a date in an open one instead.
 */
export function DistributionVoid({ id, paid, onChanged }: { id: string; paid: number; onChanged: () => void }) {
  const lf = useLedgerFetch()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reverseDate, setReverseDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setBusy(true); setError(null)
    const res = await lf('/api/accounting/distributions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'void', distributionId: id, reason, reverseDate: reverseDate || null }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(data.error ?? 'Could not void the distribution'); return }
    setOpen(false); setReason(''); setReverseDate('')
    onChanged()
  }

  if (!open) {
    return (
      <button type="button" className="text-xs text-primary hover:underline" onClick={() => setOpen(true)}
        title={paid > 0 ? 'Payments have been made against it: void or reverse those first' : 'Take the declaration off the books'}>
        Void distribution
      </button>
    )
  }
  return (
    <div className="mt-2 flex w-full flex-wrap items-center gap-2 text-xs">
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)" maxLength={2000}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" />
      <label className="flex items-center gap-1 text-muted-foreground" title="Only when the declaration is in a closed period: reverse it on this date instead">
        Reverse on
        <input type="date" value={reverseDate} onChange={e => setReverseDate(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
      </label>
      <Button size="sm" variant="destructive" onClick={send} disabled={busy || !reason.trim()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Void'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null) }} disabled={busy}>Cancel</Button>
      {error && <span className="w-full text-destructive">{error}</span>}
    </div>
  )
}
