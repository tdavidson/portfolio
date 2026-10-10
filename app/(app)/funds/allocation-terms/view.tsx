'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, ArrowLeftRight, Pencil, Trash2, SlidersHorizontal, Banknote, History, CalendarCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { RenameInvestorDialog } from '@/components/lp/rename-investor-dialog'

type Category = 'management_fee' | 'partnership_expense' | 'organizational_expense' | 'realized_gain' | 'valuation' | 'income' | 'carried_interest'

interface Term { lpEntityId: string; category: Category; participates: boolean; weightOverride: number | null; rateOverride: number | null }
interface Partner { lpEntityId: string; name: string; partnerClass: string; commitment: number; terms: Term[] }
interface Closing { id: string; name: string; closeDate: string; notes: string | null; members: { lpEntityId: string; name: string }[] }
interface CommitmentEvent { id: string; lpEntityId: string; name: string; effectiveDate: string; amount: number; kind: string; transferId?: string | null; memo?: string | null }

// The categories worth setting per partner. Gains/income are almost always pro-rata
// to everyone, so they're not surfaced here — the API still accepts them.
const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'management_fee', label: 'Management fee' },
  { key: 'partnership_expense', label: 'Partnership expenses' },
  { key: 'organizational_expense', label: 'Org. expenses' },
  { key: 'carried_interest', label: 'Carried interest' },
]

