'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { AccountPicker, type PickerAccount } from '@/components/accounting/account-picker'
import { ENTRY_SOURCE_TYPES, ENTRY_SOURCE_TYPE_LABELS, isEntrySourceType } from '@/lib/accounting/source-types'
import { reversedEntryId } from '@/lib/accounting/reversal'

interface Acct { id: string; code: string; name: string; type?: string; lp_entity_id: string | null; is_active?: boolean }
interface PostingRow { id: string; account_id: string; amount: number; lp_entity_id: string | null }
interface Line { key: string; accountId: string; debit: string; credit: string; lpEntityId: string | null }
interface VendorOpt { id: string; name: string }
const NEW_VENDOR = '__new__'

interface Meta { status: string; postedAt: string | null; sourceRef: string | null; reversedBy: string | null; ownedBy: { id: string; company: string; type: string; date: string | null }[] }

let seq = 0
const newLine = (): Line => ({ key: `l${seq++}`, accountId: '', debit: '', credit: '', lpEntityId: null })
const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }
const today = () => new Date().toISOString().slice(0, 10)
const short = (id: string) => id.slice(0, 8)
const typeLabel = (t: string) => (isEntrySourceType(t) ? ENTRY_SOURCE_TYPE_LABELS[t] : String(t).replace(/_/g, ' '))

/**
 * The one editor for a journal entry, wherever it came from.
 *
 * - From the Bank page: pass `txnId` so posting/unposting also keeps the bank
 *   transaction's status in step.
 * - From the Journal page: omit `txnId`; it posts/unposts through the journal API.
 * - With no `entryId` at all: a blank NEW entry.
 *
 * `readOnly` opens a posted entry for viewing without reverting it; unposting from
 * there flips this same modal into edit mode. A posted entry can also be reversed (a dated
 * contra-entry, the correction a ledger keeps), duplicated (a new entry with the same lines,
 * dated today), or voided.
 *
 * `onPosted` fires after "Save & post" succeeds, with the entry and the first account it
 * debited, so the caller can take the user to that account's register — the journal does.
 */
