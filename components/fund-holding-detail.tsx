'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCurrency, formatCurrency } from '@/components/currency-context'

interface RegisterEvent {
  id: string
  kind: 'call' | 'distribution'
  event_date: string
  amount: number
  notice_number: string | null
  status: 'draft' | 'confirmed'
  investment_transaction_id: string | null
  recallable_amount: number
}

interface NavStatement {
  id: string
  as_of_date: string
  reported_nav: number
  basis: 'final' | 'preliminary' | 'estimate'
}

/**
 * One fund holding: its register of notices received, and the manager NAVs recorded against it.
 *
 * Confirming a draft is what produces an investment_transactions row and a DRAFT ledger entry.
 * A confirm that reports `skipped: 'before_ledger_start'` is a success, not a failure — the
 * event predates the ledger cut-over, so it counts for every metric and posts nothing.
 */
export function FundHoldingDetail({
  companyId, onClose, onChanged,
}: { companyId: string; onClose: () => void; onChanged?: () => void }) {
  const currency = useCurrency()
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [events, setEvents] = useState<RegisterEvent[]>([])
  const [navs, setNavs] = useState<NavStatement[]>([])
  /** The entity that holds this fund, from its register. Null until the first notice names one. */
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [vehicleName, setVehicleName] = useState<string | null>(null)
  const [vehicleChoices, setVehicleChoices] = useState<{ id: string; name: string }[]>([])
  const [chosenVehicle, setChosenVehicle] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [eventForm, setEventForm] = useState({ kind: 'call', eventDate: '', amount: '' })
  const [navForm, setNavForm] = useState({ asOfDate: '', reportedNav: '', basis: 'final' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/portfolio/fund-holdings/${companyId}`)
      const json = await res.json()
      setName(json?.holding?.name ?? '')
      setEvents(json?.events ?? [])
      setNavs(json?.navStatements ?? [])
      const held: string | null = json?.vehicleId ?? null
      setVehicleId(held)
      setVehicleName(held ? (json?.vehicles ?? []).find((v: any) => v.id === held)?.name ?? null : null)
      // Only needed while the holding has no entity yet — one fetch, not on every render.
      if (!held) {
        const vr = await fetch('/api/accounting/vehicle-index').catch(() => null)
        const rows = vr && vr.ok ? await vr.json().catch(() => []) : []
        setVehicleChoices((Array.isArray(rows) ? rows : [])
          .filter((v: any) => v?.id && v?.name).map((v: any) => ({ id: v.id, name: v.name })))
      }
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { void load() }, [load])

  const fmt = (v: number) => formatCurrency(Number(v), currency)

  async function addEvent() {
    if (!eventForm.eventDate || !eventForm.amount) { setNotice('A date and an amount are required.'); return }
    if (!vehicleId && !chosenVehicle) { setNotice('Choose which entity holds this fund.'); return }
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(`/api/portfolio/fund-holdings/${companyId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: eventForm.kind,
          eventDate: eventForm.eventDate,
          amount: Number(eventForm.amount),
          // Named on the first notice; inferred from the register after that. A notice with no
          // entity cannot be confirmed and cannot be scoped to a schedule of investments.
          ...(vehicleId ? {} : { vehicleId: chosenVehicle }),
        }),
      })
      const json = await res.json()
      if (!res.ok) { setNotice(json?.error ?? 'Could not record the notice.'); return }
      setEventForm({ kind: 'call', eventDate: '', amount: '' })
      await load(); onChanged?.()
    } finally { setBusy(false) }
  }

  async function confirmEvent(eventId: string) {
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(`/api/portfolio/fund-holdings/${companyId}/events`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId }),
      })
      const json = await res.json()
      if (!res.ok) { setNotice(json?.error ?? 'Could not confirm.'); return }
      if (json?.skipped === 'before_ledger_start') {
        setNotice('Recorded, not posted — this event predates the ledger start date.')
      }
      await load(); onChanged?.()
    } finally { setBusy(false) }
  }

  async function addNav() {
    if (!navForm.asOfDate || !navForm.reportedNav) { setNotice('A valuation date and a NAV are required.'); return }
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(`/api/portfolio/fund-holdings/${companyId}/nav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asOfDate: navForm.asOfDate,
          reportedNav: Number(navForm.reportedNav),
          basis: navForm.basis,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setNotice(json?.error ?? 'Could not record the statement.'); return }
      setNavForm({ asOfDate: '', reportedNav: '', basis: 'final' })
      setNotice([json?.booking?.message, json?.later?.message ? `Newer statement: ${json.later.message}` : null].filter(Boolean).join(' ') || null)
      await load(); onChanged?.()
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{name || 'Fund holding'}</DialogTitle></DialogHeader>

        {loading ? (
          <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-6">
            {notice && <p className="text-sm text-warning">{notice}</p>}

            {/* WHICH ENTITY HOLDS THIS FUND. Asked once, on the first notice, then shown as a
                fact. The vehicle is recorded on the register rows and nowhere else, so without it
                a notice cannot be confirmed to the ledger and the holding cannot be scoped to one
                entity's schedule of investments. */}
            {vehicleId ? (
              <p className="text-sm text-muted-foreground">Held by <span className="font-medium text-foreground">{vehicleName ?? 'this entity'}</span>.</p>
            ) : (
              <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3">
                <Label htmlFor="holding-vehicle">Which entity holds this fund?</Label>
                <select
                  id="holding-vehicle"
                  value={chosenVehicle}
                  onChange={e => setChosenVehicle(e.target.value)}
                  className="border rounded-lg px-2 py-1 text-sm h-9 w-full max-w-xs bg-background"
                >
                  <option value="">Choose an entity…</option>
                  {vehicleChoices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <p className="text-caption text-muted-foreground">
                  Recorded with the first notice below. Until it is set, a notice cannot be confirmed to the ledger.
                </p>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-base font-medium">Notices received</h3>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="ev-kind">Kind</Label>
                  <select
                    id="ev-kind"
                    value={eventForm.kind}
                    onChange={e => setEventForm(f => ({ ...f, kind: e.target.value }))}
                    className="border rounded-lg px-2 py-1 text-sm h-9"
                  >
                    <option value="call">Call</option>
                    <option value="distribution">Distribution</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ev-date">Date</Label>
                  <Input id="ev-date" type="date" value={eventForm.eventDate}
                         onChange={e => setEventForm(f => ({ ...f, eventDate: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ev-amount">Amount</Label>
                  <Input id="ev-amount" type="number" className="tabular-nums" value={eventForm.amount}
                         onChange={e => setEventForm(f => ({ ...f, amount: e.target.value }))} />
                </div>
                <Button size="sm" onClick={addEvent} disabled={busy}>Record</Button>
              </div>

              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notices recorded yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map(e => (
                      <TableRow key={e.id}>
                        <TableCell className="tabular-nums">{e.event_date}</TableCell>
                        <TableCell className="capitalize">{e.kind}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(e.amount)}</TableCell>
                        <TableCell className="text-xs">
                          {e.status === 'confirmed'
                            ? (e.investment_transaction_id ? 'Confirmed · posted' : 'Confirmed · memo only')
                            : 'Draft'}
                        </TableCell>
                        <TableCell className="text-right">
                          {e.status === 'draft' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => confirmEvent(e.id)}>
                              Confirm
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-medium">Manager NAV statements</h3>
              <p className="text-xs text-muted-foreground">
                The valuation date is the manager&rsquo;s, not the date it arrived. Carrying value rolls
                the newest statement forward for calls and distributions received since.
              </p>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="nav-date">As of</Label>
                  <Input id="nav-date" type="date" value={navForm.asOfDate}
                         onChange={e => setNavForm(f => ({ ...f, asOfDate: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="nav-value">Reported NAV</Label>
                  <Input id="nav-value" type="number" className="tabular-nums" value={navForm.reportedNav}
                         onChange={e => setNavForm(f => ({ ...f, reportedNav: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="nav-basis">Basis</Label>
                  <select
                    id="nav-basis"
                    value={navForm.basis}
                    onChange={e => setNavForm(f => ({ ...f, basis: e.target.value }))}
                    className="border rounded-lg px-2 py-1 text-sm h-9"
                  >
                    <option value="final">Final</option>
                    <option value="preliminary">Preliminary</option>
                    <option value="estimate">Estimate</option>
                  </select>
                </div>
                <Button size="sm" onClick={addNav} disabled={busy}>Record</Button>
              </div>

              {navs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No statements received — the position carries at cost.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>As of</TableHead>
                      <TableHead className="text-right">Reported NAV</TableHead>
                      <TableHead>Basis</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {navs.map(n => (
                      <TableRow key={n.id}>
                        <TableCell className="tabular-nums">{n.as_of_date}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(n.reported_nav)}</TableCell>
                        <TableCell className="capitalize">{n.basis}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
