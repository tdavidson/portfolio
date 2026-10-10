'use client'

import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DialogControl } from '@/components/add-investment-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { VEHICLE_KIND_OPTIONS, isManagementCompany } from '@/lib/vehicle-kinds'

const KINDS = VEHICLE_KIND_OPTIONS

/**
 * Create a vehicle of any kind — fund, SPV, direct deal, GP entity, individual, management
 * company — from one modal. There used to be a second button for management companies alone; the
 * kind picker already listed them, so the two were one form with one option pre-chosen.
 *
 * The one thing that follows the kind is WHICH route is posted to. `/api/vehicles` is gated on
 * `accounting` and `/api/manco/vehicles` on `management_company`, and each grant is the one that
 * lets the caller SEE what they just made — so a management company goes to the manco route, which
 * is what lets a manco-only bookkeeper add one, and refuses one to someone who could not open it.
 */
export function AddVehicleButton({ onCreated, open: openProp, onOpenChange, hideTrigger }: { onCreated?: () => void } & DialogControl) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o) }
  const [name, setName] = useState('')
  const [kind, setKind] = useState('fund')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function create() {
    if (!name.trim()) return
    setBusy(true); setErr(null)
    const manco = isManagementCompany(kind)
    const res = await fetch(manco ? '/api/manco/vehicles' : '/api/vehicles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manco ? { name: name.trim() } : { name: name.trim(), kind }),
    })
    setBusy(false)
    if (!res.ok) {
      const fallback = res.status === 403
        ? (manco ? 'Adding a management company needs the Management company grant' : 'Adding a vehicle needs the Fund accounting grant')
        : 'Could not create vehicle'
      setErr((await res.json().catch(() => ({}))).error ?? fallback)
      return
    }
    setName(''); setKind('fund'); setOpen(false)
    onCreated?.()
  }

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setErr(null) }}>
      {!hideTrigger && (
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground">
          <Plus className="h-3.5 w-3.5" />Add vehicle
        </Button>
      </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add vehicle</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') create() }} placeholder="e.g. Fund IV, SPV — Acme, Acme Management LLC" autoFocus />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Type</label>
            <select value={kind} onChange={e => setKind(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
              {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={create} disabled={busy || !name.trim()}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Add vehicle</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
