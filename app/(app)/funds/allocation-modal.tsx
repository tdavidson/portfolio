'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'

export type AllocationAction = 'management_fee' | 'expense' | 'gain' | 'distribution' | 'carry'

export const ALLOCATION_LABELS: Record<AllocationAction, { label: string; desc: string }> = {
  management_fee: { label: 'Management fee', desc: 'Accrue the fee for a period from the fund’s rate and each partner’s terms.' },
  expense: { label: 'Partnership expense', desc: 'An expense paid from cash.' },
  gain: { label: 'Realized gain', desc: 'Proceeds received above cost.' },
  distribution: { label: 'Distribution', desc: 'Cash out to partners, by amount per partner.' },
  carry: { label: 'Carried interest', desc: 'Move profit from partners to the GP, by amount per partner.' },
}

interface Partner { lpEntityId: string; name: string; commitment: number }
interface PreviewLine { accountCode: string; accountName: string; amount: number }
interface Preview { entryDate: string; memo: string | null; sourceType: string | null; postings: PreviewLine[] }

const today = () => new Date().toISOString().slice(0, 10)
const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }

/**
 * The standard entries, from their inputs, with the built entry shown before anything is
 * written — the same preview-then-confirm shape as the period close, and the same builder the
 * agent's allocation tool uses (lib/accounting/allocation-actions.ts).
 */
export function AllocationModal({ action, onClose, onSaved }: { action: AllocationAction; onClose: () => void; onSaved: () => void }) {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const info = ALLOCATION_LABELS[action]
  const perPartner = action === 'distribution' || action === 'carry'

  const [entryDate, setEntryDate] = useState(today())
  const [memo, setMemo] = useState('')
  const [reference, setReference] = useState('')
  const [annualRate, setAnnualRate] = useState('2')
  const [periodFraction, setPeriodFraction] = useState('0.25')
  const [amount, setAmount] = useState('')
  const [perLp, setPerLp] = useState<Record<string, string>>({})
  const [partners, setPartners] = useState<Partner[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!perPartner) return
    lf('/api/accounting/entities').then(r => (r.ok ? r.json() : [])).then((rows: Partner[]) => setPartners(Array.isArray(rows) ? rows : []))
  }, [lf, perPartner])

  const body = () => {
    const b: Record<string, unknown> = { action, entryDate, memo: memo.trim() || undefined, reference: reference.trim() || undefined }
    if (action === 'management_fee') { b.annualRate = num(annualRate) / 100; b.periodFraction = num(periodFraction) }
    if (action === 'expense' || action === 'gain') b.amount = num(amount)
    if (perPartner) b.perLp = Object.fromEntries(Object.entries(perLp).filter(([, v]) => num(v) > 0).map(([k, v]) => [k, num(v)]))
    return b
  }
  const ready = !!entryDate && (
    action === 'management_fee' ? num(annualRate) > 0 && num(periodFraction) > 0
    : action === 'expense' || action === 'gain' ? num(amount) > 0
    : Object.values(perLp).some(v => num(v) > 0))

  const post = (payload: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const errOf = async (r: Response, fallback: string) => (await r.json().catch(() => ({}))).error ?? fallback

  async function runPreview() {
    setBusy(true); setError(null)
    const res = await lf('/api/accounting/allocation', post({ ...body(), preview: true }))
    if (!res.ok) { setError(await errOf(res, 'Could not build the entry')); setBusy(false); return }
    setPreview((await res.json()).entry)
    setBusy(false)
  }

  async function write(status: 'draft' | 'posted') {
    setBusy(true); setError(null)
    const res = await lf('/api/accounting/allocation', post({ ...body(), status }))
    if (!res.ok) { setError(await errOf(res, 'Could not save the entry')); setBusy(false); return }
    setBusy(false); onSaved(); onClose()
  }

  const field = 'mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm'
  const label = 'text-xs text-muted-foreground'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-base font-medium">{info.label}</h2>
            <p className="text-xs text-muted-foreground">{info.desc}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={label}>Date<input type="date" value={entryDate} onChange={e => { setEntryDate(e.target.value); setPreview(null) }} className={field} /></label>
            <label className={label}>Reference<input value={reference} onChange={e => setReference(e.target.value)} placeholder="Optional" maxLength={80} className={field} /></label>
            <label className={label}>Memo<input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Optional" className={field} /></label>
          </div>

          {action === 'management_fee' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={label}>Annual rate, % of commitment<input inputMode="decimal" value={annualRate} onChange={e => { setAnnualRate(e.target.value); setPreview(null) }} className={`${field} tabular-nums`} /></label>
              <label className={label}>Period
                <select value={periodFraction} onChange={e => { setPeriodFraction(e.target.value); setPreview(null) }} className={field}>
                  <option value="0.0833333333">One month</option>
                  <option value="0.25">One quarter</option>
                  <option value="0.5">Half year</option>
                  <option value="1">Full year</option>
                </select>
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">Side letters from Allocation terms apply — a partner with a rate override or who does not bear the fee is handled there.</p>
            </div>
          )}
          {(action === 'expense' || action === 'gain') && (
            <label className={label}>{action === 'expense' ? 'Amount paid from cash' : 'Proceeds received'}<input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setPreview(null) }} className={`${field} tabular-nums`} /></label>
          )}
          {perPartner && (
            <div>
              <div className={label}>{action === 'distribution' ? 'Distribution per partner' : 'Carry per partner'}</div>
              {partners.length === 0 ? (
                <p className="text-sm text-muted-foreground mt-1">No partners with a commitment in this vehicle.</p>
              ) : (
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {partners.map(p => (
                      <tr key={p.lpEntityId} className="border-t">
                        <td className="py-1 pr-2">{p.name}<span className="ml-2 text-xs text-muted-foreground tabular-nums">committed {fmt(p.commitment)}</span></td>
                        <td className="w-36 py-1"><input inputMode="decimal" value={perLp[p.lpEntityId] ?? ''} onChange={e => { setPerLp(prev => ({ ...prev, [p.lpEntityId]: e.target.value })); setPreview(null) }} className="w-full rounded border border-input bg-transparent px-1.5 py-1 text-right tabular-nums text-xs" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {preview && (
            <div className="rounded-lg border">
              <div className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                The entry — {preview.entryDate}{preview.sourceType ? ` · ${preview.sourceType.replace(/_/g, ' ')}` : ''}{preview.memo ? ` · ${preview.memo}` : ''}
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="px-3 py-1 font-medium">Account</th><th className="w-32 px-3 py-1 text-right font-medium">Debit</th><th className="w-32 px-3 py-1 text-right font-medium">Credit</th></tr></thead>
                <tbody>
                  {preview.postings.map((p, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1"><span className="tabular-nums text-muted-foreground mr-2">{p.accountCode}</span>{p.accountName}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{p.amount > 0 ? fmt(p.amount) : ''}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{p.amount < 0 ? fmt(-p.amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t p-4">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          {!preview ? (
            <Button size="sm" onClick={runPreview} disabled={busy || !ready}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Preview entry</Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => write('draft')} disabled={busy}>Save draft</Button>
              <Button size="sm" onClick={() => write('posted')} disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Post</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
