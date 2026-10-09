'use client'

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { FeeLinkView } from '@/lib/forecast/service'

const selectCls = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

/**
 * Which funds pay which management company, and on what cycle. A link is never inferred: a manco's
 * linked-fee rule forecasts nothing until one exists. Saving needs write on both vehicles — the
 * server says so if the caller lacks either.
 */
export function FeeLinksDialog({ open, vehicle, onClose, onChanged }: {
  open: boolean
  vehicle: string
  onClose: () => void
  onChanged: () => void
}) {
  const [links, setLinks] = useState<FeeLinkView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manco, setManco] = useState('')
  const [fund, setFund] = useState('')
  const [every, setEvery] = useState('3')
  const [anchor, setAnchor] = useState('1')
  const [direction, setDirection] = useState<'advance' | 'arrears'>('advance')
  const [lag, setLag] = useState('0')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/accounting/forecast/fee-links?group=${encodeURIComponent(vehicle)}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed')
      setLinks(body.links)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [vehicle])

  useEffect(() => {
    if (!open) return
    load()
    setManco(vehicle)
    setFund('')
  }, [open, load, vehicle])

  const send = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/accounting/forecast/fee-links', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? 'Failed')
      await load()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fee links</DialogTitle>
          <DialogDescription>
            A fee link says a fund pays a management company, and when. The fee amount always comes from the fund’s
            portfolio-construction fee terms, so the fund’s expense and the management company’s revenue use the same schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {links.length === 0 && <p className="text-sm text-muted-foreground">No links touch {vehicle}.</p>}
          {links.map(l => (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div>
                <div>{l.fund ?? 'A managed fund (details restricted)'} → {l.manco}</div>
                <div className="text-xs text-muted-foreground">{l.description}{l.active ? '' : ' · inactive'}</div>
              </div>
              {l.fund && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => send('DELETE', { manco: l.manco, fund: l.fund })} aria-label="Remove link">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 border-t pt-4">
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Management company</span>
            <Input value={manco} onChange={e => setManco(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Fund</span>
            <Input value={fund} onChange={e => setFund(e.target.value)} placeholder="Fund name" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Billed</span>
            <select className={selectCls} value={every} onChange={e => setEvery(e.target.value)}>
              <option value="1">Monthly</option><option value="3">Quarterly</option><option value="6">Semiannually</option><option value="12">Annually</option>
            </select></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">In</span>
            <select className={selectCls} value={direction} onChange={e => setDirection(e.target.value as any)}>
              <option value="advance">Advance</option><option value="arrears">Arrears</option>
            </select></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Cycle starts in month (1–12)</span>
            <Input inputMode="numeric" value={anchor} onChange={e => setAnchor(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Cash arrives months later</span>
            <Input inputMode="numeric" value={lag} onChange={e => setLag(e.target.value)} /></label>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button disabled={busy || !manco.trim() || !fund.trim()} onClick={() => send('PUT', {
            manco: manco.trim(), fund: fund.trim(), everyMonths: Number(every), anchorMonth: Number(anchor),
            direction, cashLagMonths: Number(lag),
          })}>{busy ? 'Saving…' : 'Save link'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
