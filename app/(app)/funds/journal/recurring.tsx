'use client'

// The journal's Recurring tab: entries that repeat on a cadence (lib/accounting/recurring-entries.ts),
// each reminded, drafted or posted on its due dates, and the missed dates a person books after
// reviewing exactly what will be written.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AccountPicker, type PickerAccount } from '@/components/accounting/account-picker'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { ENTRY_SOURCE_TYPES, ENTRY_SOURCE_TYPE_LABELS } from '@/lib/accounting/source-types'

type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual'
type Mode = 'remind' | 'draft' | 'post'
interface Occurrence { date: string; amount: number; entryId: string | null; status: 'draft' | 'posted' | null; waitingForBill?: boolean }
interface Line { accountId: string; amount: number; lpEntityId: string | null; code: string | null; accountName: string | null }
interface Entry {
  id: string; name: string; memo: string | null; kind: 'fixed' | 'management_fee_spread'; templateKey: string | null; sourceType: string
  frequency: Frequency; dayOfMonth: number; startDate: string; endDate: string | null; mode: Mode; reminderDays: number
  requiredForClose: boolean; active: boolean; autoFrom: string | null; lastError: string | null
  cadence: string; amount: number; lines: Line[]; nextDue: string | null; lastBooked: Occurrence | null; missed: Occurrence[]; drafts: Occurrence[]
}
interface Template {
  key: string; name: string; description: string; frequency: Frequency; dayOfMonth: number; sourceType: string; memo: string | null
  lines: { accountId: string | null; side: 'debit' | 'credit'; label: string }[]; available: boolean; reason?: string
}
interface View { entries: Entry[]; templates: Template[] }
interface Acct { id: string; code: string; name: string; type?: string | null; lp_entity_id?: string | null; is_active?: boolean }
interface PreviewItem { date: string; memo: string; action: 'draft' | 'post' | 'post_draft' | 'skip'; reason?: string; lines: { code: string | null; account: string | null; amount: number }[] }

const SPREAD = 'management_fee_spread'
const FREQ_LABEL: Record<Frequency, string> = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every six months', annual: 'Yearly' }
const MODE_LABEL: Record<Mode, string> = { remind: 'Remind me', draft: 'Draft on the due date', post: 'Post on the due date' }
const MODE_HELP: Record<Mode, string> = {
  remind: 'The reminder digest lists each due date until it is booked, and the close suggests it.',
  draft: 'The daily run saves a draft on each due date for someone to review and post.',
  post: 'The daily run posts it on each due date.',
}
const today = () => new Date().toISOString().slice(0, 10)
const firstOfMonth = () => `${today().slice(0, 7)}-01`
const selectCls = 'w-full border border-border rounded-sm bg-background text-foreground px-2 py-1.5 text-sm'
const num = (s: string) => { const n = Number(s.replace(/[,$\s]/g, '')); return Number.isFinite(n) ? n : 0 }

interface DraftLine { key: number; accountId: string; debit: string; credit: string; lpEntityId: string | null }
interface Draft {
  id: string | null; kind: 'fixed' | 'management_fee_spread'; template: string | null
  name: string; memo: string; sourceType: string; frequency: Frequency; dayOfMonth: number
  startDate: string; endDate: string; mode: Mode; reminderDays: string; lines: DraftLine[]
}
let seq = 1
const blankLine = (): DraftLine => ({ key: seq++, accountId: '', debit: '', credit: '', lpEntityId: null })
const blankDraft = (): Draft => ({
  id: null, kind: 'fixed', template: null, name: '', memo: '', sourceType: 'manual', frequency: 'monthly', dayOfMonth: 31,
  startDate: firstOfMonth(), endDate: '', mode: 'remind', reminderDays: '3', lines: [blankLine(), blankLine()],
})

