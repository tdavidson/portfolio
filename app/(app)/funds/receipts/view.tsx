'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Upload, Receipt, FileText, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { AccountPicker, type PickerAccount } from '@/components/accounting/account-picker'
import { EntryModal } from '../entry-modal'

interface ReceiptRow {
  id: string
  vehicle_id: string | null
  source: 'email' | 'upload' | 'agent'
  file_name: string
  vendor_name: string | null
  receipt_date: string | null
  amount: number | null
  currency: string | null
  description: string | null
  extraction_status: string
  extraction_notes: string | null
  status: 'unmatched' | 'matched' | 'dismissed'
  journal_entry_id: string | null
  bank_transaction_id: string | null
  created_at: string
}
interface Suggestion { kind: 'entry' | 'bank'; id: string; date: string; amount: number; description: string | null; status: string; score: number; reason: string }
interface Entity { id: string | null; name: string; kind: string | null }

type Tab = 'receipts' | 'invoices'
type Filter = 'unmatched' | 'matched' | 'dismissed' | 'all'

const json = (method: string, body: object) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const errOf = async (r: Response, fallback: string) => (await r.json().catch(() => ({}))).error ?? fallback
const smallBtn = 'text-xs border border-input rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50'

/**
 * An entity's receipts, and the quarterly invoices that bill its partnership expenses to the funds.
 *
 * Receipts arrive from the inbound mailbox (a member's email with "Receipt:" in the subject, or to
 * the +receipts address) or are dropped here. Each one is attached to the entry it supports: the
 * suggestions are the entries and undrafted bank transactions on this entity's books with the same
 * amount near the same date. A receipt with no charge on the books yet can draft one.
 */
