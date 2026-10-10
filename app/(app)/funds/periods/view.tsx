'use client'

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Loader2, Lock, Unlock, AlertTriangle, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicleBase } from '@/components/accounting-vehicle'

interface CloseCheck { check_key: string; section: string; label: string; status: string; detail: string | null; sort_order: number }
interface CloseReview { id: string; status: string; approved_at: string | null; attestation: string | null; close_review_checks: CloseCheck[] }
interface Period { id: string; period_start: string; period_end: string; label: string | null; status: string; closed_at: string | null; close_review?: CloseReview | null }
interface CloseEntryLine { accountCode: string; accountName: string; lpName: string | null; amount: number }
interface CloseEntry { id: string; entryDate: string; memo: string | null; sourceType: string | null; allocatedOn?: 'close' | 'posting'; lines: CloseEntryLine[] }
interface CloseLine { lpEntityId: string; name: string; amount: number }
interface CloseCategory {
  sourceType: string
  label: string
  capitalEffect: number
  accounts: { code: string; name: string; amount: number }[]
  lines: CloseLine[]
}
interface MonthPreview {
  periodStart: string
  periodEnd: string
  netIncome: number
  categories: CloseCategory[]
  allocatedOnPosting?: { entries: number; netIncome: number }
  warnings: string[]
}
interface Readiness {
  draftEntries: { count: number; earliest: string | null; items?: { id: string; entryDate: string; memo: string | null; amount: number }[] }
  unpostedBankTxns: { count: number; total: number }
  blockers: string[]
  blockerLinks?: Record<string, string>
  warnings: string[]
}
interface SuggestedEntry { id: string; basis: 'schedule' | 'recurring_pattern'; title: string; detail: string; entryDate: string; required: boolean; postings: { amount: number }[] }
interface Preview {
  start: string
  end: string
  months: MonthPreview[]
  totalNetIncome: number
  basis: string
  /** 'owner' for a management company or an individual: net income to one equity account, no split. */
  mode?: 'partners' | 'owner'
  readiness: Readiness
  warnings: string[]
  suggestedEntries: SuggestedEntry[]
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The months still open, derived: from where the next close would start through the end
 * of last month. A month in progress isn't offered — its books aren't finished. These rows
 * are never stored; a fiscal_periods row only exists once a month has been closed.
 */
function openMonths(nextStart: string | null): { period_start: string; period_end: string }[] {
  if (!nextStart) return []
  const now = new Date()
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const out: { period_start: string; period_end: string }[] = []
  let cursor = new Date(`${nextStart}T00:00:00Z`)
  while (true) {
    const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth()
    const end = new Date(Date.UTC(y, m + 1, 0))
    if (end > lastMonthEnd) break
    out.push({ period_start: iso(cursor), period_end: iso(end) })
    cursor = new Date(Date.UTC(y, m + 1, 1))
  }
  return out
}

export function PeriodsView() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [periods, setPeriods] = useState<Period[]>([])
  const [loading, setLoading] = useState(true)
  const [endDate, setEndDate] = useState('')
  const [nextStart, setNextStart] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [allocationDetail, setAllocationDetail] = useState<{ month: MonthPreview; category: CloseCategory } | null>(null)
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set())
  // Which closed period's allocated transactions are expanded, and their (cached) entries.
  const [openId, setOpenId] = useState<string | null>(null)
  const [entriesById, setEntriesById] = useState<Record<string, CloseEntry[] | 'loading'>>({})
  const lf = useLedgerFetch()
  const vehicleBase = useVehicleBase()
  const fundJournalHref = vehicleBase ? `${vehicleBase}/journal` : '/funds/journal'

  const load = useCallback(() => {
    setLoading(true)
    lf('/api/accounting/periods').then(r => (r.ok ? r.json() : null)).then(d => {
      setPeriods(Array.isArray(d?.periods) ? d.periods : [])
      setNextStart(d?.nextStart ?? null)
    }).finally(() => setLoading(false))
  }, [lf])
  useEffect(() => { load() }, [load])

  const post = async (body: object) => {
    const res = await lf('/api/accounting/periods', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { ok: res.ok, data: await res.json() }
  }

  async function previewThrough(through: string) {
    setBusy(true); setError(null); setPreview(null); setAllocationDetail(null)
    const { ok, data } = await post({ action: 'preview', endDate: through })
    setBusy(false)
    if (!ok) { setError(data.error ?? 'Could not preview'); return }
    setPreview(data)
    setSelectedSuggestions(new Set((data.suggestedEntries ?? []).map((item: SuggestedEntry) => item.id)))
  }

  /**
   * Post draft entries from here, through the journal's own bulk-post — so the same guards apply
   * (balanced, not in a closed period, investment access) and anything refused comes back with why.
   */
  async function postDrafts(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true
    const res = await lf('/api/accounting/journal/bulk-post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error ?? 'Could not post'); return false }
    const skipped = (data.skipped ?? []) as { id?: string; reason?: string }[]
    if (skipped.length) setError(`${skipped.length} not posted: ${skipped.map(s => s.reason ?? 'refused').join('; ')}`)
    return skipped.length === 0
  }

  /** Create the selected suggestions — and post them too, unless you asked for drafts. */
  async function createSuggested(postNow: boolean) {
    if (!preview || selectedSuggestions.size === 0) return
    setBusy(true); setError(null)
    const through = preview.end
    const { ok, data } = await post({ action: 'createSuggestedDrafts', endDate: through, ids: Array.from(selectedSuggestions) })
    if (!ok) { setBusy(false); setError(data.error ?? 'Could not create the entries'); return }
    if (postNow) await postDrafts(data.created ?? [])
    setBusy(false)
    await previewThrough(through)
  }

  async function postExistingDrafts(ids: string[]) {
    if (!preview) return
    setBusy(true); setError(null)
    const through = preview.end
    await postDrafts(ids)
    setBusy(false)
    await previewThrough(through)
  }

  async function confirmClose() {
    setBusy(true); setError(null)
    const { ok, data } = await post({ action: 'close', endDate })
    setBusy(false)
    if (!ok) { setError(data.error ?? 'Could not close'); return }
    setPreview(null)
    load()
  }

  // Expand a closed period to show the transactions its close posted (fetched once, then cached).
  async function toggleEntries(id: string) {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    if (!entriesById[id]) {
      setEntriesById(s => ({ ...s, [id]: 'loading' }))
      const res = await lf(`/api/accounting/periods?entriesFor=${id}`)
      const data = res.ok ? await res.json() : []
      setEntriesById(s => ({ ...s, [id]: Array.isArray(data) ? data : [] }))
    }
  }

  // Periods reopen newest-first, and the server cascades: reopening a period reopens every
  // closed period after it too. Say how many BEFORE doing it — two years of months is a lot
  // to unwind on one click without warning.
  const [confirmReopen, setConfirmReopen] = useState<string | null>(null)
  const laterClosed = (id: string) => {
    const target = periods.find(p => p.id === id)
    if (!target) return []
    return periods.filter(p => p.status === 'closed' && p.period_start > target.period_start)
  }

  async function reopen(id: string) {
    setBusy(true); setError(null); setConfirmReopen(null)
    const { ok, data } = await post({ action: 'reopen', id })
    setBusy(false)
    if (!ok) { setError(data.error ?? 'Could not reopen'); return }
    load()
  }

  // One list: stored rows (closed, plus any left open by a reopen) and the derived open
  // months, newest first. A stored row wins over a derived one for the same month.
  const rows: Period[] = [
    ...periods,
    ...openMonths(nextStart)
      .filter(m => !periods.some(p => p.period_start <= m.period_end && p.period_end >= m.period_start))
      .map(m => ({ id: `open:${m.period_start}`, ...m, label: null, status: 'open', closed_at: null, close_review: null })),
  ].sort((a, b) => (a.period_end < b.period_end ? 1 : -1))

  return (
    <div className="space-y-6">
      <div className="space-y-1 max-w-readable">
        <p className="text-sm font-medium">Periods</p>
        <p className="text-xs text-muted-foreground">
          Posted activity updates partner capital continuously. Closing reviews the books, preserves the evidence,
          and locks the period; reopening also reopens every later period.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {/* Nothing is posted until this is approved. */}
      {preview && (
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/30">
            <p className="text-sm font-medium">
              Review and close {preview.start} → {preview.end}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automated checks cover ledger completeness, bank activity, valuation exceptions, and partner allocations.
              {' '}Confirming preserves the review record, snapshot, and approval before locking the books.
            </p>
          </div>

          {/* Blockers, not warnings: closing over unposted work silently strands its
              P&L, and the lock then prevents posting it into the period. */}
          {/* The drafts inside the span, postable here — the blocker below says why they matter. */}
          {(preview.readiness.draftEntries.items?.length ?? 0) > 0 && (
            <div className="border-b">
              <div className="px-4 py-2.5 bg-muted/20 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Draft entries in this span</p>
                  <p className="text-[11px] text-muted-foreground">Post them to bring them into the close, or open the journal to edit or void one.</p>
                </div>
                <span className="flex items-center gap-2">
                  <Button size="sm" onClick={() => postExistingDrafts(preview.readiness.draftEntries.items!.map(d => d.id))} disabled={busy}>
                    Post all {preview.readiness.draftEntries.items!.length}
                  </Button>
                  <Button size="sm" variant="outline" asChild><Link href={fundJournalHref}>Open journal</Link></Button>
                </span>
              </div>
              {preview.readiness.draftEntries.items!.map(d => (
                <div key={d.id} className="px-4 py-2 border-t flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate"><span className="tabular-nums text-muted-foreground mr-2">{d.entryDate}</span>{d.memo ?? 'Untitled entry'}</span>
                  <span className="flex items-center gap-3 shrink-0">
                    <span className="tabular-nums">{fmt(d.amount)}</span>
                    <Button size="sm" variant="outline" onClick={() => postExistingDrafts([d.id])} disabled={busy}>Post</Button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {preview.readiness.blockers.map((b, i) => (
            <p key={`b${i}`} className="px-4 py-2 text-sm text-destructive flex items-start gap-1.5 border-b bg-destructive/5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                {b}
                {preview.readiness.blockerLinks?.[b] && (
                  <>{' '}<Link href={preview.readiness.blockerLinks[b]} className="underline underline-offset-2">Open the holding</Link></>
                )}
              </span>
            </p>
          ))}

          {[...preview.readiness.warnings, ...preview.warnings].map((w, i) => (
            <p key={`w${i}`} className="px-4 py-2 text-sm text-warning flex items-start gap-1.5 border-b">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{w}
            </p>
          ))}

          {preview.suggestedEntries?.length > 0 && (
            <div className="border-b">
              <div className="px-4 py-2.5 bg-muted/20">
                <p className="text-sm font-medium">Suggested closing entries</p>
                <p className="text-[11px] text-muted-foreground">Post the ones you want straight from here, or save them as drafts to edit in the journal first. Nothing posts until you choose.</p>
              </div>
              {preview.suggestedEntries.map(item => {
                const amount = item.postings.filter(line => line.amount > 0).reduce((sum, line) => sum + line.amount, 0)
                return (
                  <label key={item.id} className="px-4 py-2.5 border-t flex items-start gap-2 cursor-pointer hover:bg-muted/20">
                    <input type="checkbox" className="mt-0.5" checked={selectedSuggestions.has(item.id)} onChange={event => setSelectedSuggestions(current => {
                      const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next
                    })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3 text-xs font-medium"><span>{item.title}</span><span className="tabular-nums">{fmt(amount)}</span></span>
                      <span className="block text-[11px] text-muted-foreground">{item.entryDate} · {item.basis === 'schedule' ? 'Scheduled' : 'Detected recurring pattern'}{item.required ? ' · required' : ''}</span>
                      <span className="block text-[11px] text-muted-foreground">{item.detail}</span>
                    </span>
                  </label>
                )
              })}
              <div className="px-4 py-2.5 border-t flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => createSuggested(true)} disabled={busy || selectedSuggestions.size === 0}>Post selected</Button>
                <Button size="sm" variant="outline" onClick={() => createSuggested(false)} disabled={busy || selectedSuggestions.size === 0}>Save as drafts</Button>
              </div>
            </div>
          )}

          {preview.months.map(m => (
            <div key={m.periodStart} className="border-b last:border-b-0">
              <div className="px-4 py-2 flex items-center justify-between bg-muted/20">
                <span className="text-sm font-medium">
                  {m.periodStart} → {m.periodEnd}
                  {m.categories.length === 0 && !m.allocatedOnPosting?.entries && <span className="ml-2 text-xs font-normal text-muted-foreground">no activity</span>}
                </span>
                <span className="tabular-nums text-sm">{fmt(m.netIncome + (m.allocatedOnPosting?.netIncome ?? 0))}</span>
              </div>
              {/* Entries are allocated to partners when they are posted; the close only allocates what
                  was never allocated. Say so, or a fully-allocated month reads as empty. */}
              {(m.allocatedOnPosting?.entries ?? 0) > 0 && (
                <div className="px-4 py-2 border-t flex items-center justify-between text-xs">
                  <span>
                    <span className="font-medium">Already allocated when posted</span>
                    <span className="text-muted-foreground"> · {m.allocatedOnPosting!.entries} entr{m.allocatedOnPosting!.entries === 1 ? 'y' : 'ies'} — the close leaves {m.allocatedOnPosting!.entries === 1 ? 'it' : 'them'} as allocated</span>
                  </span>
                  <span className="tabular-nums">{fmt(m.allocatedOnPosting!.netIncome)}</span>
                </div>
              )}

              {m.categories.map(cat => (
                <button
                  key={cat.sourceType}
                  type="button"
                  onClick={() => preview.mode === 'partners' && setAllocationDetail({ month: m, category: cat })}
                  disabled={preview.mode !== 'partners'}
                  className="block w-full px-4 py-2 border-t text-left transition-colors enabled:hover:bg-muted/30 enabled:focus-visible:outline-none enabled:focus-visible:ring-2 enabled:focus-visible:ring-inset enabled:focus-visible:ring-ring"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{cat.label}</span>
                    <span className="tabular-nums text-xs">{fmt(cat.capitalEffect)}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {cat.accounts.map(a => `${a.code} ${a.name}`).join(', ')} · {preview.mode === 'owner' ? 'to the owner’s capital' : `${cat.lines.filter(l => l.amount !== 0).length} partners`}
                    {preview.mode === 'partners' && <span className="ml-1 font-medium text-foreground/70">· View allocation</span>}
                  </p>
                </button>
              ))}
            </div>
          ))}

          <div className="px-4 py-3 flex items-center gap-2 border-t bg-muted/30">
            <Button size="sm" onClick={confirmClose} disabled={busy || preview.readiness.blockers.length > 0}>
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}<Lock className="h-3.5 w-3.5 mr-1" />Close &amp; lock
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPreview(null)} disabled={busy}>Cancel</Button>
            {preview.readiness.blockers.length > 0 && (
              <span className="text-xs text-muted-foreground">Resolve the items above before closing.</span>
            )}
          </div>
        </div>
      )}

      <Dialog open={!!allocationDetail} onOpenChange={open => { if (!open) setAllocationDetail(null) }}>
        <DialogContent className="sm:max-w-3xl p-5 gap-4 overflow-hidden">
          {allocationDetail && (() => {
            const { month, category } = allocationDetail
            const lines = category.lines.filter(line => line.amount !== 0)
            const total = category.capitalEffect
            return <>
              <DialogHeader className="pr-8">
                <DialogTitle>{category.label}</DialogTitle>
                <DialogDescription>
                  {month.periodStart} → {month.periodEnd} · Allocated by {preview?.basis === 'capital_balance' ? 'capital-account balance' : 'commitment'} as of {month.periodEnd}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/95 backdrop-blur">
                    <tr className="border-b">
                      <th className="px-5 py-2 text-left font-medium">Partner</th>
                      <th className="px-3 py-2 text-right font-medium">Allocation</th>
                      <th className="px-5 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(line => (
                      <tr key={line.lpEntityId} className="border-b last:border-b-0">
                        <td className="px-5 py-2">{line.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {total === 0 ? '—' : `${((line.amount / total) * 100).toFixed(2)}%`}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums">{fmt(line.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-muted/30 font-medium">
                      <td className="px-5 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">100.00%</td>
                      <td className="px-5 py-2 text-right tabular-nums">{fmt(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          })()}
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to close yet — the ledger has no posted entries in a finished month.</p>
      ) : (
        <div className="border rounded-card overflow-x-auto">
          {/* Fixed layout: the columns are set here, not by their content, so an opened period's
              wide transaction detail can never push the action column out of view. */}
          <table className="w-full min-w-[40rem] table-fixed text-sm">
            <colgroup>
              <col className="w-[15rem]" />
              <col />
              <col className="w-32" />
              <col className="w-36" />
            </colgroup>
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">Period</th>
                <th className="text-left px-3 py-2 font-medium">Label</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const isClosed = p.status === 'closed'
                const open = openId === p.id
                const entries = entriesById[p.id]
                return (
                  <Fragment key={p.id}>
                    <tr
                      className={`border-b ${open ? '' : 'last:border-b-0'} ${isClosed ? 'cursor-pointer hover:bg-muted/20' : ''}`}
                      onClick={isClosed ? () => toggleEntries(p.id) : undefined}
                    >
                      <td className="px-3 py-2 tabular-nums text-xs">
                        <span className="flex items-center gap-1.5">
                          {/* Closed periods expand to show the transactions the close posted. */}
                          {isClosed
                            ? <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
                            : <span className="w-3.5 shrink-0" />}
                          {p.period_start} → {p.period_end}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate">{p.label ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${isClosed ? 'bg-success-subtle text-success dark:bg-success-subtle/30 dark:text-success' : 'bg-muted text-muted-foreground'}`}>
                          {isClosed ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}{p.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isClosed ? (
                          <button
                            onClick={e => { e.stopPropagation(); laterClosed(p.id).length > 0 ? setConfirmReopen(confirmReopen === p.id ? null : p.id) : reopen(p.id) }}
                            disabled={busy}
                            title={laterClosed(p.id).length > 0
                              ? `Reopens this period and the ${laterClosed(p.id).length} closed after it, newest-first, reversing each allocation.`
                              : "Void this period's allocation entries and unlock it."}
                            className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
                          >
                            Reopen
                          </button>
                        ) : (
                          // Closing runs THROUGH a date, so this previews everything from the
                          // last close up to this period's end — which, for the oldest open
                          // period, is exactly this period alone.
                          <button
                            onClick={e => { e.stopPropagation(); setEndDate(p.period_end); setPreview(null); previewThrough(p.period_end) }}
                            disabled={busy}
                            title={`Preview closing through ${p.period_end}`}
                            className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
                          >
                            Preview close
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* Reopening an older month takes every later one with it — a full-width
                        banner under the row, with real buttons, so the choice reads as one. */}
                    {isClosed && confirmReopen === p.id && (() => {
                      const later = laterClosed(p.id)
                      return (
                        <tr className="border-b bg-warning/10">
                          <td colSpan={4} className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <p className="text-sm text-warning flex items-start gap-1.5">
                                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                                <span>
                                  Reopening {p.label ?? `${p.period_start} → ${p.period_end}`} also reopens the {later.length} later {later.length === 1 ? 'period' : 'periods'}
                                  {' '}({later[later.length - 1]?.label ?? later[later.length - 1]?.period_start} → {later[0]?.label ?? later[0]?.period_end}). Each one&rsquo;s allocation is reversed; close them again when you&rsquo;re done.
                                </span>
                              </p>
                              <span className="flex items-center gap-2 shrink-0">
                                <Button size="sm" onClick={() => reopen(p.id)} disabled={busy}>
                                  {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}<Unlock className="h-3.5 w-3.5 mr-1" />Reopen all {later.length + 1}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setConfirmReopen(null)} disabled={busy}>Cancel</Button>
                              </span>
                            </div>
                          </td>
                        </tr>
                      )
                    })()}

                    {isClosed && open && (
                      <tr className="border-b last:border-b-0 bg-muted/10">
                        <td colSpan={4} className="px-3 py-2.5">
                          {/* Wide detail scrolls inside this panel instead of widening the table. */}
                          <div className="min-w-0 max-w-full overflow-x-auto">
                          {p.close_review && (
                            <div className="mb-3 rounded border bg-background overflow-hidden">
                              <div className="px-3 py-2 border-b bg-muted/30">
                                <p className="text-xs font-medium">Close review approved {p.close_review.approved_at ? new Date(p.close_review.approved_at).toLocaleString() : ''}</p>
                                {p.close_review.attestation && <p className="text-[11px] text-muted-foreground mt-0.5">{p.close_review.attestation}</p>}
                              </div>
                              <div className="divide-y">
                                {[...p.close_review.close_review_checks].sort((a, b) => a.sort_order - b.sort_order).map(check => (
                                  <div key={check.check_key} className="px-3 py-2 flex items-start justify-between gap-4">
                                    <div><p className="text-xs font-medium">{check.label}</p><p className="text-[11px] text-muted-foreground">{check.detail}</p></div>
                                    <span className={`shrink-0 text-[10px] uppercase tracking-wide ${check.status === 'passed' ? 'text-success' : check.status === 'blocked' ? 'text-destructive' : 'text-warning'}`}>{check.status.replace('_', ' ')}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {entries === undefined || entries === 'loading' ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading transactions…</div>
                          ) : entries.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No allocations in this period: nothing was allocated when entries were posted, and the close posted none.</p>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-[11px] text-muted-foreground">
                                Partner allocations for this period — made when each entry was posted, and any the close itself posted.
                              </p>
                              {entries.map(en => (
                                <div key={en.id} className="rounded border bg-background overflow-hidden">
                                  <div className="flex items-center justify-between px-2.5 py-1.5 border-b bg-muted/30">
                                    <span className="text-xs font-medium">
                                      {en.memo ?? en.sourceType ?? 'Transaction'}
                                      <span className="ml-2 font-normal text-muted-foreground">{en.allocatedOn === 'posting' ? 'allocated when posted' : 'posted by the close'}</span>
                                    </span>
                                    <span className="text-[11px] text-muted-foreground tabular-nums">{en.entryDate}</span>
                                  </div>
                                  <table className="w-full text-xs">
                                    <tbody>
                                      {en.lines.map((l, i) => (
                                        <tr key={i} className="border-t first:border-t-0">
                                          <td className="px-2.5 py-1 text-muted-foreground whitespace-nowrap">{[l.accountCode, l.accountName].filter(Boolean).join(' ')}</td>
                                          <td className="px-2.5 py-1">{l.lpName ?? ''}</td>
                                          <td className="px-2.5 py-1 text-right tabular-nums">{fmt(l.amount)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ))}
                            </div>
                          )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