export function AllocationTermsView({ showHeader = true }: { showHeader?: boolean } = {}) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const lf = useLedgerFetch()

  const [basis, setBasis] = useState<'commitment' | 'capital_balance'>('commitment')
  const [partners, setPartners] = useState<Partner[]>([])
  const [events, setEvents] = useState<CommitmentEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showChange, setShowChange] = useState(false)
  const [isTransfer, setIsTransfer] = useState(false)
  const [lp, setLp] = useState('')
  const [from, setFrom] = useState('')
  const [amount, setAmount] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [memo, setMemo] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ entityId: string; name: string } | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [showBasis, setShowBasis] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCommitment, setAddCommitment] = useState('')
  const [addPartnerClass, setAddPartnerClass] = useState('lp')
  const [addClosing, setAddClosing] = useState('')
  const [adding, setAdding] = useState(false)

  const [closings, setClosings] = useState<Closing[]>([])
  const [unassigned, setUnassigned] = useState<{ lpEntityId: string; name: string }[]>([])
  const [showClosings, setShowClosings] = useState(false)
  const [newClosingName, setNewClosingName] = useState('')
  const [newClosingDate, setNewClosingDate] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [t, c, cl] = await Promise.all([
      lf('/api/accounting/allocation-terms').then(r => (r.ok ? r.json() : null)),
      lf('/api/accounting/commitments').then(r => (r.ok ? r.json() : null)),
      lf('/api/accounting/closings').then(r => (r.ok ? r.json() : null)),
    ])
    if (t) { setBasis(t.basis); setPartners(t.partners ?? []) }
    if (c) setEvents(c.events ?? [])
    if (cl) { setClosings(cl.closings ?? []); setUnassigned(cl.unassigned ?? []) }
    setLoading(false)
  }, [lf])
  useEffect(() => { load() }, [load])

  const post = async (url: string, body: object, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') => {
    setBusy(true); setError(null)
    try {
      const res = await lf(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      // Guard the parse: a 500 returns an HTML error page, not JSON, so a bare
      // res.json() would throw BEFORE the !res.ok check and the failure would vanish
      // (unhandled rejection, no error shown, busy stuck true).
      const data = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) { setError(data.error ?? `Request failed (${res.status})`); return false }
      await load()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request did not complete — check your connection and try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const termFor = (p: Partner, c: Category) => p.terms.find(t => t.category === c)

  async function addLp() {
    if (!addName.trim()) { setError('Enter a name'); return }
    setAdding(true)
    const ok = await post('/api/accounting/lps', {
      name: addName.trim(), commitment: Number(addCommitment) || 0, partnerClass: addPartnerClass,
      closingId: addClosing || null,
    })
    setAdding(false)
    if (ok) { setAddName(''); setAddCommitment(''); setAddPartnerClass('lp'); setAddClosing(''); setShowAdd(false) }
  }

  async function addClosing_() {
    if (!newClosingName.trim() || !newClosingDate) { setError('A closing needs a name and a date'); return }
    const ok = await post('/api/accounting/closings', { name: newClosingName.trim(), closeDate: newClosingDate })
    if (ok) { setNewClosingName(''); setNewClosingDate('') }
  }

  async function admitAt(closingId: string, lpEntityId: string) {
    const c = closings.find(x => x.id === closingId)
    if (!c) return
    await post('/api/accounting/closings', { id: closingId, members: [...c.members.map(m => m.lpEntityId), lpEntityId] }, 'PATCH')
  }

  async function admitAllUnassigned(closingId: string) {
    const c = closings.find(x => x.id === closingId)
    if (!c || unassigned.length === 0) return
    await post('/api/accounting/closings', { id: closingId, members: [...c.members.map(m => m.lpEntityId), ...unassigned.map(u => u.lpEntityId)] }, 'PATCH')
  }

  async function removeFromClosing(closingId: string, lpEntityId: string) {
    const c = closings.find(x => x.id === closingId)
    if (!c) return
    await post('/api/accounting/closings', { id: closingId, members: c.members.map(m => m.lpEntityId).filter(id => id !== lpEntityId) }, 'PATCH')
  }

  async function toggle(p: Partner, c: Category, participates: boolean) {
    await post('/api/accounting/allocation-terms', {
      action: 'term', lpEntityId: p.lpEntityId, category: c, participates,
      weightOverride: termFor(p, c)?.weightOverride ?? null,
    })
  }

  async function submitChange() {
    const amt = Number(amount)
    if (!lp || !effectiveDate || !amt) { setError('Partner, date, and a non-zero amount are required'); return }
    // Changing a recorded amount is kept in the audit trail with its reason.
    let reason: string | undefined
    const original = editingId ? events.find(e => e.id === editingId) : undefined
    if (original && Number(original.amount) !== amt) {
      reason = window.prompt('Why is this commitment amount changing?')?.trim()
      if (!reason) return
    }
    const ok = editingId
      ? await post('/api/accounting/commitments', {
          id: editingId,
          effectiveDate,
          amount: amt,
          memo: memo || null,
          reason,
        }, 'PATCH')
      : await post('/api/accounting/commitments', {
          lpEntityId: lp,
          effectiveDate,
          amount: amt,
          counterpartyEntityId: isTransfer ? from : null,
          memo: memo || null,
        })
    if (ok) resetChangeForm()
  }

  function resetChangeForm() {
    setLp(''); setFrom(''); setAmount(''); setMemo(''); setEffectiveDate(''); setIsTransfer(false)
    setEditingId(null); setShowChange(false)
  }

  function startEdit(e: CommitmentEvent) {
    setEditingId(e.id)
    setIsTransfer(false)
    setLp(e.lpEntityId)
    setFrom('')
    setAmount(String(e.amount))
    setEffectiveDate(e.effectiveDate)
    setMemo(e.memo ?? '')
    setShowChange(true)
  }

  async function deleteEvent(id: string) {
    const reason = window.prompt('Why is this commitment event being deleted? (Kept in the audit trail.)')?.trim()
    if (!reason) return
    await post('/api/accounting/commitments', { id, reason }, 'DELETE')
  }

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>

  const totalCommitment = partners.reduce((s, p) => s + p.commitment, 0)

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-warning">{error}</p>}

      {/* Per-partner terms — actions (Add LP / Change Commitment / Basis) share one panel */}
      <div>
        {showHeader && <>
        <p className="text-sm font-medium mb-1">Partners</p>
        <p className="text-xs text-muted-foreground mb-2">
          Add partners, change commitments, record transfers, and set expense allocations.
        </p>
        </>}

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => { setShowBasis(false); if (showAdd) { setShowAdd(false) } else { setShowAdd(true); setShowChange(false) } }}>
            <Plus className="h-3.5 w-3.5 mr-1" />Add LP
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => { setShowBasis(false); if (showChange) resetChangeForm(); else { setShowChange(true); setShowAdd(false) } }}
          >
            <Banknote className="h-3.5 w-3.5 mr-1" />Change Commitment
          </Button>
          {/* Basis: a compact button showing the current setting; opens a small popup. */}
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => { setShowBasis(v => !v); setShowAdd(false); setShowChange(false) }}
            title="What the close splits each category on"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 mr-1" />Basis: {basis === 'commitment' ? 'Committed' : 'Capital balance'}
          </Button>
        </div>

        {showBasis && (
          <div className="border rounded-card p-3 mb-3 max-w-md space-y-2">
            <p className="text-xs text-muted-foreground">
              What the close splits each category on. Commitment is the common default; some LPAs
              allocate on capital-account balance at period end.
            </p>
            <select
              value={basis}
              onChange={e => {
                const v = e.target.value as 'commitment' | 'capital_balance'
                setBasis(v)
                post('/api/accounting/allocation-terms', { action: 'basis', basis: v })
                setShowBasis(false)
              }}
              disabled={busy}
              className="h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="commitment">Committed capital</option>
              <option value="capital_balance">Capital-account balance (at period end)</option>
            </select>
          </div>
        )}

        {showAdd && (
          <div className="border rounded-card p-3 mb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted-foreground">Name
              <Input value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. GP Associates LLC" className="mt-1 h-9 w-64" />
            </label>
            <label className="text-xs text-muted-foreground">Commitment
              <Input value={addCommitment} onChange={e => setAddCommitment(e.target.value)} inputMode="decimal" placeholder="0.00" className="mt-1 h-9 w-36 tabular-nums" />
            </label>
            <label className="text-xs text-muted-foreground">Type
              <select value={addPartnerClass} onChange={e => setAddPartnerClass(e.target.value)} className="mt-1 block h-9 px-3 rounded-md border border-input bg-background text-sm">
                <option value="lp">LP</option>
                <option value="gp">GP</option>
              </select>
            </label>
            {closings.length > 0 && (
              <label className="text-xs text-muted-foreground">Admitted at
                <select value={addClosing} onChange={e => setAddClosing(e.target.value)} className="mt-1 block h-9 px-3 rounded-md border border-input bg-background text-sm">
                  <option value="">—</option>
                  {closings.map(c => <option key={c.id} value={c.id}>{c.name} ({c.closeDate})</option>)}
                </select>
              </label>
            )}
            <Button size="sm" onClick={addLp} disabled={adding}>{adding && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Add</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={adding}
              onClick={() => { setShowAdd(false); setAddName(''); setAddCommitment(''); setAddPartnerClass('lp'); setError(null) }}
            >
              Cancel
            </Button>
          </div>
        )}

        {showChange && (
          <div className="border rounded-card p-3 mb-3 space-y-3">
            {editingId && (
              <p className="text-xs text-muted-foreground">Editing an existing event — partner and transfer type can&rsquo;t change; delete and re-enter to change either.</p>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={isTransfer} disabled={!!editingId} onChange={e => setIsTransfer(e.target.checked)} />
              <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
              Transfer between partners (rather than an increase or decrease)
            </label>
            <div className="flex flex-wrap items-end gap-3">
              {isTransfer && (
                <label className="text-xs text-muted-foreground">From
                  <select value={from} disabled={!!editingId} onChange={e => setFrom(e.target.value)} className="mt-1 block h-9 px-2 rounded-md border border-input bg-background text-sm max-w-[200px]">
                    <option value="">Select…</option>
                    {partners.map(p => <option key={p.lpEntityId} value={p.lpEntityId}>{p.name}</option>)}
                  </select>
                </label>
              )}
              <label className="text-xs text-muted-foreground">{isTransfer ? 'To' : 'Partner'}
                <select value={lp} disabled={!!editingId} onChange={e => setLp(e.target.value)} className="mt-1 block h-9 px-2 rounded-md border border-input bg-background text-sm max-w-[200px]">
                  <option value="">Select…</option>
                  {partners.map(p => <option key={p.lpEntityId} value={p.lpEntityId}>{p.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">Amount
                <Input
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder={isTransfer ? '100000' : '100000 or -50000'}
                  className="mt-1 h-9 w-36 tabular-nums"
                />
              </label>
              <label className="text-xs text-muted-foreground">Effective
                <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="mt-1 h-9 w-40" />
              </label>
              <label className="text-xs text-muted-foreground flex-1 min-w-[160px]">Memo
                <Input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Secondary sale" className="mt-1 h-9 w-full" />
              </label>
              <Button size="sm" onClick={submitChange} disabled={busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}{editingId ? 'Save change' : 'Record'}
              </Button>
              {editingId && (
                <Button size="sm" variant="ghost" onClick={resetChangeForm} disabled={busy}>Cancel</Button>
              )}
            </div>
          </div>
        )}

        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">Partner</th>
                <th className="text-right px-3 py-2 font-medium">Commitment</th>
                {CATEGORIES.map(c => <th key={c.key} className="px-3 py-2 font-medium text-center">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {partners.map(p => (
                <tr key={p.lpEntityId} className="group border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span>{p.name}</span>
                      {p.partnerClass === 'gp' && <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-muted text-muted-foreground">GP</span>}
                      <button
                        type="button"
                        onClick={() => setRenaming({ entityId: p.lpEntityId, name: p.name })}
                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                        title="Rename"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(p.commitment)}</td>
                  {CATEGORIES.map(c => {
                    const t = termFor(p, c.key)
                    const on = t ? t.participates : true
                    return (
                      <td key={c.key} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          onChange={e => toggle(p, c.key, e.target.checked)}
                          aria-label={`${p.name} bears ${c.label}`}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(totalCommitment)}</td>
                {CATEGORIES.map(c => <td key={c.key} />)}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* 2b. Closings ------------------------------------------------------ */}
      <div>
        <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setShowClosings(v => !v)}>
          <CalendarCheck className="h-3.5 w-3.5 mr-1" />{showClosings ? 'Hide closings' : `Closings${closings.length ? ` (${closings.length})` : ''}`}
        </Button>

        {showClosings && (
          <div className="mt-2 space-y-3">
            <p className="text-xs text-muted-foreground">
              When this vehicle admitted its partners. A closing is a name and a date; admitting a partner at it records
              when they came in — the onboarding checklist is due by that date, and it is what a fee commencement date
              or a late-closer equalisation would read. It does not create or change a commitment.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">Name
                <Input value={newClosingName} onChange={e => setNewClosingName(e.target.value)} placeholder="First Close" className="mt-1 h-9 w-44" />
              </label>
              <label className="text-xs text-muted-foreground">Date
                <Input type="date" value={newClosingDate} onChange={e => setNewClosingDate(e.target.value)} className="mt-1 h-9 w-40" />
              </label>
              <Button size="sm" onClick={addClosing_} disabled={busy}><Plus className="h-3.5 w-3.5 mr-1" />Add closing</Button>
            </div>
            {closings.length > 0 && (
              <div className="border rounded-lg divide-y">
                {closings.map(c => (
                  <div key={c.id} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{c.closeDate}</span>
                      <span className="text-xs text-muted-foreground">· {c.members.length} partner{c.members.length === 1 ? '' : 's'}</span>
                      <span className="flex-1" />
                      {unassigned.length > 0 && (
                        <>
                          <select value="" disabled={busy} onChange={e => { if (e.target.value) admitAt(c.id, e.target.value) }} className="h-7 px-2 rounded-md border border-input bg-background text-xs">
                            <option value="">Admit a partner…</option>
                            {unassigned.map(u => <option key={u.lpEntityId} value={u.lpEntityId}>{u.name}</option>)}
                          </select>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => admitAllUnassigned(c.id)} title="Admit every partner not yet admitted at a closing">
                            Admit all {unassigned.length}
                          </Button>
                        </>
                      )}
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" disabled={busy} title="Delete closing"
                        onClick={() => post('/api/accounting/closings', { id: c.id }, 'DELETE')}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {c.members.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.members.map(m => (
                          <span key={m.lpEntityId} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                            {m.name}
                            <button type="button" disabled={busy} onClick={() => removeFromClosing(c.id, m.lpEntityId)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${m.name} from ${c.name}`}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {closings.length > 0 && unassigned.length > 0 && (
              <p className="text-xs text-muted-foreground">Not yet admitted at a closing: {unassigned.map(u => u.name).join(', ')}.</p>
            )}
          </div>
        )}
      </div>

      {/* 3. Commitment history --------------------------------------------- */}
      <div>
        <Button
          size="sm"
          variant="outline"
          className="text-muted-foreground"
          onClick={() => setShowHistory(v => !v)}
        >
          <History className="h-3.5 w-3.5 mr-1" />{showHistory ? 'Hide commitment history' : 'Commitment history'}
        </Button>

        {showHistory && (
          <div className="mt-2">
            <p className="text-xs text-muted-foreground mb-2">
              Commitments are effective-dated, so closing an old period uses the commitments that were in
              force then. A transfer writes both legs at once — the fund&rsquo;s total can&rsquo;t drift.
            </p>

            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No commitment events yet.</p>
            ) : (
              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left px-3 py-2 font-medium">Effective</th>
                      <th className="text-left px-3 py-2 font-medium">Partner</th>
                      <th className="text-left px-3 py-2 font-medium">Kind</th>
                      <th className="text-right px-3 py-2 font-medium">Change</th>
                      <th className="text-right px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map(e => {
                      const isXfer = e.kind.startsWith('transfer')
                      return (
                        <tr key={e.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 tabular-nums text-xs">{e.effectiveDate}</td>
                          <td className="px-3 py-2">{e.name}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{e.kind.replace('_', ' ')}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${e.amount < 0 ? 'text-muted-foreground' : ''}`}>{fmt(e.amount)}</td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                disabled={busy || isXfer}
                                title={isXfer ? 'Transfers: delete and re-enter to correct' : 'Edit'}
                                onClick={() => startEdit(e)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                disabled={busy}
                                title="Delete"
                                onClick={() => deleteEvent(e.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {renaming && (
        <RenameInvestorDialog
          target={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => { setRenaming(null); load() }}
        />
      )}
    </div>
  )
}
