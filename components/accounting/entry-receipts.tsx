'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, X, Upload } from 'lucide-react'
import { useLedgerFetch } from '@/components/accounting-vehicle'

interface ReceiptLite {
  id: string
  file_name: string
  vendor_name: string | null
  receipt_date: string | null
  amount: number | null
}

/**
 * The entry modal's evidence block: the receipts attached to this entry, and a way to add one.
 *
 * It saves on its own, independently of the entry's lines: attaching a receipt does not change
 * what the entry posts, so it does not need the entry unposted. Whether the entry is a partnership
 * expense is its lines' business: a debit to "Due from <fund>" is what bills the fund.
 */
export function EntryReceipts({ entryId }: { entryId: string }) {
  const lf = useLedgerFetch()
  const [receipts, setReceipts] = useState<ReceiptLite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const r = await lf(`/api/accounting/receipts?entryId=${entryId}`)
    const j = r.ok ? await r.json() : { receipts: [] }
    setReceipts(Array.isArray(j.receipts) ? j.receipts : [])
    setLoading(false)
  }, [lf, entryId])

  useEffect(() => { void load() }, [load])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true); setError(null)
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.set('file', f)
      form.set('entryId', entryId)
      const r = await lf('/api/accounting/receipts', { method: 'POST', body: form })
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? `Could not add ${f.name}`); break }
    }
    if (fileRef.current) fileRef.current.value = ''
    await load()
    setBusy(false)
  }

  async function detach(id: string) {
    setBusy(true); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'detach' }) })
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? 'Could not remove the receipt')
    await load()
    setBusy(false)
  }

  return (
    <div className="space-y-2 rounded-card border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium"><Paperclip className="h-3.5 w-3.5" />Receipts</span>
        <label className={`inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Add receipt
          <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={e => void upload(e.target.files)} />
        </label>
      </div>
      {loading ? null : receipts.length === 0 ? (
        <p className="text-xs text-muted-foreground">None attached. Add one here, or email it to the inbound address with “Receipt:” in the subject.</p>
      ) : (
        <ul className="space-y-1">
          {receipts.map(r => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
              <a href={`/api/accounting/receipts/${r.id}?redirect=1`} target="_blank" rel="noreferrer" className="truncate underline underline-offset-2">
                {r.vendor_name || r.file_name}
              </a>
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                {r.receipt_date && <span className="tabular-nums">{r.receipt_date}</span>}
                {r.amount != null && <span className="tabular-nums">{Number(r.amount).toFixed(2)}</span>}
                <button onClick={() => void detach(r.id)} disabled={busy} title="Detach from this entry (the receipt goes back to the Receipts page)" className="hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t pt-2 text-xs text-muted-foreground">
        Paid for one of the funds? Debit its “Due from” account instead of an expense, and it goes on that fund’s quarterly partnership invoice.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