export function EntryModal({
  txnId,
  entryId,
  readOnly = false,
  book = 'actual',
  onClose,
  onSaved,
  onPosted,
}: {
  txnId?: string
  entryId?: string | null
  readOnly?: boolean
  /** 'tax' opens a book-to-tax adjusting entry — read-only; the tax run writes those. */
  book?: 'actual' | 'tax'
  onClose: () => void
  onSaved: () => void
  onPosted?: (info: { entryId: string; entryDate: string; accountCode: string | null }) => void
}) {
  const taxBook = book === 'tax'
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)

  const [id, setId] = useState<string | null>(entryId ?? null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Acct[]>([])
  const [date, setDate] = useState('')
  const [memo, setMemo] = useState('')
  const [reference, setReference] = useState('')
  const [vendorId, setVendorId] = useState<string | null>(null)
  const [vendors, setVendors] = useState<VendorOpt[]>([])
  // A string, not the narrowed union: a bank- or import-drafted entry can carry a type outside
  // the picker's list (quickbooks, investment, transfer), and saving it must keep that type
  // rather than quietly relabel it. The picker offers the list plus whatever the entry had.
  const [sourceType, setSourceType] = useState<string>('manual')
  // An accrual that should come back out next period: after posting, a reversal draft is
  // created on this date through the same `reverse` action a person would use.
  const [reversesOn, setReversesOn] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [editable, setEditable] = useState(!readOnly && !taxBook)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [copyOf, setCopyOf] = useState<string | null>(null)
  // The Reverse control on a posted entry: a date, then a choice of draft or post.
  const [reverseDate, setReverseDate] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      entryId ? lf(`/api/accounting/journal?id=${entryId}${taxBook ? '&book=tax' : ''}`).then(r => (r.ok ? r.json() : null)) : Promise.resolve(null),
      lf('/api/accounting/chart').then(r => (r.ok ? r.json() : [])),
      lf('/api/accounting/vendors').then(r => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([entry, chart, vendorList]) => {
      setAccounts(Array.isArray(chart) ? chart : [])
      setVendors(Array.isArray(vendorList?.vendors) ? vendorList.vendors : [])
      if (entry) {
        setDate(entry.entry_date ?? '')
        setMemo(entry.memo ?? '')
        setReference(entry.reference ?? '')
        setVendorId(entry.vendor_id ?? null)
        setAdjusting(entry.adjusting === true)
        setSourceType(entry.source_type || 'manual')
        setMeta({ status: entry.status, postedAt: entry.posted_at ?? null, sourceRef: entry.source_ref ?? null, reversedBy: entry.reversed_by ?? null, ownedBy: entry.owned_by ?? [] })
        setLines((entry.journal_postings ?? []).map((p: PostingRow) => {
          const amt = Number(p.amount)
          return { key: `l${seq++}`, accountId: p.account_id, debit: amt > 0 ? String(amt) : '', credit: amt < 0 ? String(-amt) : '', lpEntityId: p.lp_entity_id }
        }))
      } else {
        // New entry: today's date and the two lines every entry needs at minimum.
        setDate(today())
        setLines([newLine(), newLine()])
      }
    }).finally(() => setLoading(false))
  }, [lf, entryId, taxBook])

  const isNew = !id
  const acctById = new Map(accounts.map(a => [a.id, a]))
  // Hidden accounts are not offered for NEW postings, but one a line ALREADY uses stays listed —
  // dropping it would blank the line. An account from another vehicle's chart (the chart is
  // vehicle-scoped) is shown by its id and named as such, rather than vanishing.
  const usable = (a: Acct) => a.is_active !== false || lines.some(l => l.accountId === a.id)
  const pickerAccounts: PickerAccount[] = [
    ...accounts.filter(usable).map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, lpEntityId: a.lp_entity_id })),
    ...Array.from(new Set(lines.map(l => l.accountId).filter(v => v && !acctById.has(v))))
      .map(orphan => ({ id: orphan, code: short(orphan), name: 'Not in this vehicle’s chart — switch vehicle to see it' })),
  ]

  const totalDebit = lines.reduce((s, l) => s + num(l.debit), 0)
  const totalCredit = lines.reduce((s, l) => s + num(l.credit), 0)
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100
  const balanced = diff === 0 && lines.length >= 2 && lines.every(l => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0))

  const update = (key: string, patch: Partial<Line>) => setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)))

  const json = (body: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const patch = (body: object) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const errOf = async (r: Response, fallback: string) => (await r.json().catch(() => ({}))).error ?? fallback

  /**
   * Post or unpost. A bank-sourced entry goes through the bank API so the
   * transaction's status stays in step with the entry; a standalone journal entry
   * goes straight to the journal API. Both end in the same ledger state.
   */
  async function setPosted(action: 'post' | 'unpost', targetId: string, reason?: string): Promise<string | null> {
    const res = txnId
      ? await lf('/api/accounting/bank', json({ action, id: txnId, reason }))
      : await lf('/api/accounting/journal', patch({ action, id: targetId, reason }))
    return res.ok ? null : await errOf(res, `${action} failed`)
  }

  /** The vendor select: pick one, clear it, or add one by name — created on the spot and selected. */
  async function chooseVendor(value: string) {
    if (value !== NEW_VENDOR) { setVendorId(value || null); return }
    const name = window.prompt('Vendor name')?.trim()
    if (!name) return
    const res = await lf('/api/accounting/vendors', json({ name }))
    if (!res.ok) { setError(await errOf(res, 'Could not add the vendor')); return }
    const v = (await res.json()).vendor as VendorOpt
    setVendors(prev => (prev.some(x => x.id === v.id) ? prev : [...prev, v].sort((a, b) => a.name.localeCompare(b.name))))
    setVendorId(v.id)
  }

  async function save(thenPost: boolean) {
    setSaving(true); setError(null)
    const postings = lines.map(l => ({ accountId: l.accountId, amount: num(l.debit) > 0 ? num(l.debit) : -num(l.credit), lpEntityId: l.lpEntityId }))
    const fields = { entryDate: date, memo, reference: reference.trim() || null, sourceType, adjusting, vendorId }

    // Create on first save; update thereafter. Always saved as a DRAFT first, so
    // posting is a separate, explicit step — same as every other path.
    let targetId = id
    if (!targetId) {
      const res = await lf('/api/accounting/journal', json({ ...fields, status: 'draft', postings }))
      if (!res.ok) { setError(await errOf(res, 'Could not create the entry')); setSaving(false); return }
      targetId = (await res.json()).id
      setId(targetId)
    } else {
      const res = await lf('/api/accounting/journal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: targetId, ...fields, postings }) })
      if (!res.ok) { setError(await errOf(res, 'Save failed')); setSaving(false); return }
    }

    if (thenPost && targetId) {
      const err = await setPosted('post', targetId)
      if (err) { setError(`Saved as a draft, but posting failed: ${err}`); setSaving(false); return }
      // The auto-reversal for an accrual: a draft dated `reversesOn`, through the same action
      // a person would use. Its failure is reported, not fatal — the entry itself is posted.
      if (reversesOn) {
        const r = await lf('/api/accounting/journal', patch({ action: 'reverse', id: targetId, reverseDate: reversesOn, reason: `Scheduled accrual reversal on ${reversesOn}` }))
        if (!r.ok) { setError(`Posted, but the reversal draft for ${reversesOn} could not be created: ${await errOf(r, 'unknown error')}`); setSaving(false); onSaved(); return }
      }
      setSaving(false); onSaved(); onClose()
      // The first debited line is the account the user thinks of as "where it went" — cash for a
      // receipt, the expense for a bill. Falls back to the first line for an all-credit oddity.
      const first = lines.find(l => num(l.debit) > 0) ?? lines[0]
      onPosted?.({ entryId: targetId, entryDate: date, accountCode: (first && acctById.get(first.accountId)?.code) ?? null })
      return
    }
    setSaving(false); onSaved(); onClose()
  }

  // Revert the entry to draft and stay open in edit mode — the read-only view's
  // way in. Refuses on a closed period, which surfaces as the API error.
  async function unpostAndEdit() {
    if (!id) return
    // Recorded with who did it, in the books' audit trail.
    const reason = window.prompt('Why is this entry being unposted?')?.trim()
    if (!reason) return
    setSaving(true); setError(null)
    const err = await setPosted('unpost', id, reason)
    if (err) { setError(err); setSaving(false); return }
    setSaving(false); setEditable(true); setMeta(m => (m ? { ...m, status: 'draft', postedAt: null } : m)); onSaved()
  }

  /** A dated contra-entry; the original stays posted. Draft unless asked to post. */
  async function reverse(post: boolean) {
    if (!id || !reverseDate) return
    const reason = window.prompt('Why is this entry being reversed?')?.trim()
    if (!reason) return
    setSaving(true); setError(null)
    const res = await lf('/api/accounting/journal', patch({ action: 'reverse', id, reverseDate, post, reason }))
    if (!res.ok) { setError(await errOf(res, 'Could not reverse the entry')); setSaving(false); return }
    setSaving(false); onSaved()
    setNotice(post ? `Reversed — the contra-entry is posted on ${reverseDate}.` : `Reversal saved as a draft dated ${reverseDate}. Post it from the journal when you are ready.`)
    setMeta(m => (m ? { ...m, reversedBy: 'pending' } : m))
    setReverseDate(null)
  }

  /** The same lines, today's date, a fresh entry — the monthly accrual retyped for you. */
  function duplicate() {
    setCopyOf(id)
    setId(null)
    setMeta(null)
    setEditable(true)
    setDate(today())
    setReference('')
    setReversesOn('')
    setNotice(null)
    setError(null)
    setReverseDate(null)
  }

  /**
   * Void. For a DRAFT this is discard — the only way to get rid of one. It's a void, not a delete:
   * the entry keeps its row and drops off the journal's default list, and the "Voided" status
   * filter is the way back. A hard delete would leave the bank transaction, capital call or carry
   * payment that points at it holding a null reference.
   *
   * For a POSTED entry, prefer Reverse: a void makes the original vanish from the ledger, which
   * is right for a same-day slip and wrong for anything a statement was already struck on.
   */
  async function voidEntry() {
    if (!id) return
    let question = meta?.status === 'posted'
      ? 'Void this posted entry? It drops off the ledger as if never posted. If a statement or a close already included it, reverse it instead so the correction is on the books.'
      : 'Discard this draft? It’s marked void and drops off the journal — pick “Voided” in the status filter to see it again.'
    if (meta?.ownedBy?.length) question += ` It also deletes the investment transaction${meta.ownedBy.length === 1 ? '' : 's'} it records.`
    if (!window.confirm(question)) return
    // A posted entry's void is recorded with its reason; a discarded draft needs none.
    let reason: string | undefined
    if (meta?.status === 'posted') {
      reason = window.prompt('Why is this posted entry being voided?')?.trim()
      if (!reason) return
    }
    setSaving(true); setError(null)
    const res = txnId
      ? await lf('/api/accounting/bank', json({ action: 'ignore', id: txnId, reason }))
      : await lf('/api/accounting/journal', patch({ action: 'void', id, reason }))
    if (!res.ok) { setError(await errOf(res, 'Could not void the entry')); setSaving(false); return }
    setSaving(false); onSaved(); onClose()
  }

  const reversalOfId = reversedEntryId(meta?.sourceRef)
  const title = isNew ? (copyOf ? 'New journal entry (copy)' : 'New journal entry') : editable ? 'Edit journal entry' : 'Journal entry'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-medium">{title}</h2>
          <div className="flex items-center gap-2">
            {!editable && meta && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{meta.status}</span>}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-muted-foreground">Date
                {editable
                  ? <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm" />
                  : <span className="mt-0.5 block px-2 py-1 tabular-nums text-sm text-foreground">{date || '—'}</span>}
              </label>
              <label className="w-32 text-xs text-muted-foreground">Reference
                {editable
                  ? <input value={reference} onChange={e => setReference(e.target.value)} placeholder="Check, invoice…" maxLength={80} className="mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm" />
                  : <span className="mt-0.5 block px-2 py-1 text-sm text-foreground">{reference || '—'}</span>}
              </label>
              <label className="w-40 text-xs text-muted-foreground">Vendor
                {editable ? (
                  <select value={vendorId ?? ''} onChange={e => void chooseVendor(e.target.value)} className="mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm" title="Who was paid — the payee on the 1099 worksheet and QuickBooks' Name column">
                    <option value="">—</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    <option value={NEW_VENDOR}>Add vendor…</option>
                  </select>
                ) : <span className="mt-0.5 block px-2 py-1 text-sm text-foreground">{vendors.find(v => v.id === vendorId)?.name ?? '—'}</span>}
              </label>
              <label className="text-xs text-muted-foreground">Type
                {editable ? (
                  <select value={sourceType} onChange={e => setSourceType(e.target.value)} className="mt-0.5 block rounded border border-input bg-transparent px-2 py-1 text-sm" title="What the entry is — this is the line it lands on in each partner's capital account">
                    {ENTRY_SOURCE_TYPES.map(t => <option key={t} value={t}>{ENTRY_SOURCE_TYPE_LABELS[t]}</option>)}
                    {!isEntrySourceType(sourceType) && <option value={sourceType}>{typeLabel(sourceType)}</option>}
                  </select>
                ) : <span className="mt-0.5 block px-2 py-1 text-sm text-foreground">{typeLabel(sourceType)}</span>}
              </label>
              <label className="min-w-[200px] flex-1 text-xs text-muted-foreground">Memo
                {editable
                  ? <input value={memo} onChange={e => setMemo(e.target.value)} className="mt-0.5 block w-full rounded border border-input bg-transparent px-2 py-1 text-sm" />
                  : <span className="mt-0.5 block px-2 py-1 text-sm text-foreground">{memo || '—'}</span>}
              </label>
            </div>

            {/* What this entry is to other entries — said plainly, because a reversed entry that
                still reads as ordinary is how a correction gets corrected twice. */}
            {meta && (meta.reversedBy || reversalOfId || meta.postedAt) && (
              <div className="text-xs text-muted-foreground">
                {meta.postedAt && <span>Posted {meta.postedAt.slice(0, 10)}. </span>}
                {reversalOfId && <span>Reversal of entry {short(reversalOfId)}. </span>}
                {meta.reversedBy && <span className="text-warning">Reversed{meta.reversedBy !== 'pending' ? ` by entry ${short(meta.reversedBy)}` : ''}.</span>}
              </div>
            )}

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-1 font-medium">Account</th>
                  <th className="w-28 pb-1 text-right font-medium">Debit</th>
                  <th className="w-28 pb-1 text-right font-medium">Credit</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const acct = acctById.get(l.accountId)
                  return (
                    <tr key={l.key}>
                      <td className="py-1 pr-2">
                        {!editable ? (
                          <span className="text-xs">
                            {acct?.name ?? (l.accountId ? `${short(l.accountId)}… (another vehicle’s account)` : '—')}
                            {acct?.code && <span className="ml-1.5 tabular-nums text-muted-foreground/70">{acct.code}</span>}
                          </span>
                        ) : (
                          <AccountPicker
                            accounts={pickerAccounts}
                            value={l.accountId}
                            onChange={accountId => {
                              const a = acctById.get(accountId)
                              // The account determines the partner: per-LP capital accounts carry
                              // their own lp_entity_id, so switching account switches partner.
                              update(l.key, { accountId, lpEntityId: a?.lp_entity_id ?? null })
                            }}
                            placeholder="Code or name…"
                          />
                        )}
                      </td>
                      {editable ? (
                        <>
                          <td className="px-1 py-1"><input inputMode="decimal" value={l.debit} onChange={e => update(l.key, { debit: e.target.value, credit: '' })} className="w-full rounded border border-input bg-transparent px-1.5 py-1 text-right tabular-nums text-xs" /></td>
                          <td className="px-1 py-1"><input inputMode="decimal" value={l.credit} onChange={e => update(l.key, { credit: e.target.value, debit: '' })} className="w-full rounded border border-input bg-transparent px-1.5 py-1 text-right tabular-nums text-xs" /></td>
                          <td className="py-1 text-right"><button onClick={() => setLines(prev => prev.filter(x => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button></td>
                        </>
                      ) : (
                        <>
                          <td className="px-1 py-1 text-right tabular-nums text-xs">{num(l.debit) > 0 ? fmt(num(l.debit)) : ''}</td>
                          <td className="px-1 py-1 text-right tabular-nums text-xs">{num(l.credit) > 0 ? fmt(num(l.credit)) : ''}</td>
                          <td />
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t text-xs">
                  <td className="pt-1">{editable && <button onClick={() => setLines(prev => [...prev, newLine()])} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /> Add line</button>}</td>
                  <td className="pt-1 text-right tabular-nums">{fmt(totalDebit)}</td>
                  <td className="pt-1 text-right tabular-nums">{fmt(totalCredit)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {(editable || adjusting) && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={adjusting} disabled={!editable} onChange={e => setAdjusting(e.target.checked)} />
                Adjusting entry
                <span className="text-muted-foreground/70">— a period-end correction, listed on its own for the preparer</span>
              </label>
            )}

            {editable && (
              <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Reverses on
                <input type="date" value={reversesOn} min={date || undefined} onChange={e => setReversesOn(e.target.value)} className="rounded border border-input bg-transparent px-2 py-1 text-sm" />
                <span>optional — for an accrual: after posting, a reversal draft is created on this date</span>
              </label>
            )}

            <div className="flex items-center justify-between gap-3">
              <span className={`text-sm ${diff === 0 ? 'text-muted-foreground' : 'text-warning'}`}>{diff === 0 ? 'Balanced' : `Out of balance by ${fmt(Math.abs(diff))}`}</span>
              {error && <span className="text-sm text-destructive">{error}</span>}
              {notice && !error && <span className="text-sm text-success">{notice}</span>}
            </div>
            </div>

            {/* Pinned footer — stays visible no matter how many lines the entry has;
                the lines area above scrolls within the modal's max height. */}
            <div className="border-t p-4">
              {taxBook ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">A book-to-tax adjusting entry. The tax run writes and rewrites these; post the year again from the Tax page to change them.</span>
                  <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
                </div>
              ) : editable ? (
                <div className="flex items-center justify-end gap-2">
                  {/* Only once the entry exists — an unsaved new one is discarded by Cancel.
                      Pushed to the far left so it can't be hit while reaching for Save. */}
                  {id && (
                    <Button
                      size="sm" variant="ghost" onClick={voidEntry} disabled={saving}
                      title="Mark this draft void — it drops off the journal"
                      className="mr-auto text-destructive hover:text-destructive"
                    >
                      Discard
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
                  <Button size="sm" variant="outline" onClick={() => save(false)} disabled={saving || !balanced}>{saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save draft</Button>
                  <Button size="sm" onClick={() => save(true)} disabled={saving || !balanced}>Save &amp; post</Button>
                </div>
              ) : reverseDate !== null ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                    Reverse on
                    <input type="date" value={reverseDate} min={date || undefined} onChange={e => setReverseDate(e.target.value)} className="rounded border border-input bg-transparent px-2 py-1 text-sm" autoFocus />
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => setReverseDate(null)} disabled={saving}>Cancel</Button>
                  <Button size="sm" variant="outline" onClick={() => reverse(false)} disabled={saving || !reverseDate} title="Create the contra-entry as a draft to review first">{saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save reversal as draft</Button>
                  <Button size="sm" onClick={() => reverse(true)} disabled={saving || !reverseDate}>Reverse and post</Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {meta?.ownedBy && meta.ownedBy.length > 0 && (
                    <p className="text-xs text-muted-foreground basis-full">
                      Recorded as {meta.ownedBy.length === 1 ? 'an investment transaction' : `${meta.ownedBy.length} investment transactions`}{' '}
                      ({Array.from(new Set(meta.ownedBy.map(o => o.company))).join(', ')}). Unposting, voiding or reversing this entry
                      deletes {meta.ownedBy.length === 1 ? 'it' : 'them'}; edit the transaction on its company page to change it instead.
                    </p>
                  )}
                  <Button
                    size="sm" variant="ghost" onClick={voidEntry} disabled={saving}
                    title="Drop the entry from the ledger as if never posted — prefer Reverse for anything already reported"
                    className="mr-auto text-destructive hover:text-destructive"
                  >
                    Void
                  </Button>
                  <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
                  <Button size="sm" variant="outline" onClick={duplicate} disabled={saving} title="A new entry with the same lines, dated today">Duplicate</Button>
                  {!meta?.reversedBy && (
                    <Button size="sm" variant="outline" onClick={() => setReverseDate(date || today())} disabled={saving} title="A dated contra-entry; this one stays posted">Reverse…</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={unpostAndEdit} disabled={saving} title="Revert to draft so you can edit it">{saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Unpost &amp; edit</Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