export function ReceiptsView() {
  const [tab, setTab] = useState<Tab>('receipts')
  const tabCls = (t: Tab, edge: 'l' | 'r') =>
    `h-9 px-3 ${edge === 'l' ? 'rounded-l-md' : 'rounded-r-md border-l border-input'} ${tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-input text-sm" role="tablist" aria-label="Receipts or partnership invoices">
        <button role="tab" aria-selected={tab === 'receipts'} onClick={() => setTab('receipts')} className={tabCls('receipts', 'l')}>Receipts</button>
        <button role="tab" aria-selected={tab === 'invoices'} onClick={() => setTab('invoices')} className={tabCls('invoices', 'r')}>Partnership invoices</button>
      </div>
      {tab === 'receipts' ? <ReceiptsList /> : <PartnershipInvoices />}
    </div>
  )
}

// ── Receipts ────────────────────────────────────────────────────────────────────────────────

function ReceiptsList() {
  const lf = useLedgerFetch()
  const { group, vehicleId } = useVehicle()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [filter, setFilter] = useState<Filter>('unmatched')
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drafting, setDrafting] = useState<string | null>(null)
  const [openEntry, setOpenEntry] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!group) return
    setLoading(true)
    const r = await lf(`/api/accounting/receipts?status=${filter}`)
    const j = r.ok ? await r.json() : { receipts: [], suggestions: {} }
    if (!r.ok) setError(j.error ?? 'Could not load receipts.')
    setReceipts(Array.isArray(j.receipts) ? j.receipts : [])
    setSuggestions(j.suggestions ?? {})
    setLoading(false)
  }, [lf, filter, group])
  useEffect(() => { void load() }, [load])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy('upload'); setError(null)
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.set('file', f)
      const r = await lf('/api/accounting/receipts', { method: 'POST', body: form })
      if (!r.ok) { setError(await errOf(r, `Could not add ${f.name}`)); break }
    }
    if (fileRef.current) fileRef.current.value = ''
    setBusy(null)
    await load()
  }

  async function act(id: string, body: object, fallback: string) {
    setBusy(id); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, json('PATCH', body))
    if (!r.ok) setError(await errOf(r, fallback))
    setBusy(null)
    await load()
    return r.ok
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this receipt and its file?')) return
    setBusy(id); setError(null)
    const r = await lf(`/api/accounting/receipts/${id}`, { method: 'DELETE' })
    if (!r.ok) setError(await errOf(r, 'Could not delete the receipt'))
    setBusy(null)
    await load()
  }

  const filters: { key: Filter; label: string }[] = [
    { key: 'unmatched', label: 'To match' }, { key: 'matched', label: 'Attached' }, { key: 'dismissed', label: 'Dismissed' }, { key: 'all', label: 'All' },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-input text-xs">
          {filters.map((f, i) => (
            <button key={f.key} onClick={() => setFilter(f.key)} className={`h-8 px-3 ${i > 0 ? 'border-l border-input' : ''} ${filter === f.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{f.label}</button>
          ))}
        </div>
        <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input px-3 h-8 text-xs hover:bg-accent ${busy === 'upload' ? 'pointer-events-none opacity-60' : ''}`}>
          {busy === 'upload' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload receipts
          <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={e => void upload(e.target.files)} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Email a receipt to the fund’s inbound address with “Receipt:” at the start of the subject (or send it to the address with +receipts before the @). It is read, filed here, and attached to its bank charge when the match is clear.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : receipts.length === 0 ? (
        <EmptyState icon={Receipt}>{filter === 'unmatched' ? 'No receipts waiting to be matched.' : 'No receipts here.'}</EmptyState>
      ) : (
        <ul className="divide-y rounded-card border">
          {receipts.map(r => {
            const sugg = suggestions[r.id] ?? []
            const unfiled = !r.vehicle_id
            return (
              <li key={r.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a href={`/api/accounting/receipts/${r.id}?redirect=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{r.vendor_name || r.file_name}</span>
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {[r.receipt_date, r.description, r.source === 'email' ? 'emailed in' : r.source === 'agent' ? 'from an assistant' : 'uploaded'].filter(Boolean).join(' · ')}
                      {r.extraction_status === 'pending' && ' · not read yet'}
                      {r.extraction_status === 'failed' && ' · could not be read, fill in the total'}
                      {r.extraction_notes && ` · ${r.extraction_notes}`}
                    </p>
                    {unfiled && <p className="text-sm text-warning">Not filed under an entity yet.</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm tabular-nums">{r.amount != null ? fmt(Number(r.amount)) : '—'}</span>
                    {busy === r.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>
                </div>

                {editing === r.id ? (
                  <ReceiptFieldsForm r={r} onCancel={() => setEditing(null)} onSave={async patch => { if (await act(r.id, { action: 'update', ...patch }, 'Could not save')) setEditing(null) }} />
                ) : drafting === r.id ? (
                  <DraftForm r={r} onCancel={() => setDrafting(null)} onDraft={async body => {
                    if (await act(r.id, { action: 'draft', ...body }, 'Could not draft the entry')) setDrafting(null)
                  }} />
                ) : (
                  <>
                    {r.status === 'matched' && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Paperclip className="h-3.5 w-3.5" />
                        {r.journal_entry_id
                          ? <>Attached to <button className="underline underline-offset-2" onClick={() => setOpenEntry(r.journal_entry_id)}>entry {r.journal_entry_id.slice(0, 8)}</button></>
                          : 'Attached to a bank transaction; it moves onto the entry when the transaction is drafted.'}
                      </p>
                    )}
                    {r.status === 'unmatched' && !unfiled && r.amount == null && (
                      <p className="text-xs text-muted-foreground">Fill in the total to see matching charges.</p>
                    )}
                    {r.status === 'unmatched' && sugg.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Likely matches</p>
                        {sugg.map(s => (
                          <div key={`${s.kind}:${s.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                            <span className="min-w-0 truncate">
                              <span className="tabular-nums">{s.date}</span> · {s.kind === 'entry' ? `entry (${s.status})` : 'bank, not drafted'} · {s.description || '—'}
                              <span className="ml-1 text-muted-foreground">({s.reason})</span>
                            </span>
                            <span className="flex items-center gap-2">
                              <span className="tabular-nums">{fmt(s.amount)}</span>
                              <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, s.kind === 'entry' ? { action: 'attach', journalEntryId: s.id } : { action: 'attach', bankTransactionId: s.id }, 'Could not attach')}>Attach</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {unfiled && group && <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'update', group }, 'Could not file it')}>File under {group}</button>}
                      <button className={smallBtn} disabled={!!busy} onClick={() => setEditing(r.id)}>Edit details</button>
                      {r.status === 'unmatched' && !unfiled && <button className={smallBtn} disabled={!!busy || r.amount == null} onClick={() => setDrafting(r.id)} title="For a charge that is not on the books yet">Draft an entry</button>}
                      {r.status === 'matched' && <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'detach' }, 'Could not detach')}>Detach</button>}
                      {r.status !== 'dismissed'
                        ? <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'dismiss' }, 'Could not dismiss')} title="Not a receipt for these books">Dismiss</button>
                        : <button className={smallBtn} disabled={!!busy} onClick={() => void act(r.id, { action: 'restore' }, 'Could not restore')}>Restore</button>}
                      <button className={`${smallBtn} hover:text-destructive`} disabled={!!busy} onClick={() => void remove(r.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {vehicleId === null && group && <p className="text-xs text-muted-foreground">This entity has no registry id; receipts need one.</p>}
      {openEntry && (
        <EntryModal entryId={openEntry} readOnly onClose={() => setOpenEntry(null)} onSaved={() => void load()} />
      )}
    </div>
  )
}

function ReceiptFieldsForm({ r, onSave, onCancel }: { r: ReceiptRow; onSave: (p: object) => void; onCancel: () => void }) {
  const [vendorName, setVendor] = useState(r.vendor_name ?? '')
  const [receiptDate, setDate] = useState(r.receipt_date ?? '')
  const [amount, setAmount] = useState(r.amount != null ? String(r.amount) : '')
  const [description, setDescription] = useState(r.description ?? '')
  const input = 'mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm'
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="w-44 text-xs text-muted-foreground">Vendor<input value={vendorName} onChange={e => setVendor(e.target.value)} className={input} /></label>
      <label className="text-xs text-muted-foreground">Date<input type="date" value={receiptDate} onChange={e => setDate(e.target.value)} className={input} /></label>
      <label className="w-28 text-xs text-muted-foreground">Total<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className={`${input} text-right tabular-nums`} /></label>
      <label className="min-w-[160px] flex-1 text-xs text-muted-foreground">What for<input value={description} onChange={e => setDescription(e.target.value)} className={input} /></label>
      <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      <Button size="sm" onClick={() => onSave({ vendorName, receiptDate: receiptDate || null, amount: amount || null, description })}>Save</Button>
    </div>
  )
}

function DraftForm({ r, onDraft, onCancel }: { r: ReceiptRow; onDraft: (b: object) => void; onCancel: () => void }) {
  const lf = useLedgerFetch()
  const { vehicleId } = useVehicle()
  const [accounts, setAccounts] = useState<PickerAccount[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [debit, setDebit] = useState('')
  const [credit, setCredit] = useState('')
  const [billTo, setBillTo] = useState('')
  useEffect(() => {
    lf('/api/accounting/chart').then(res => (res.ok ? res.json() : [])).then((chart: any[]) => {
      const list = (Array.isArray(chart) ? chart : []).filter(a => a.is_active !== false)
        .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, lpEntityId: a.lp_entity_id }))
      setAccounts(list)
      const cash = list.find(a => a.code === '1000')
      if (cash) setCredit(cash.id)
    }).catch(() => {})
    lf('/api/accounting/partnership-invoices').then(res => (res.ok ? res.json() : null)).then(j => {
      if (j?.counterparties) setEntities(j.counterparties)
    }).catch(() => {})
  }, [lf])
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2">
      <p className="text-xs text-muted-foreground">A draft for {r.receipt_date ?? 'today'}, {r.vendor_name ?? 'no vendor'}. Nothing posts until you post it from the journal.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">Paid for
          <select value={billTo} onChange={e => setBillTo(e.target.value)} className="mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm" title="A partnership expense: debit that fund's Due-from account so it goes on its quarterly invoice">
            <option value="">This entity (its own expense)</option>
            {entities.filter(e => e.id && e.id !== vehicleId).map(e => <option key={e.id!} value={e.id!}>{e.name} (partnership expense)</option>)}
          </select>
        </label>
        {billTo
          ? <span className="w-56 pb-1.5 text-xs text-muted-foreground">Debit: Due from {entities.find(e => e.id === billTo)?.name ?? 'the fund'}</span>
          : <label className="w-56 text-xs text-muted-foreground">Debit (the cost)<AccountPicker accounts={accounts.filter(a => a.type === 'expense' || a.type === 'asset')} value={debit} onChange={setDebit} /></label>}
        <label className="w-56 text-xs text-muted-foreground">Credit (what paid it)<AccountPicker accounts={accounts.filter(a => a.type === 'asset' || a.type === 'liability')} value={credit} onChange={setCredit} /></label>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!(debit || billTo) || !credit} onClick={() => onDraft(billTo ? { creditAccountId: credit, billToVehicleId: billTo } : { debitAccountId: debit, creditAccountId: credit })}>Draft entry</Button>
      </div>
    </div>
  )
}

// ── Partnership invoices ────────────────────────────────────────────────────────────────────

interface InvoiceRow { id: string; invoice_number: string; invoice_date: string; period_start: string; period_end: string; amount: number; status: string; from_vehicle_id: string; to_vehicle_id: string; from_name: string | null; to_name: string | null }
interface Line { entryId: string; postingId: string; entryDate: string; memo: string | null; reference: string | null; vendorName: string | null; amount: number; receiptCount: number; status: string }
interface Preview { quarter: { year: number; quarter: number; label: string; start: string; end: string }; to: { vehicleId: string; name: string }; lines: Line[]; total: number; drafts: Line[]; hasReceivableAccount: boolean; existing: { id: string; invoiceNumber: string; status: string } | null }

function PartnershipInvoices() {
  const lf = useLedgerFetch()
  const { group, vehicleId } = useVehicle()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [loading, setLoading] = useState(true)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [unbilled, setUnbilled] = useState<{ vehicleId: string; name: string; entries: number; amount: number }[]>([])
  const [counterparties, setCounterparties] = useState<Entity[]>([])
  const [to, setTo] = useState('')
  const [year, setYear] = useState(new Date().getFullYear())
  const [quarter, setQuarter] = useState(1)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openEntry, setOpenEntry] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!group) return
    setLoading(true)
    const r = await lf('/api/accounting/partnership-invoices')
    const j = r.ok ? await r.json() : null
    if (!r.ok) setError((j as any)?.error ?? 'Could not load invoices.')
    if (j) {
      setInvoices(j.invoices ?? [])
      setUnbilled(j.unbilled ?? [])
      setCounterparties(j.counterparties ?? [])
      if (j.defaultQuarter) { setYear(j.defaultQuarter.year); setQuarter(j.defaultQuarter.quarter) }
      setTo(prev => prev || j.unbilled?.[0]?.vehicleId || '')
    }
    setLoading(false)
  }, [lf, group])
  useEffect(() => { void load() }, [load])

  async function runPreview() {
    if (!to) return
    setBusy(true); setError(null); setNotice(null)
    const r = await lf(`/api/accounting/partnership-invoices?to=${to}&year=${year}&quarter=${quarter}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setError(j.error ?? 'Could not preview the invoice')
    setPreview(r.ok ? j.preview : null)
    setBusy(false)
  }

  async function post(body: object, fallback: string): Promise<any | null> {
    setBusy(true); setError(null); setNotice(null)
    const r = await lf('/api/accounting/partnership-invoices', json('POST', body))
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? fallback); return null }
    return j
  }

  async function create() {
    const j = await post({ action: 'create', to, year, quarter }, 'Could not create the invoice')
    if (j) { setNotice(`Draft invoice ${j.invoiceNumber} created for ${fmt(j.amount)}. Review the PDF, then issue it.`); setPreview(null); await load() }
  }
  async function issue(id: string) {
    if (!window.confirm('Issue this invoice? It books the expense and the payable on the fund’s books.')) return
    const j = await post({ action: 'issue', id }, 'Could not issue the invoice')
    if (j) { setNotice('Issued and booked on the fund’s books. When the fund pays, settle the charge on the Intercompany tab to clear the receivable.'); await load() }
  }
  async function voidIt(id: string) {
    if (!window.confirm('Void this invoice? Its expenses become billable again.')) return
    const j = await post({ action: 'void', id }, 'Could not void the invoice')
    if (j) { setNotice('Voided. Its expenses can be billed again.'); await load() }
  }
  async function addAccounts() {
    const j = await post({ action: 'accounts', to }, 'Could not add the accounts')
    if (j) { setNotice(`Added Due from ${preview?.to.name ?? 'the fund'} to ${group ?? 'this entity'}’s chart. Book what you paid for the fund to it.`); await runPreview() }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>

  const sel = 'mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm'
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        When {group ?? 'this entity'} pays a fund’s expense, book it to “Due from” that fund instead of an expense. The quarter’s invoice bills every posted debit to that account not already invoiced, and the PDF lists each one with its receipt behind it. Issuing books the expense and the payable on the fund’s books; the fund’s payment, settled on the Intercompany tab, clears the receivable.
      </p>
      {unbilled.length > 0 && (
        <p className="text-sm">Not yet invoiced: {unbilled.map(u => `${u.name} ${fmt(u.amount)} (${u.entries} ${u.entries === 1 ? 'expense' : 'expenses'})`).join(', ')}.</p>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-card border p-3">
        <label className="text-xs text-muted-foreground">Bill to
          <select value={to} onChange={e => { setTo(e.target.value); setPreview(null) }} className={sel}>
            <option value="">Choose a fund…</option>
            {counterparties.filter(c => c.id && c.id !== vehicleId).map(c => <option key={c.id!} value={c.id!}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Quarter
          <select value={quarter} onChange={e => { setQuarter(Number(e.target.value)); setPreview(null) }} className={sel}>
            {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Year
          <input type="number" value={year} onChange={e => { setYear(Number(e.target.value)); setPreview(null) }} className={`${sel} w-24 tabular-nums`} />
        </label>
        <Button size="sm" variant="outline" disabled={!to || busy} onClick={() => void runPreview()}>{busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Find expenses</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && !error && <p className="text-sm text-success">{notice}</p>}

      {preview && (
        <div className="space-y-2 rounded-card border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{preview.to.name}, {preview.quarter.label}: {preview.lines.length} {preview.lines.length === 1 ? 'expense' : 'expenses'}, {fmt(preview.total)}</p>
            {preview.existing
              ? <span className="text-xs text-muted-foreground">Already billed on {preview.existing.invoiceNumber} ({preview.existing.status}).</span>
              : <Button size="sm" disabled={busy || preview.lines.length === 0} onClick={() => void create()}>Create draft invoice</Button>}
          </div>
          {preview.drafts.length > 0 && (
            <p className="text-sm text-warning">{preview.drafts.length} {preview.drafts.length === 1 ? 'expense is' : 'expenses are'} still a draft and will not be billed until posted.</p>
          )}
          {!preview.hasReceivableAccount && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-muted-foreground">{group ?? 'This entity'}’s chart has no Due from {preview.to.name} account yet, so there is nothing to bill.</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void addAccounts()}>Add the account</Button>
            </div>
          )}
          <LinesTable lines={preview.lines} fmt={fmt} onOpen={setOpenEntry} />
        </div>
      )}

      {invoices.length === 0 ? (
        <EmptyState icon={FileText}>No partnership invoices yet.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground">
            <th className="pb-1 font-medium">Invoice</th><th className="pb-1 font-medium">Period</th><th className="pb-1 font-medium">From → to</th>
            <th className="pb-1 text-right font-medium">Amount</th><th className="pb-1 font-medium">Status</th><th />
          </tr></thead>
          <tbody>
            {invoices.map(i => {
              const mine = i.from_vehicle_id === vehicleId
              return (
                <tr key={i.id} className="border-t">
                  <td className="py-1.5">{i.invoice_number}</td>
                  <td className="py-1.5 tabular-nums text-xs">{i.period_start} – {i.period_end}</td>
                  <td className="py-1.5 text-xs">{i.from_name ?? '—'} → {i.to_name ?? '—'}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(Number(i.amount))}</td>
                  <td className="py-1.5 text-xs capitalize">{i.status}</td>
                  <td className="py-1.5 text-right">
                    <span className="inline-flex gap-1.5">
                      <a className={smallBtn} href={`/api/accounting/partnership-invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                      {mine && i.status === 'draft' && <button className={smallBtn} disabled={busy} onClick={() => void issue(i.id)}>Issue</button>}
                      {mine && i.status !== 'void' && <button className={smallBtn} disabled={busy} onClick={() => void voidIt(i.id)}>Void</button>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {openEntry && <EntryModal entryId={openEntry} readOnly onClose={() => setOpenEntry(null)} onSaved={() => void load()} />}
    </div>
  )
}

function LinesTable({ lines, fmt, onOpen }: { lines: Line[]; fmt: (v: number) => string; onOpen: (id: string) => void }) {
  if (lines.length === 0) return <p className="text-xs text-muted-foreground">No posted debits to the fund’s Due-from account in this quarter that are not already invoiced.</p>
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-muted-foreground">
        <th className="pb-1 font-medium">Date</th><th className="pb-1 font-medium">Vendor</th><th className="pb-1 font-medium">Memo</th>
        <th className="pb-1 font-medium">Receipt</th><th className="pb-1 text-right font-medium">Amount</th>
      </tr></thead>
      <tbody>
        {lines.map(l => (
          <tr key={l.postingId} className="border-t">
            <td className="py-1 tabular-nums"><button className="underline underline-offset-2" onClick={() => onOpen(l.entryId)}>{l.entryDate}</button></td>
            <td className="py-1">{l.vendorName ?? '—'}</td>
            <td className="py-1">{l.memo ?? '—'}</td>
            <td className={`py-1 ${l.receiptCount > 0 ? '' : 'text-muted-foreground'}`}>{l.receiptCount > 0 ? `${l.receiptCount}` : 'missing'}</td>
            <td className="py-1 text-right tabular-nums">{fmt(l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
