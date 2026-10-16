'use client'

import { useEffect, useState } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// A vehicle's own letterhead (logo, name, address, email) for its LP statements, notices, receipts
// and letters (lib/vehicle-letterhead.ts). Each part falls back to the fund's on its own, so the
// fund's value shows as the placeholder of a blank one. Edited from the vehicle modal and from a
// partner's capital statement, which is where the letterhead is seen.
//
// Fetched on its own because logos are too heavy for the vehicle list. The logo saves as soon as
// it's picked, like the fund logo in settings; the text parts save with the surrounding form.

interface FundDefaults { name: string | null; address: string | null; email: string | null }

export interface VehicleLetterheadState {
  /** False while loading, and when the columns aren't migrated yet — the fields stay hidden. */
  available: boolean
  emailAvailable: boolean
  logo: string | null | undefined
  logoBusy: boolean
  logoErr: string | null
  pickLogo: (e: React.ChangeEvent<HTMLInputElement>) => void
  removeLogo: () => void
  name: string
  setName: (v: string) => void
  address: string
  setAddress: (v: string) => void
  email: string
  setEmail: (v: string) => void
  fund: FundDefaults
  /** The PATCH /api/vehicles fields for the text parts. Empty until loaded, so a slow fetch can't
   *  save blanks over a letterhead that exists. */
  payload: () => Record<string, string>
}

export function useVehicleLetterhead(vehicleId: string): VehicleLetterheadState {
  const [available, setAvailable] = useState(false)
  const [emailAvailable, setEmailAvailable] = useState(false)
  const [logo, setLogo] = useState<string | null | undefined>(undefined)
  const [logoBusy, setLogoBusy] = useState(false)
  const [logoErr, setLogoErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [fund, setFund] = useState<FundDefaults>({ name: null, address: null, email: null })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/vehicles?letterhead=${encodeURIComponent(vehicleId)}`).then(r => r.ok ? r.json() : null).then(data => {
      if (cancelled) return
      setAvailable(!!data?.available)
      setEmailAvailable(!!data?.emailAvailable)
      setLogo(data?.logo ?? null)
      setName(data?.name ?? '')
      setAddress(data?.address ?? '')
      setEmail(data?.email ?? '')
      if (data?.fund) setFund(data.fund)
    }).catch(() => { if (!cancelled) setLogo(null) })
    return () => { cancelled = true }
  }, [vehicleId])

  async function saveLogo(next: string | null) {
    const previous = logo ?? null
    setLogo(next); setLogoBusy(true); setLogoErr(null)
    const res = await fetch('/api/vehicles', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: vehicleId, logo: next }),
    })
    setLogoBusy(false)
    if (!res.ok) {
      setLogo(previous)
      setLogoErr((await res.json().catch(() => ({}))).error ?? 'Could not save logo')
    }
  }

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 200 * 1024) { setLogoErr('File must be under 200KB'); return }
    const reader = new FileReader()
    reader.onload = () => { void saveLogo(reader.result as string) }
    reader.readAsDataURL(file)
  }

  return {
    available, emailAvailable, logo, logoBusy, logoErr, pickLogo, removeLogo: () => { void saveLogo(null) },
    name, setName, address, setAddress, email, setEmail, fund,
    payload: () => !available ? {} : {
      letterheadName: name, letterheadAddress: address,
      ...(emailAvailable ? { letterheadEmail: email } : {}),
    },
  }
}

export function VehicleLetterheadFields({ lh, vehicleName }: { lh: VehicleLetterheadState; vehicleName: string }) {
  if (!lh.available) return null
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">Letterhead</label>
      <p className="text-[11px] text-muted-foreground">
        Replaces the fund&rsquo;s logo, name, address and email on this vehicle&rsquo;s capital account statements, notices,
        receipts and letters. Leave a part blank to keep the fund&rsquo;s. Logo max 200KB.
      </p>
      <div className="flex items-center gap-3">
        {lh.logo ? (
          <div className="relative">
            <img src={lh.logo} alt={`${vehicleName} logo`} className="h-12 w-auto max-w-[160px] rounded-sm border bg-background object-contain p-1" />
            <button
              onClick={lh.removeLogo}
              disabled={lh.logoBusy}
              aria-label="Remove logo"
              className="absolute -top-1.5 -right-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent">
            <ImagePlus className="h-4 w-4" />
            {lh.logo === undefined ? 'Loading…' : 'Choose file'}
            <input type="file" accept="image/*" onChange={lh.pickLogo} className="hidden" disabled={lh.logo === undefined || lh.logoBusy} />
          </label>
        )}
        {lh.logo && (
          <label className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
            Replace
            <input type="file" accept="image/*" onChange={lh.pickLogo} className="hidden" disabled={lh.logoBusy} />
          </label>
        )}
        {lh.logoBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>
      {lh.logoErr && <p className="text-sm text-destructive">{lh.logoErr}</p>}
      <Input value={lh.name} onChange={e => lh.setName(e.target.value)} placeholder={lh.fund.name ? `Name (fund: ${lh.fund.name})` : 'Name, e.g. Northwind Holdings'} className="h-8" />
      <Textarea value={lh.address} onChange={e => lh.setAddress(e.target.value)} placeholder={lh.fund.address ? `Address (fund: ${lh.fund.address})` : 'Address'} rows={3} />
      {lh.emailAvailable && (
        <Input type="email" value={lh.email} onChange={e => lh.setEmail(e.target.value)} placeholder={lh.fund.email ? `Email (fund: ${lh.fund.email})` : 'Email'} className="h-8" />
      )}
    </div>
  )
}

/** The letterhead on its own, for the capital statement page. */
export function VehicleLetterheadDialog({ vehicleId, vehicleName, onClose, onSaved }: {
  vehicleId: string
  vehicleName: string
  onClose: () => void
  onSaved: () => void
}) {
  const lh = useVehicleLetterhead(vehicleId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true); setErr(null)
    const res = await fetch('/api/vehicles', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: vehicleId, ...lh.payload() }),
    })
    setBusy(false)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not save letterhead'); return }
    onSaved()
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{vehicleName} details</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {lh.logo === undefined ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : !lh.available ? (
            <p className="text-sm text-muted-foreground">Per-vehicle letterheads need the 20261012120000_vehicle_letterhead.sql migration.</p>
          ) : (
            <VehicleLetterheadFields lh={lh} vehicleName={vehicleName} />
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            {/* The logo has already saved when picked; closing keeps it. */}
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Close</Button>
            <Button size="sm" onClick={save} disabled={busy || !lh.available}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
