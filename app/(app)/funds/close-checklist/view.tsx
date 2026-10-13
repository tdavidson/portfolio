'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  STATUS_LABELS, TASK_STATUSES, TIE_OUT_LABELS, TIE_OUT_STATUSES, type TaskStatus, type TieOutStatus,
} from '@/lib/close-checklist/template'
import type { ChecklistSummaryRow, ChecklistView } from '@/lib/close-checklist/service'

const API = '/api/accounting/close-checklists'
const SELECT = 'border rounded-lg px-2 py-1 text-sm h-8 bg-background'

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? 'Failed')
  return body as T
}

const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export function CloseChecklistView() {
  const [lists, setLists] = useState<ChecklistSummaryRow[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<ChecklistView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  const loadList = useCallback(async () => {
    const { checklists } = await call<{ checklists: ChecklistSummaryRow[] }>(API)
    setLists(checklists)
    return checklists
  }, [])

  useEffect(() => {
    let live = true
    call<{ checklists: ChecklistSummaryRow[] }>(API)
      .then(({ checklists }) => { if (!live) return; setLists(checklists); if (checklists[0]) setSelected(checklists[0].id) })
      .catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!selected) return
    let live = true
    call<ChecklistView>(`${API}/${selected}`)
      .then(v => { if (live) setView(v) })
      .catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [selected])

  async function updateTask(task: string, change: { status?: TaskStatus; tie_out?: TieOutStatus }) {
    if (!view) return
    let note: string | undefined
    if (change.tie_out === 'exception') {
      note = window.prompt('What does not tie out?') ?? undefined
      if (!note) return
    }
    setBusy(true); setError(null)
    try {
      setView(await call<ChecklistView>(`${API}/${view.checklist.id}/tasks`, { method: 'PATCH', body: JSON.stringify({ updates: [{ task, ...change, note }] }) }))
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function moveDelivery(date: string) {
    if (!view || !date || date === view.checklist.lpDeliveryDate) return
    setBusy(true); setError(null)
    try {
      setView(await call<ChecklistView>(`${API}/${view.checklist.id}`, { method: 'PATCH', body: JSON.stringify({ lpDeliveryDate: date }) }))
      await loadList()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  if (lists === null && !error) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-2 rounded-card border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {lists && lists.length > 0 && (
          <select className={SELECT} value={selected ?? ''} onChange={e => setSelected(e.target.value)} aria-label="Checklist">
            {lists.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
          </select>
        )}
        <Button variant="outline" size="sm" onClick={() => setCreating(c => !c)}>{creating ? 'Cancel' : 'New checklist'}</Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {(creating || (lists && lists.length === 0)) && (
        <CreateForm onCreated={async v => { setCreating(false); await loadList(); setSelected(v.checklist.id); setView(v) }} onError={setError} />
      )}

      {view && (
        <>
          <div className="rounded-card border p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-6 text-sm">
              <div><div className="text-muted-foreground text-xs">Quarter-end</div><div className="tabular-nums">{fmt(view.checklist.periodEnd)}</div></div>
              <label className="block">
                <div className="text-muted-foreground text-xs">LP delivery</div>
                <Input type="date" className="h-8 w-40 tabular-nums" defaultValue={view.checklist.lpDeliveryDate} key={view.checklist.lpDeliveryDate}
                  onBlur={e => moveDelivery(e.target.value)} />
              </label>
              <div><div className="text-muted-foreground text-xs">Done</div><div className="tabular-nums">{view.summary.done} of {view.summary.tasks}</div></div>
              <div><div className="text-muted-foreground text-xs">Tied out</div><div className="tabular-nums">{view.summary.tiedOut} of {view.summary.needTieOut}</div></div>
              {view.summary.doneNotTiedOut > 0 && (
                <div><div className="text-muted-foreground text-xs">Done, not tied out</div><div className="tabular-nums text-warning">{view.summary.doneNotTiedOut}</div></div>
              )}
              {view.summary.overdue > 0 && (
                <div><div className="text-muted-foreground text-xs">Overdue</div><div className="tabular-nums text-destructive">{view.summary.overdue}</div></div>
              )}
            </div>
            {view.currentBlocker && (
              <p className="text-sm">
                <span className="font-medium">Blocking the most work: </span>{view.currentBlocker.title}
                <span className="text-muted-foreground"> — {view.currentBlocker.downstream} tasks wait on it, due {fmt(view.currentBlocker.dueDate)}.</span>
              </p>
            )}
            {view.warnings?.map(w => <p key={w} className="text-sm text-muted-foreground">{w}</p>)}
          </div>

          {view.groups.map(g => (
            <section key={g.owner} className="space-y-2">
              <h2 className="text-base font-medium">{g.label}</h2>
              <div className="rounded-card border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Task</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Tied out</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.tasks.map(t => (
                      <TableRow key={t.id}>
                        <TableCell className="max-w-md">
                          <div className="flex items-center gap-2">
                            <span>{t.title}</span>
                            {t.isCritical && <span className="rounded-sm bg-brand-100 px-1.5 text-xs dark:bg-brand-900">Critical</span>}
                          </div>
                          {t.blockedBy.length > 0 && <div className="text-xs text-muted-foreground">Waiting on: {t.blockedBy.join(', ')}</div>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{t.assignee ?? '—'}</TableCell>
                        <TableCell className={`tabular-nums whitespace-nowrap ${t.overdue ? 'text-destructive' : ''}`}>{fmt(t.dueDate)}</TableCell>
                        <TableCell>
                          <select className={SELECT} value={t.status} disabled={busy} aria-label={`Status of ${t.title}`}
                            onChange={e => updateTask(t.id, { status: e.target.value as TaskStatus })}>
                            {TASK_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                          </select>
                        </TableCell>
                        <TableCell>
                          {t.tieOut === 'not_required' ? <span className="text-muted-foreground">—</span> : (
                            <div>
                              <select className={SELECT} value={t.tieOut} disabled={busy || (t.status !== 'done' && t.tieOut === 'pending')}
                                aria-label={`Tie-out of ${t.title}`} onChange={e => updateTask(t.id, { tie_out: e.target.value as TieOutStatus })}>
                                {TIE_OUT_STATUSES.filter(s => s !== 'not_required').map(s => <option key={s} value={s}>{TIE_OUT_LABELS[s]}</option>)}
                              </select>
                              {t.tiedOutBy && <div className="text-xs text-muted-foreground">by {t.tiedOutBy}{t.tieOutNote ? `: ${t.tieOutNote}` : ''}</div>}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}

function CreateForm({ onCreated, onError }: { onCreated: (v: ChecklistView) => void; onError: (m: string) => void }) {
  const [form, setForm] = useState({ lpDeliveryDate: '', fundKind: 'venture', portfolioCompanies: '', administrator: '' })
  const [saving, setSaving] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      onCreated(await call<ChecklistView>(API, {
        method: 'POST',
        body: JSON.stringify({ ...form, portfolioCompanies: form.portfolioCompanies ? Number(form.portfolioCompanies) : null, administrator: form.administrator || null }),
      }))
    } catch (err: any) { onError(err.message) } finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="rounded-card border p-4 grid gap-3 sm:grid-cols-5 items-end text-sm">
      <label className="block">
        <div className="text-muted-foreground text-xs mb-1">LP delivery date</div>
        <Input type="date" required className="h-9" value={form.lpDeliveryDate} onChange={e => setForm(f => ({ ...f, lpDeliveryDate: e.target.value }))} />
      </label>
      <label className="block">
        <div className="text-muted-foreground text-xs mb-1">Fund</div>
        <select className={`${SELECT} h-9 w-full`} value={form.fundKind} onChange={e => setForm(f => ({ ...f, fundKind: e.target.value }))}>
          <option value="venture">Venture</option>
          <option value="pe">Private equity</option>
        </select>
      </label>
      <label className="block">
        <div className="text-muted-foreground text-xs mb-1">Portfolio companies</div>
        <Input type="number" min={0} className="h-9 tabular-nums" value={form.portfolioCompanies} onChange={e => setForm(f => ({ ...f, portfolioCompanies: e.target.value }))} />
      </label>
      <label className="block">
        <div className="text-muted-foreground text-xs mb-1">Administrator</div>
        <Input placeholder="Name, outsourced or in-house" className="h-9" value={form.administrator} onChange={e => setForm(f => ({ ...f, administrator: e.target.value }))} />
      </label>
      <Button type="submit" disabled={saving}>{saving ? 'Building…' : 'Build checklist'}</Button>
    </form>
  )
}
