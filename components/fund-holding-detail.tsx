'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCurrency, formatCurrency } from '@/components/currency-context'
import { FundHoldingNavs, type NavStatementRow } from '@/components/fund-holding-navs'
import { investingEntities, type EntityChoice } from '@/lib/portfolio/investing-entities'

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

/** What a NAV save, edit or delete did to the ledger, said back (lib/portfolio/fof-nav.ts). */
function bookingText(json: any): string | null {
  const later: string[] = (Array.isArray(json?.later) ? json.later : []).map((b: any) => b?.message).filter(Boolean)
  const parts = [json?.booking?.message, ...later.map(m => `Newer statement: ${m}`)].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/**
 * One fund holding, for one of the entities that holds it: its register of notices received and the
 * manager NAVs recorded against it.
 *
 * Confirming a notice books its transaction. Saving, editing or deleting a NAV books, re-books or
 * takes back its mark on the server (lib/portfolio/fof-nav.ts) — there is no separate "book the
 * mark" step, and the panel says what each save did to the ledger. Two entities holding the same
 * fund are two positions, so the panel shows one entity at a time and switches between them.
 */
export function FundHoldingDetail({
  companyId, vehicleId = null, onClose, onChanged,
}: {
  companyId: string
  /** The entity to open the register for. Omitted: the holding's first entity by name. */
  vehicleId?: string | null
  onClose: () => void
  onChanged?: () => void
}) {
  const currency = useCurrency()
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [events, setEvents] = useState<RegisterEvent[]>([])
  const [navs, setNavs] = useState<NavStatementRow[]>([])
  /** The entity shown. Null until the holding's first notice or statement names one. */
  const [entity, setEntity] = useState<string | null>(vehicleId)
  /** The holding's entities the caller can see. */
  const [held, setHeld] = useState<EntityChoice[]>([])
  /** Every investing entity the caller may record against, for a holding with no entity yet. */
  const [choices, setChoices] = useState<EntityChoice[]>([])
  const [chosenVehicle, setChosenVehicle] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [eventForm, setEventForm] = useState({ kind: 'call', eventDate: '', amount: '' })
  const [navForm, setNavForm] = useState({ asOfDate: '', reportedNav: '', basis: 'final' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = entity ? `?entity=${encodeURIComponent(entity)}` : ''
      const res = await fetch(`/api/portfolio/fund-holdings/${companyId}${qs}`)
      const json = await res.json()
      setName(json?.holding?.name ?? '')
      setEvents(json?.events ?? [])
      setNavs(json?.navStatements ?? [])
      setHeld(json?.vehicles ?? [])
      const shown: string | null = json?.vehicleId ?? null
      if (shown !== entity) setEntity(shown)
    } finally {
      setLoading(false)
    }
  }, [companyId, entity])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setChoices(investingEntities(rows)) })
      .catch(() => { if (!cancelled) setChoices([]) })
    return () => { cancelled = true }
  }, [])

  const fmt = (v: number) => formatCurrency(Number(v), currency)
  const entityName = held.find(v => v.id === entity)?.name ?? choices.find(v => v.id === entity)?.name ?? null
  /** Where a new notice or statement goes: the entity shown, or the one just chosen. */
  const target = entity ?? (chosenVehicle || null)

  async function send(url: string, init: RequestInit): Promise<any | null> {
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setNotice(json?.error ?? 'That did not save.'); return null }
      return json
    } finally {
      setBusy(false)
    }
  }

  async function addEvent() {
    if (!eventForm.eventDate || !eventForm.amount) { setNotice('A date and an amount are required.'); return }
    if (!target) { setNotice('Choose which entity holds this fund.'); return }
    const json = await send(`/api/portfolio/fund-holdings/${companyId}/events`, {
      method: 'POST',
      body: JSON.stringify({ kind: eventForm.kind, eventDate: eventForm.eventDate, amount: Number(eventForm.amount), vehicleId: target }),
    })
    if (!json) return
    setEventForm({ kind: 'call', eventDate: '', amount: '' })
    if (!entity) setEntity(target)
    await load(); onChanged?.()
  }

  async function confirmEvent(eventId: string) {
    const json = await send(`/api/portfolio/fund-holdings/${companyId}/events`, { method: 'PATCH', body: JSON.stringify({ eventId }) })
    if (!json) return
    const said = [
      json.skipped === 'before_ledger_start' ? 'Recorded, not posted — this notice predates the ledger start date.' : null,
      json.ledgerSkipped ? `Confirmed, not booked: ${json.ledgerSkipped}` : null,
      ...(Array.isArray(json.navRebooked) ? json.navRebooked : [])
        .map((b: any) => b?.message).filter(Boolean).map((m: string) => `NAV re-booked: ${m}`),
    ].filter(Boolean)
    setNotice(said.length ? said.join(' ') : null)
    await load(); onChanged?.()
  }

  async function addNav() {
    if (!navForm.asOfDate || !navForm.reportedNav) { setNotice('A valuation date and a NAV are required.'); return }
    if (!target) { setNotice('Choose which entity holds this fund.'); return }
    const json = await send(`/api/portfolio/fund-holdings/${companyId}/nav`, {
      method: 'POST',
      body: JSON.stringify({ asOfDate: navForm.asOfDate, reportedNav: Number(navForm.reportedNav), basis: navForm.basis, vehicleId: target }),
    })
    if (!json) return
    setNavForm({ asOfDate: '', reportedNav: '', basis: 'final' })
    setNotice(bookingText(json))
    if (!entity) setEntity(target)
    await load(); onChanged?.()
  }

  async function editNav(navId: string, fields: { reportedNav: number; basis: string }) {
    const json = await send(`/api/portfolio/fund-holdings/${companyId}/nav`, { method: 'PATCH', body: JSON.stringify({ navId, ...fields }) })
    if (!json) return
    setNotice(bookingText(json))
    await load(); onChanged?.()
  }

  async function deleteNav(navId: string) {
    if (!window.confirm('Delete this statement? Its mark comes off the ledger.')) return
    const json = await send(`/api/portfolio/fund-holdings/${companyId}/nav?navId=${encodeURIComponent(navId)}`, { method: 'DELETE' })
    if (!json) return
    setNotice(bookingText(json) ?? 'Statement deleted; its mark is off the ledger.')
    await load(); onChanged?.()
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{name || 'Fund holding'}</DialogTitle></DialogHeader>

        {loading ? (
          <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-6">
            {notice && <p role="status" className="text-sm">{notice}</p>}

            {/* WHICH ENTITY. Each entity's commitment, notices and statements are its own position. */}
            {held.length > 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="holding-entity">Entity</Label>
                <select
                  id="holding-entity"
                  value={entity ?? ''}
                  onChange={e => setEntity(e.target.value || null)}
                  className="border rounded-lg px-2 py-1 text-sm h-9 bg-background"
                >
                  {held.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <span className="text-xs text-muted-foreground">Each entity holds its own commitment, notices and statements.</span>
              </div>
            ) : entity ? (
              <p className="text-sm text-muted-foreground">Held by <span className="font-medium text-foreground">{entityName ?? 'this entity'}</span>.</p>
            ) : (
              <div className="space-y-1 rounded-lg border border-warning bg-warning-subtle p-3">
                <Label htmlFor="holding-vehicle">Which entity holds this fund?</Label>
                <select
                  id="holding-vehicle"
                  value={chosenVehicle}
                  onChange={e => setChosenVehicle(e.target.value)}
                  className="border rounded-lg px-2 py-1 text-sm h-9 w-full max-w-xs bg-background"
                >
                  <option value="">Choose an entity…</option>
                  {choices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <p className="text-sm text-muted-foreground">
                  Recorded with the first notice or statement below. A notice with no entity cannot be confirmed to the ledger.
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
                The valuation date is the manager&rsquo;s, not the date it arrived. Saving a statement books its mark to
                the ledger at that date; editing or deleting one re-books or removes it.
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

              <FundHoldingNavs navs={navs} busy={busy} onEdit={editNav} onDelete={deleteNav} />
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
