'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { PlanDetail } from '@/lib/forecast/service'
import type { Adjustments, ManualEntry } from '@/lib/forecast/adjustments'

type Entry = PlanDetail['entries'][number]

const SOURCE_LABEL: Record<string, string> = {
  rule: 'Rule', override: 'Your amount', opening: 'Opening balance', construction: 'Construction', manual: 'Added by you',
}

const selectCls = 'h-8 rounded-md border border-input bg-background px-2 text-sm'

/**
 * The plan's entries, journal-style: every one the draft compiles to, where it came from, and how to
 * change it. Generated construction and opening entries can be edited (replaced) or removed; a
 * rule's month takes an override; anything else can be added by hand. All of it is kept on the plan
 * (lib/forecast/adjustments.ts), so a refresh recompiles around the edits instead of erasing them.
 */
export function ForecastEntries({ detail, fmt, editable, months, onClearMonths, save, onEditRule }: {
  detail: PlanDetail
  fmt: (n: number) => string
  /** The working draft, by a writer: published versions never change. */
  editable: boolean
  /** Show only these months (a cell clicked on the P&L or cash statement). */
  months: string[] | null
  onClearMonths: () => void
  save: (body: Record<string, unknown>) => Promise<boolean>
  onEditRule: (accountId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [editing, setEditing] = useState<{ entry: ManualEntry; title: string } | null>(null)
  const accounts = useMemo(() => new Map(detail.allAccounts.map(a => [a.id, a])), [detail.allAccounts])
  const adj: Adjustments = detail.plan.adjustments ?? { entries: [], removed: [] }

  const shown = detail.entries.filter(e =>
    (!months || months.includes(e.date.slice(0, 7)))
    && (!source || e.source === source)
    && (!query.trim() || `${e.memo} ${e.postings.map(p => accounts.get(p.accountId)?.name ?? '').join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())))

  const label = (id: string) => { const a = accounts.get(id); return a ? `${a.code} ${a.name}` : id }
  const setAdj = (next: Adjustments) => save({ adjustments: next })
  const newId = () => (globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}`)

  const editEntry = (e: Entry) => {
    if (e.source === 'manual' && e.key) {
      const id = e.key.slice('manual|'.length)
      const m = adj.entries.find(x => x.id === id)
      if (m) setEditing({ entry: m, title: 'Edit entry' })
      return
    }
    // A generated entry: edit a copy that replaces it.
    setEditing({ entry: { id: newId(), date: e.date, memo: e.memo, postings: e.postings.map(p => ({ ...p })), replaces: e.key }, title: 'Edit entry' })
  }
  const removeEntry = (e: Entry) => {
    if (e.source === 'manual' && e.key) return setAdj({ ...adj, entries: adj.entries.filter(x => `manual|${x.id}` !== e.key) })
    if (e.key) return setAdj({ ...adj, removed: [...adj.removed, e.key] })
  }
  const overrideMonth = async (e: Entry) => {
    const account = detail.allAccounts.find(a => a.id === e.accountId)
    const p = e.postings.find(x => x.accountId === e.accountId)
    if (!account || !p) return
    const current = account.type === 'income' ? -p.amount : p.amount
    const raw = window.prompt(`${account.code} ${account.name}, ${e.date.slice(0, 7)} — new amount (blank to go back to the rule):`, String(current))
    if (raw === null) return
    const v = raw.replace(/[$,\s]/g, '')
    await save({ overrides: [{ accountId: e.accountId, month: e.date.slice(0, 7), amount: v === '' ? null : Number(v) }] })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search entries" className="h-8 w-56" aria-label="Search entries" />
        <select className={selectCls} value={source} onChange={e => setSource(e.target.value)} aria-label="Source">
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {months && (
          <button type="button" onClick={onClearMonths} className="h-8 rounded-md border border-input px-2 text-sm text-muted-foreground hover:text-foreground">
            {months.length === 1 ? months[0] : `${months[0]} – ${months[months.length - 1]}`} ✕
          </button>
        )}
        <span className="text-xs text-muted-foreground">{shown.length} of {detail.entries.length} entries</span>
        {editable && (
          <Button size="sm" variant="outline" className="ml-auto gap-1.5"
            onClick={() => setEditing({ entry: { id: newId(), date: `${months?.[0] ?? detail.window.first}-${lastDayOf(months?.[0] ?? detail.window.first)}`, memo: '', postings: [{ accountId: '', amount: 0 }, { accountId: '', amount: 0 }], replaces: null }, title: 'Add an entry' })}>
            <Plus className="h-3.5 w-3.5" />Add entry
          </Button>
        )}
      </div>
      {adj.removed.length > 0 && editable && (
        <p className="text-xs text-muted-foreground">
          {adj.removed.length} generated entr{adj.removed.length === 1 ? 'y is' : 'ies are'} removed from this plan.{' '}
          <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => setAdj({ ...adj, removed: [] })}>Put them back</button>
        </p>
      )}

      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Entry</th>
              <th className="px-3 py-2 font-medium">Lines</th>
              <th className="px-3 py-2 font-medium">Source</th>
              {editable && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No entries match.</td></tr>
            )}
            {shown.slice(0, 500).map((e, i) => (
              <tr key={`${e.key ?? ''}${e.date}${e.memo}${i}`} className="border-b align-top last:border-b-0">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{e.date}</td>
                <td className="px-3 py-2">{e.memo}</td>
                <td className="px-3 py-2">
                  {e.postings.map((p, j) => (
                    <div key={j} className="flex justify-between gap-4 text-xs">
                      <span className={cn(p.amount < 0 && 'pl-4')}>{label(p.accountId)}</span>
                      <span className="tabular-nums">{p.amount > 0 ? fmt(p.amount) : `(${fmt(-p.amount)})`}</span>
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{SOURCE_LABEL[e.source] ?? e.source}</td>
                {editable && (
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    {(e.source === 'construction' || e.source === 'opening' || e.source === 'manual') ? (
                      <span className="flex justify-end gap-3">
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => editEntry(e)}>Edit</button>
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => removeEntry(e)}>Remove</button>
                      </span>
                    ) : e.kind === 'recognition' || e.kind === 'release' ? (
                      <span className="flex justify-end gap-3">
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => overrideMonth(e)}>Change amount</button>
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onEditRule(e.accountId)}>Rule</button>
                      </span>
                    ) : (
                      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onEditRule(e.accountId)} title="Cash timing is part of the account's rule">Timing</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 500 && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Showing the first 500 — narrow by month or search.</p>}
      </div>

      {editing && (
        <EntryEditor
          title={editing.title}
          entry={editing.entry}
          accounts={detail.allAccounts}
          fmt={fmt}
          onClose={() => setEditing(null)}
          onSave={async m => {
            const others = adj.entries.filter(x => x.id !== m.id)
            if (await setAdj({ ...adj, entries: [...others, m] })) setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')
}

function EntryEditor({ title, entry, accounts, fmt, onClose, onSave }: {
  title: string
  entry: ManualEntry
  accounts: PlanDetail['allAccounts']
  fmt: (n: number) => string
  onClose: () => void
  onSave: (m: ManualEntry) => void
}) {
  const [date, setDate] = useState(entry.date)
  const [memo, setMemo] = useState(entry.memo)
  // Debit and credit columns, as a journal entry is read.
  const [lines, setLines] = useState(entry.postings.map(p => ({ accountId: p.accountId, debit: p.amount > 0 ? String(p.amount) : '', credit: p.amount < 0 ? String(-p.amount) : '' })))
  const num = (s: string) => Number(s.replace(/[$,\s]/g, '')) || 0
  const off = Math.round(lines.reduce((s, l) => s + num(l.debit) - num(l.credit), 0) * 100) / 100
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && memo.trim() && off === 0 && lines.filter(l => l.accountId && (num(l.debit) || num(l.credit))).length >= 2

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {entry.replaces ? 'This replaces the generated entry in this plan. A refresh keeps your version.' : 'A forecast entry only — nothing posts to the ledger.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[10rem_1fr] gap-2">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Date" />
            <Input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Description" aria-label="Description" />
          </div>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[1fr_8rem_8rem_2rem] gap-2 text-xs text-muted-foreground"><span>Account</span><span className="text-right">Debit</span><span className="text-right">Credit</span><span /></div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_8rem_2rem] gap-2">
                <select className={cn(selectCls, 'h-9')} value={l.accountId} onChange={e => set(i, { accountId: e.target.value })} aria-label="Account">
                  <option value="">Account…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select>
                <Input inputMode="decimal" className="text-right tabular-nums" value={l.debit} onChange={e => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label="Debit" />
                <Input inputMode="decimal" className="text-right tabular-nums" value={l.credit} onChange={e => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label="Credit" />
                <button type="button" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground" aria-label="Remove line">✕</button>
              </div>
            ))}
            <button type="button" onClick={() => setLines(ls => [...ls, { accountId: '', debit: '', credit: '' }])} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">+ Add a line</button>
          </div>
          {off !== 0 && <p className="text-sm text-destructive">Out of balance by {fmt(Math.abs(off))}.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} onClick={() => onSave({
            ...entry, date, memo: memo.trim(),
            postings: lines.filter(l => l.accountId && (num(l.debit) || num(l.credit))).map(l => ({ accountId: l.accountId, amount: num(l.debit) - num(l.credit) })),
          })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