export function RecurringEntriesView() {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [view, setView] = useState<View | null>(null)
  const [accounts, setAccounts] = useState<Acct[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [review, setReview] = useState<Entry | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [r, chart] = await Promise.all([
      lf('/api/accounting/recurring-entries'),
      lf('/api/accounting/chart').then(x => (x.ok ? x.json() : [])).catch(() => []),
    ])
    const d = await r.json().catch(() => ({}))
    setAccounts(Array.isArray(chart) ? chart : [])
    if (!r.ok) { setError(d.error ?? 'Could not read the recurring entries'); setView({ entries: [], templates: [] }); return }
    setView(d)
  }, [lf])
  useEffect(() => { void load() }, [load])

  const act = async (key: string, body: Record<string, unknown>): Promise<any | null> => {
    setBusy(key); setError(null)
    const r = await lf('/api/accounting/recurring-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    setBusy(null)
    if (!r.ok) { setError(d.error ?? 'That did not work'); return null }
    return d
  }

  const pickerAccounts: PickerAccount[] = useMemo(() => accounts.filter(a => a.is_active !== false)
    .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, lpEntityId: a.lp_entity_id ?? null })), [accounts])

  const startFrom = (t: Template | null) => {
    if (!t) { setDraft(blankDraft()); return }
    if (t.key === SPREAD) {
      setDraft({ ...blankDraft(), kind: SPREAD, template: SPREAD, name: t.name, sourceType: t.sourceType, dayOfMonth: 1, lines: [] })
      return
    }
    setDraft({
      ...blankDraft(), template: t.key, name: t.name, memo: t.memo ?? '', sourceType: t.sourceType, frequency: t.frequency, dayOfMonth: t.dayOfMonth,
      lines: t.lines.map(l => ({ ...blankLine(), accountId: l.accountId ?? '' })),
    })
  }
  const editEntry = (e: Entry) => setDraft({
    id: e.id, kind: e.kind, template: e.templateKey, name: e.name, memo: e.memo ?? '', sourceType: e.sourceType, frequency: e.frequency,
    dayOfMonth: e.dayOfMonth, startDate: e.startDate, endDate: e.endDate ?? '', mode: e.mode, reminderDays: String(e.reminderDays),
    lines: e.lines.map(l => ({ key: seq++, accountId: l.accountId, debit: l.amount > 0 ? String(l.amount) : '', credit: l.amount < 0 ? String(-l.amount) : '', lpEntityId: l.lpEntityId })),
  })

  if (!view) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading recurring entries…</div>

  const newPicker = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => startFrom(null)}><Plus className="h-3.5 w-3.5 mr-1" />New recurring entry</Button>
      {view.templates.filter(t => t.available).map(t => (
        <Button key={t.key} size="sm" variant="outline" className="text-muted-foreground" title={t.description} onClick={() => startFrom(t)}>{t.name}</Button>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground max-w-3xl">
          Entries that repeat on a schedule, such as an accrual or the monthly management fee spread. Each one can remind you,
          save a draft, or post on its due dates. The daily run only books dates from the day you choose draft or post; earlier
          dates wait here for you to review and book.
        </p>
        {newPicker}
      </div>
      {error && <p className="text-sm text-warning">{error}</p>}

      {view.entries.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <Repeat className="mx-auto mb-2 h-5 w-5" />
          No recurring entries yet. Start one from scratch or from a template above.
        </div>
      ) : (
        <div className="space-y-3">
          {view.entries.map(e => {
            const waiting = e.missed.length + e.drafts.length
            return (
              <div key={e.id} className={`rounded-card border border-border p-4 space-y-2 ${e.active ? '' : 'opacity-70'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {e.name}
                      {!e.active && <span className="ml-2 text-xs font-normal text-muted-foreground">Paused</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {e.cadence}{e.endDate ? `, until ${e.endDate}` : ''} · {MODE_LABEL[e.mode]}
                      {e.kind === 'fixed' && <> · <span className="tabular-nums">{fmt(e.amount)}</span></>}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {waiting > 0 && (
                      <Button size="sm" onClick={() => setReview(e)}>
                        Review {waiting} {e.missed.length > 0 ? `missed date${waiting === 1 ? '' : 's'}` : `draft${waiting === 1 ? '' : 's'}`}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => editEntry(e)}>Edit</Button>
                    <Button size="sm" variant="outline" disabled={busy === e.id} onClick={async () => { if (await act(e.id, { action: e.active ? 'pause' : 'resume', id: e.id })) await load() }}>
                      {e.active ? 'Pause' : 'Resume'}
                    </Button>
                    {confirmDelete === e.id ? (
                      <Button size="sm" variant="destructive" disabled={busy === e.id} onClick={async () => { setConfirmDelete(null); if (await act(e.id, { action: 'delete', id: e.id })) await load() }}>Delete, keep its entries</Button>
                    ) : (
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmDelete(e.id)}>Delete</Button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <p><span className="text-muted-foreground">Next due </span><span className="tabular-nums">{e.nextDue ?? '—'}</span></p>
                  <p><span className="text-muted-foreground">Last booked </span><span className="tabular-nums">{e.lastBooked ? `${e.lastBooked.date}${e.lastBooked.status === 'draft' ? ' (draft)' : ''}` : '—'}</span></p>
                  <p><span className="text-muted-foreground">Waiting </span>{e.missed.length} missed, {e.drafts.length} draft{e.drafts.length === 1 ? '' : 's'}</p>
                </div>
                {e.kind === 'fixed' && e.lines.length > 0 && (
                  <table className="w-full max-w-xl text-xs">
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="py-1 pr-2"><span className="tabular-nums text-muted-foreground mr-1.5">{l.code}</span>{l.accountName ?? 'Account not in this chart'}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{l.amount > 0 ? fmt(l.amount) : ''}</td>
                          <td className="py-1 text-right tabular-nums">{l.amount < 0 ? fmt(-l.amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {e.lastError && <p className="text-sm text-warning">Last run: {e.lastError}</p>}
              </div>
            )
          })}
        </div>
      )}

      {draft && (
        <EntryEditor
          draft={draft} setDraft={setDraft} accounts={accounts} pickerAccounts={pickerAccounts} busy={busy === 'save'} error={error}
          onCancel={() => { setDraft(null); setError(null) }}
          onSave={async payload => { if (await act('save', payload)) { setDraft(null); await load() } }}
        />
      )}
      {review && (
        <ReviewDialog
          entry={review} fmt={fmt} lf={lf}
          onClose={async changed => { setReview(null); if (changed) await load() }}
        />
      )}
    </div>
  )
}

function EntryEditor({ draft, setDraft, accounts, pickerAccounts, busy, error, onCancel, onSave }: {
  draft: Draft; setDraft: (d: Draft) => void; accounts: Acct[]; pickerAccounts: PickerAccount[]; busy: boolean; error: string | null
  onCancel: () => void; onSave: (payload: Record<string, unknown>) => void
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const setLine = (key: number, patch: Partial<DraftLine>) => set({ lines: draft.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) })
  const acctById = new Map(accounts.map(a => [a.id, a]))
  const spread = draft.kind === SPREAD
  const debit = draft.lines.reduce((s, l) => s + num(l.debit), 0)
  const credit = draft.lines.reduce((s, l) => s + num(l.credit), 0)
  const diff = Math.round((debit - credit) * 100) / 100
  const linesOk = spread || (draft.lines.length >= 2 && diff === 0 && draft.lines.every(l => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0)))
  const ok = draft.name.trim() && draft.startDate && linesOk

  const save = () => {
    const entry: Record<string, unknown> = {
      name: draft.name, memo: draft.memo, startDate: draft.startDate, endDate: draft.endDate || null, mode: draft.mode,
      reminderDays: Number(draft.reminderDays || 0),
    }
    if (!spread) {
      Object.assign(entry, {
        sourceType: draft.sourceType, frequency: draft.frequency, dayOfMonth: draft.dayOfMonth,
        lines: draft.lines.map(l => ({ accountId: l.accountId, amount: num(l.debit) > 0 ? num(l.debit) : -num(l.credit), lpEntityId: l.lpEntityId })),
      })
    }
    if (draft.id) onSave({ action: 'update', id: draft.id, entry })
    else if (spread) onSave({ action: 'create', template: SPREAD, mode: draft.mode, entry: { startDate: draft.startDate, endDate: draft.endDate || null, reminderDays: Number(draft.reminderDays || 0) } })
    else onSave({ action: 'create', template: draft.template, entry })
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{draft.id ? 'Edit recurring entry' : spread ? 'Spread the management fee monthly' : 'New recurring entry'}</DialogTitle>
          <DialogDescription>
            {spread
              ? 'On the 1st of each month this recognizes that month’s share of the fee billed in advance, out of prepaid fees (and deferred revenue on the management company), whatever day the cash arrives. The amounts come from the fee schedule, which keeps booking the quarter’s bill and invoice.'
              : 'The same lines on every due date. In the memo, {month}, {quarter}, {year} and {date} are filled in for each date.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-medium">Name
              <Input value={draft.name} onChange={e => set({ name: e.target.value })} disabled={spread && !draft.id} />
            </label>
            {!spread && (
              <label className="space-y-1 text-xs font-medium">Memo
                <Input value={draft.memo} onChange={e => set({ memo: e.target.value })} placeholder="e.g. Audit fee accrual, {month}" />
              </label>
            )}
          </div>

          {!spread && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="space-y-1 text-xs font-medium">Repeats
                <select className={selectCls} value={draft.frequency} onChange={e => set({ frequency: e.target.value as Frequency })}>
                  {(Object.keys(FREQ_LABEL) as Frequency[]).map(f => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">On day
                <select className={selectCls} value={draft.dayOfMonth} onChange={e => set({ dayOfMonth: Number(e.target.value) })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                  <option value={31}>Last day</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">Type
                <select className={selectCls} value={draft.sourceType} onChange={e => set({ sourceType: e.target.value })}>
                  {ENTRY_SOURCE_TYPES.map(t => <option key={t} value={t}>{ENTRY_SOURCE_TYPE_LABELS[t]}</option>)}
                  {draft.sourceType === 'adjusting' && <option value="adjusting">Adjusting entry</option>}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">Remind days before
                <Input inputMode="numeric" value={draft.reminderDays} onChange={e => set({ reminderDays: e.target.value })} className="tabular-nums" />
              </label>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="space-y-1 text-xs font-medium">Starts
              <Input type="date" value={draft.startDate} onChange={e => set({ startDate: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs font-medium">Ends (optional)
              <Input type="date" value={draft.endDate} onChange={e => set({ endDate: e.target.value })} />
            </label>
            {spread && (
              <label className="space-y-1 text-xs font-medium">Remind days before
                <Input inputMode="numeric" value={draft.reminderDays} onChange={e => set({ reminderDays: e.target.value })} className="tabular-nums" />
              </label>
            )}
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium mb-1">On each due date</legend>
            {(Object.keys(MODE_LABEL) as Mode[]).map(m => (
              <label key={m} className="flex items-start gap-2 text-sm">
                <input type="radio" className="mt-1" checked={draft.mode === m} onChange={() => set({ mode: m })} />
                <span>{MODE_LABEL[m]}<span className="block text-xs text-muted-foreground">{MODE_HELP[m]}</span></span>
              </label>
            ))}
          </fieldset>

          {!spread && (
            <div className="space-y-2">
              <p className="text-xs font-medium">Lines</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Account</th>
                    <th className="py-1 px-1 font-medium text-right w-28">Debit</th>
                    <th className="py-1 px-1 font-medium text-right w-28">Credit</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map(l => (
                    <tr key={l.key}>
                      <td className="py-1 pr-2">
                        <AccountPicker accounts={pickerAccounts} value={l.accountId} placeholder="Code or name…"
                          onChange={accountId => setLine(l.key, { accountId, lpEntityId: acctById.get(accountId)?.lp_entity_id ?? null })} />
                      </td>
                      <td className="px-1 py-1"><input inputMode="decimal" value={l.debit} onChange={e => setLine(l.key, { debit: e.target.value, credit: '' })} className="w-full rounded border border-input bg-transparent px-1.5 py-1 text-right tabular-nums" /></td>
                      <td className="px-1 py-1"><input inputMode="decimal" value={l.credit} onChange={e => setLine(l.key, { credit: e.target.value, debit: '' })} className="w-full rounded border border-input bg-transparent px-1.5 py-1 text-right tabular-nums" /></td>
                      <td className="py-1 text-right">
                        {draft.lines.length > 2 && <button className="text-muted-foreground hover:text-foreground" aria-label="Remove line" onClick={() => set({ lines: draft.lines.filter(x => x.key !== l.key) })}>×</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between">
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => set({ lines: [...draft.lines, blankLine()] })}>Add a line</Button>
                <p className={`text-sm tabular-nums ${diff === 0 ? 'text-muted-foreground' : 'text-warning'}`}>
                  {diff === 0 ? 'Balanced' : `Out of balance by ${Math.abs(diff).toFixed(2)}`}
                </p>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-warning">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={!ok || busy} onClick={save}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The review step for booking missed dates and posting drafts: pick, preview exactly what will be written, then book. */
function ReviewDialog({ entry, fmt, lf, onClose }: {
  entry: Entry; fmt: (v: number) => string; lf: ReturnType<typeof useLedgerFetch>; onClose: (changed: boolean) => void
}) {
  const rows = [...entry.missed, ...entry.drafts].sort((a, b) => a.date.localeCompare(b.date))
  const [picked, setPicked] = useState<Set<string>>(new Set(rows.map(r => r.date)))
  const [mode, setMode] = useState<'draft' | 'post'>(entry.missed.length === 0 ? 'post' : 'draft')
  const [preview, setPreview] = useState<PreviewItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)

  const call = async (action: 'preview' | 'book') => {
    setBusy(true); setError(null)
    const r = await lf('/api/accounting/recurring-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id: entry.id, dates: [...picked], mode }) })
    const d = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(d.error ?? 'That did not work'); return null }
    return d
  }
  const toWrite = preview?.filter(p => p.action !== 'skip') ?? []

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(changed) }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Book {entry.name}</DialogTitle>
          <DialogDescription>Pick the dates, check what will be written, then book them.</DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-xs">
              <button className="underline underline-offset-2" onClick={() => setPicked(new Set(rows.map(r => r.date)))}>Select all</button>
              <button className="underline underline-offset-2" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
            <div className="divide-y divide-border rounded-card border border-border">
              {rows.map(r => (
                <label key={r.date} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input type="checkbox" checked={picked.has(r.date)} onChange={e => setPicked(cur => { const n = new Set(cur); if (e.target.checked) n.add(r.date); else n.delete(r.date); return n })} />
                  <span className="tabular-nums w-24">{r.date}</span>
                  <span className="tabular-nums flex-1 text-right">{fmt(r.amount)}</span>
                  <span className="w-40 text-xs text-muted-foreground">{r.status === 'draft' ? 'Drafted' : r.waitingForBill ? 'Not booked; bill not booked yet' : 'Not booked'}</span>
                </label>
              ))}
            </div>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" checked={mode === 'draft'} onChange={() => setMode('draft')} />Save as drafts</label>
              <label className="flex items-center gap-2"><input type="radio" checked={mode === 'post'} onChange={() => setMode('post')} />Post (drafts selected are posted too)</label>
            </fieldset>
          </div>
        ) : (
          <div className="space-y-3">
            {preview.map(p => (
              <div key={p.date} className={`rounded-card border border-border p-3 text-xs ${p.action === 'skip' ? 'opacity-60' : ''}`}>
                <p className="mb-1 flex flex-wrap justify-between gap-2">
                  <span><span className="tabular-nums font-medium">{p.date}</span> · {p.memo}</span>
                  <span className="text-muted-foreground">
                    {p.action === 'skip' ? `Skipped: ${p.reason}` : p.action === 'post_draft' ? 'Posts the draft' : p.action === 'post' ? 'Posts' : 'Saves a draft'}
                  </span>
                </p>
                {p.action !== 'skip' && p.reason && <p className="mb-1 text-sm text-warning">{p.reason}</p>}
                <table className="w-full">
                  <tbody>
                    {p.lines.map((l, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-0.5 pr-2"><span className="tabular-nums text-muted-foreground mr-1.5">{l.code}</span>{l.account}</td>
                        <td className="py-0.5 pr-2 text-right tabular-nums w-28">{l.amount > 0 ? fmt(l.amount) : ''}</td>
                        <td className="py-0.5 text-right tabular-nums w-28">{l.amount < 0 ? fmt(-l.amount) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-warning">{error}</p>}

        <DialogFooter>
          {!preview ? (
            <>
              <Button variant="outline" onClick={() => onClose(changed)}>Cancel</Button>
              <Button disabled={busy || picked.size === 0} onClick={async () => { const d = await call('preview'); if (d) setPreview(d.items) }}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Review {picked.size} date{picked.size === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setPreview(null)}>Back</Button>
              <Button disabled={busy || toWrite.length === 0} onClick={async () => {
                const d = await call('book')
                if (d) { setChanged(true); onClose(true) }
              }}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                {mode === 'post' ? `Post ${toWrite.length}` : `Save ${toWrite.length} draft${toWrite.length === 1 ? '' : 's'}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
