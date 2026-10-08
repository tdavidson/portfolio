'use client'

import { ImportReviewPanel } from '@/components/accounting/import-review'
import type { ImportReview } from '@/lib/accounting/import-review'

import { useEffect, useState, useCallback } from 'react'
import { Loader2, Check, AlertTriangle, Upload, Sparkles, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { EntryModal } from '../entry-modal'
import { EmptyState } from '@/components/ui/empty-state'
import { InvestmentMatchQueue } from './investment-matches'
import { bankActionMessages } from '@/lib/accounting/release-notice'

interface DuplicateCandidate { id: string; date: string; amount: number; memo: string; status: string; claimed: boolean }
interface Txn { import_differences?: import('@/lib/accounting/import-review').ImportDifference[]; duplicate_review?: boolean; quickbooks_linked?: boolean; review_kind?: 'quickbooks' | 'investment' | null; investment_linked?: boolean; duplicate_candidates?: DuplicateCandidate[]; id: string; txn_date: string; amount: number; description: string; counterparty: string | null; status: string; suggested_account_code: string | null; journal_entry_id: string | null; entry_account_code: string | null; entry_account_name: string | null; entry_is_split: boolean; settled_lp_entity_id: string | null; settled_lp_name: string | null }
interface Rec { bankEndingBalance: number; ledgerCashBalance: number; difference: number; matchedCount: number; unmatchedCount: number; unmatchedTotal: number; tiesOut: boolean }

const actionBtn = 'text-xs border border-input rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors'

export function BankView() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [csv, setCsv] = useState('')
  const [txns, setTxns] = useState<Txn[]>([])
  const [rec, setRec] = useState<Rec | null>(null)
  const [acctNames, setAcctNames] = useState<Record<string, string>>({})
  /** Why a match/book action was refused. Shown rather than swallowed. */
  const [matchError, setMatchError] = useState<string | null>(null)
  /** What an action did that is not a problem — a row set aside, transactions released. */
  const [notice, setNotice] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<{ code: string; name: string; is_active?: boolean; lp_entity_id?: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [categorizing, setCategorizing] = useState(false)
  const [importReview, setImportReview] = useState<ImportReview | null>(null)
  const [result, setResult] = useState<{ imported: number; skipped: number; matched?: number; needsReview?: number; errors: string[] } | null>(null)
  const [editing, setEditing] = useState<{ txnId: string; entryId: string; readOnly?: boolean } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [duplicateSelection, setDuplicateSelection] = useState<Record<string, string>>({})
  const [resolvingDuplicate, setResolvingDuplicate] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [sortBy, setSortBy] = useState('date-desc')
  const lf = useLedgerFetch()

  const load = useCallback(() => {
    setLoading(true)
    return Promise.all([
      lf('/api/accounting/bank').then(async r => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error ?? 'Could not load bank transactions.')
        return data
      }),
      lf('/api/accounting/bank/reconcile').then(r => (r.ok ? r.json() : null)),
      lf('/api/accounting/chart').then(r => (r.ok ? r.json() : [])),
    ]).then(([t, r, ch]) => {
      setTxns(Array.isArray(t) ? t : [])
      setSelected(new Set())
      setRec(r)
      const chart = (Array.isArray(ch) ? ch : []).map((a: any) => ({ code: a.code, name: a.name, is_active: a.is_active, lp_entity_id: a.lp_entity_id }))
      setAccounts(chart)
      setAcctNames(Object.fromEntries(chart.map(a => [a.code, a.name])))
    }).catch(e => setMatchError(e.message)).finally(() => setLoading(false))
  }, [lf])

  useEffect(() => { load() }, [load])

  const [matching, setMatching] = useState(false)
  const [matchMsg, setMatchMsg] = useState<string | null>(null)

  /**
   * Settle drafted rows against DECLARED calls and distributions. Runs automatically after an
   * import; this button re-runs it, which matters after declaring something new.
   */
  const autoMatch = useCallback(async (silent = false) => {
    if (!silent) { setMatching(true); setMatchMsg(null) }
    const res = await lf('/api/accounting/bank/auto-match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    const d = await res.json().catch(() => ({}))
    if (!silent) {
      setMatching(false)
      setMatchMsg(res.ok
        ? `Matched ${d.matched?.length ?? 0}.` +
          (d.ambiguous?.length ? ` ${d.ambiguous.length} could be more than one partner — pick below.` : '') +
          (d.unmatched ? ` ${d.unmatched} had no declared call or distribution to settle.` : '')
        : (d.error ?? 'Auto-match failed'))
    }
    load()
  }, [lf, load])

  async function categorize() {
    setCategorizing(true)
    await lf('/api/accounting/bank/categorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    setCategorizing(false)
    load()
  }

  async function match(id: string, mode: 'allocate' | 'link' | 'distribute', entryId?: string, lpEntityId?: string) {
    setMatchError(null)
    const res = await lf('/api/accounting/bank/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, mode, entryId, lpEntityId }) })
    // These can legitimately refuse — a distribution against partners with no capital balance,
    // a closed period, an entry already claimed. The result was being discarded, so a refusal
    // looked exactly like a success that changed nothing.
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setMatchError(body.error || 'That could not be booked.')
      return
    }
    load()
  }

  async function doImport() {
    setImporting(true); setResult(null)
    const res = await lf('/api/accounting/bank/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv, reviewToken: importReview?.token }) })
    const data = await res.json()
    setImportReview(data.importReview ?? null)
    // Settle anything that pays a declared call or distribution before the AI sees it — an
    // obligation is a fact, and guessing an expense account for it would only be worse.
    if (res.ok) { setResult(data); setCsv(''); if (!data.importReview?.differences?.length) await autoMatch(true); else load() }
    else setResult({ imported: 0, skipped: 0, errors: [data.error ?? 'Import failed'] })
    setImporting(false)
  }

  async function resolveDuplicate(id: string, action: 'link' | 'separate') {
    setResolvingDuplicate(id); setMatchError(null)
    try {
      const res = await lf('/api/accounting/bank/duplicates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, entryId: duplicateSelection[id] }),
      })
      const data = await res.json()
      if (!res.ok) { setMatchError(data.error ?? 'Could not resolve the match.'); return }
      await load()
    } catch (e) { setMatchError(e instanceof Error ? e.message : 'Could not resolve the match.') }
    finally { setResolvingDuplicate(null) }
  }

  // Say what happened: a refusal (an investment's payment can't be unposted here), a note (an
  // investment's entry left as it is on Ignore), or what posting a reversal draft released.
  async function reportBankAction(res: Response) {
    const body = await res.json().catch(() => ({}))
    const said = bankActionMessages(res.ok, body)
    setMatchError(said.error)
    setNotice(said.notice)
  }

  async function act(id: string, action: 'post' | 'ignore' | 'unpost' | 'restore') {
    setMatchError(null); setNotice(null)
    const res = await lf('/api/accounting/bank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id }) })
    await reportBankAction(res)
    load()
  }

  const visibleTxns = txns
    .filter(t => (statusFilter ? t.status === statusFilter : true))
    .filter(t => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return (t.description ?? '').toLowerCase().includes(q) || (t.counterparty ?? '').toLowerCase().includes(q)
    })
    .slice()
    .sort((a, b) => {
      switch (sortBy) {
        case 'date-asc': return a.txn_date.localeCompare(b.txn_date)
        case 'amount-desc': return Math.abs(b.amount) - Math.abs(a.amount)
        case 'amount-asc': return Math.abs(a.amount) - Math.abs(b.amount)
        default: return b.txn_date.localeCompare(a.txn_date)
      }
    })
  const draftedIds = visibleTxns.filter(t => t.status === 'drafted').map(t => t.id)
  const allDraftedSelected = draftedIds.length > 0 && draftedIds.every(id => selected.has(id))
  const selectedCount = draftedIds.filter(id => selected.has(id)).length
  function toggleRow(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleAll() {
    setSelected(allDraftedSelected ? new Set<string>() : new Set(draftedIds))
  }
  async function bulkPost() {
    if (selectedCount === 0) return
    setMatchError(null); setNotice(null)
    const res = await lf('/api/accounting/bank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'postMany', ids: draftedIds.filter(id => selected.has(id)) }) })
    await reportBankAction(res)
    load()
  }

  async function setAccount(id: string, code: string) {
    setMatchError(null)
    // Optimistic — and it must patch the ENTRY columns, not just the hint: the select reads
    // `entry_account_code` first, so patching `suggested_account_code` alone left the dropdown
    // showing the old account until the next reload even though the save had gone through.
    const name = accounts.find(a => a.code === code)?.name ?? null
    setTxns(prev => prev.map(t => (t.id === id ? { ...t, suggested_account_code: code, entry_account_code: code, entry_account_name: name } : t)))
    const res = await lf('/api/accounting/bank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setAccount', id, accountCode: code }) })
    if (!res.ok) {
      // SAY why. Re-pointing is refused when the draft has a custom allocation (more than one
      // non-cash line), and the only signal used to be the selection springing back to what it
      // was — indistinguishable from the click not registering.
      const body = await res.json().catch(() => ({}))
      setMatchError(body.error || 'That account could not be applied.')
      load() // revert the optimistic change
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (/\.xlsx?$/i.test(file.name)) {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      setCsv(XLSX.utils.sheet_to_csv(sheet))
    } else {
      setCsv(await file.text())
    }
    e.target.value = ''
  }

  // Without a chart there is no 1000 Cash to post an import against; the import would fail on
  // submit, so say so up front and point at Admin.


  return (
    <div className="space-y-6">
      {matchError && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span className="flex-1">{matchError}</span>
          <button onClick={() => setMatchError(null)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">×</button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="hover:text-foreground" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Import */}
      <div className="border rounded-card p-4 space-y-2">
        <p className="text-sm font-medium">Import transactions</p>
        <p className="text-xs text-muted-foreground">Paste a CSV/TSV export from your bank, Ramp, or QuickBooks. Columns matched automatically (date, description, amount, or debit/credit). Clear matches link to existing QuickBooks entries. Possible matches with the same cash amount within seven days are held for review; new transactions become drafts.</p>
        <textarea value={csv} onChange={e => { setCsv(e.target.value); setImportReview(null) }} rows={5} placeholder="Date,Description,Amount&#10;2026-06-01,Capital call Fund II,5000000&#10;2026-06-15,Audit fee,-12000" className="w-full border border-input rounded p-2 text-sm font-mono bg-transparent" />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={doImport} disabled={importing || csv.trim().length < 5}>{importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}{importReview?.differences.length ? 'Import as drafts after review' : 'Import'}</Button>
          <label className="text-xs text-muted-foreground cursor-pointer border rounded px-2 py-1.5 hover:bg-accent">
            Upload CSV/XLS
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" onChange={onFile} className="hidden" />
          </label>
          {result && (
            <span className="text-sm text-muted-foreground">
              {result.imported} imported{result.matched ? `, ${result.matched} matched to QuickBooks (no new entries)` : ''}{result.needsReview ? `, ${result.needsReview} held for duplicate review` : ''}{result.skipped ? `, ${result.skipped} duplicate(s) skipped` : ''}{result.errors.length ? `, ${result.errors.length} error(s)` : ''}.
            </span>
          )}
        </div>
        <ImportReviewPanel review={importReview} />
        {result?.errors?.length ? <p className="text-sm text-destructive">{result.errors[0]}</p> : null}
      </div>

      {/* Reconciliation */}
      {rec && (
        <div className={`rounded-card border p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1 ${rec.tiesOut ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'}`}>
          <span className="flex items-center gap-2 font-medium">
            {rec.tiesOut ? <Check className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
            Bank reconciliation
          </span>
          <span className="text-muted-foreground">Ledger cash <span className="tabular-nums text-foreground">{fmt(rec.ledgerCashBalance)}</span></span>
          <span className="text-muted-foreground">Bank ending <span className="tabular-nums text-foreground">{fmt(rec.bankEndingBalance)}</span></span>
          <span className="text-muted-foreground">Difference <span className={`tabular-nums ${rec.difference !== 0 ? 'text-warning' : 'text-foreground'}`}>{fmt(rec.difference)}</span></span>
          {rec.unmatchedCount > 0 && <span className="text-muted-foreground">{rec.unmatchedCount} unmatched ({fmt(rec.unmatchedTotal)})</span>}
        </div>
      )}

      {/* Investment entries whose cash leg is waiting for this page. Matching one also retires
          the bank row's auto-draft, so it reloads the list below. */}
      <InvestmentMatchQueue onChanged={load} />

      {/* Transactions */}
      {txns.some(t => t.status === 'drafted') && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Settlement first, guessing second: a wire that pays a declared call or
              distribution is a fact, so it is matched before the categorizer is allowed an
              opinion about it. Runs on import; this re-runs it after a new declaration. */}
          <Button size="sm" variant="outline" onClick={() => autoMatch()} disabled={matching}>
            {matching && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Match declared calls &amp; distributions
          </Button>
          <Button size="sm" variant="outline" onClick={categorize} disabled={categorizing}>
            {categorizing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            Categorize with AI
          </Button>
          <span className="text-xs text-muted-foreground">Re-classifies drafted rows against your chart of accounts.</span>
          {selectedCount > 0 && <Button size="sm" onClick={bulkPost}>Post {selectedCount} selected</Button>}
          {matchMsg && <span className="text-xs text-muted-foreground">{matchMsg}</span>}
        </div>
      )}
      {loading && txns.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : txns.length === 0 ? (
        <EmptyState>No transactions yet. Import a feed above.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search description or counterparty" value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-9 w-64" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-9 px-3 rounded-md border border-input bg-background text-sm">
              <option value="">All statuses</option>
              <option value="unmatched">Needs duplicate review</option>
              <option value="drafted">Not posted</option>
              <option value="reconciled">Posted</option>
              <option value="ignored">Ignored</option>
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="h-9 px-3 rounded-md border border-input bg-background text-sm">
              <option value="date-desc">Date (newest)</option>
              <option value="date-asc">Date (oldest)</option>
              <option value="amount-desc">Amount (largest)</option>
              <option value="amount-asc">Amount (smallest)</option>
            </select>
            <span className="text-xs text-muted-foreground">{visibleTxns.length} of {txns.length}</span>
          </div>
          {visibleTxns.length === 0 ? (
            <EmptyState>No transactions match your filters.</EmptyState>
          ) : (
          <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">Date</th>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-right px-3 py-2 font-medium">Amount</th>
                <th className="text-left px-3 py-2 font-medium">Suggested</th>
                <th className="px-3 py-2 font-medium" />
                <th className="px-2 py-2 w-8 text-center">{draftedIds.length > 0 && <input type="checkbox" aria-label="Select all drafted" checked={allDraftedSelected} onChange={toggleAll} />}</th>
              </tr>
            </thead>
            <tbody>
              {visibleTxns.map(t => (
                <tr key={t.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-3 py-2 tabular-nums text-xs">{t.txn_date}</td>
                  <td className="px-3 py-2">{t.description}{!!t.import_differences?.length && <details className="text-sm text-warning mt-1"><summary className="cursor-pointer">Import comparison: {t.import_differences.length} items to review</summary>{t.import_differences.map((d, i) => <p key={i} className="mt-1 max-w-md">{d.name}: {d.message}</p>)}</details>}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${t.amount < 0 ? 'text-muted-foreground' : ''}`}>{fmt(t.amount)}</td>
                  <td className="px-3 py-2 text-xs">
                    {/* What the ENTRY posts to, not the stored hint — editing an entry in the
                        journal modal never updates `suggested_account_code`, so showing that
                        column left a re-pointed entry displaying its old account. */}
                    {t.duplicate_review ? (
                      <span className="text-warning">{t.review_kind === 'investment' ? 'Possible investment payment — choose the entry' : 'Possible QuickBooks duplicate — no new entry'}</span>
                    ) : t.status === 'ignored' ? (
                      <span className="text-muted-foreground">Ignored</span>
                    ) : t.entry_is_split ? (
                      <span className="text-muted-foreground" title="This entry splits across several accounts, so it can't be re-pointed from here — open it with Edit.">
                        Split across several accounts
                      </span>
                    ) : t.status === 'drafted' ? (
                      <span className="inline-flex items-center">
                        <select
                          value={t.entry_account_code ?? t.suggested_account_code ?? ''}
                          onChange={e => {
                            const picked = accounts.find(a => a.code === e.target.value)
                            // Naming a partner's capital account IS naming the partner, so route it
                            // through the settlement path rather than a plain re-point: it clears a
                            // declared call or distribution when one is open, and books capital
                            // directly when there isn't one. A separate "pick partner" dropdown
                            // asked the same question a second time.
                            if (picked?.lp_entity_id) match(t.id, t.amount > 0 ? 'allocate' : 'distribute', undefined, picked.lp_entity_id)
                            else setAccount(t.id, e.target.value)
                          }}
                          className="border border-input rounded bg-transparent px-1.5 py-1 text-xs max-w-[220px] hover:bg-accent/50"
                        >
                          {!(t.entry_account_code ?? t.suggested_account_code) && <option value="">—</option>}
                          {/* Hidden accounts drop out of the list, except the one this row already
                              uses — otherwise the select would render blank and look broken. */}
                          {accounts.filter(a => a.is_active !== false || a.code === (t.entry_account_code ?? t.suggested_account_code))
                            .map(a => <option key={a.code} value={a.code}>{a.name} ({a.code})</option>)}
                        </select>
                        {/* Only where the account can't say it: a settled row posts to 1300 / 2300,
                            which names an obligation, not a person. */}
                        {t.settled_lp_name && (
                          <span className="ml-1.5 shrink-0 text-muted-foreground" title="Settles this partner's declared call or distribution">
                            · {t.settled_lp_name}
                          </span>
                        )}
                      </span>
                    ) : (t.entry_account_name ?? t.suggested_account_code) ? (
                      <span>
                        <span className="text-foreground">{t.entry_account_name ?? acctNames[t.suggested_account_code!] ?? t.suggested_account_code}</span>
                        {(t.entry_account_code ?? t.suggested_account_code) && (
                          <span className="ml-1.5 text-muted-foreground/70 font-mono">{t.entry_account_code ?? t.suggested_account_code}</span>
                        )}
                        {t.settled_lp_name && <span className="ml-1.5 text-muted-foreground">· {t.settled_lp_name}</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {t.duplicate_review && (
                      <div className="flex flex-col gap-2 items-end">
                        <select aria-label={`Suggested match for ${t.description}`} value={duplicateSelection[t.id] ?? ''}
                          disabled={resolvingDuplicate === t.id} className="max-w-[320px] border rounded px-2 py-1 text-xs bg-background"
                          onChange={e => setDuplicateSelection(s => ({ ...s, [t.id]: e.target.value }))}>
                          <option value="">Choose an existing entry</option>
                          {(t.duplicate_candidates ?? []).map(c => <option key={c.id} value={c.id} disabled={c.claimed || (t.review_kind !== 'investment' && c.status !== 'posted')}>
                            {c.date} · {c.memo || (t.review_kind === 'investment' ? 'Investment entry' : 'QuickBooks entry')}{c.claimed ? ' (already linked)' : c.status === 'draft' && t.review_kind !== 'investment' ? ' (post in Journal first)' : ''}
                          </option>)}
                        </select>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" disabled={!!resolvingDuplicate || !duplicateSelection[t.id]} onClick={() => resolveDuplicate(t.id, 'link')}>Match existing</Button>
                          <Button size="sm" variant="outline" disabled={!!resolvingDuplicate} onClick={() => resolveDuplicate(t.id, 'separate')}>Separate transaction</Button>
                        </div>
                        <span className="text-xs text-muted-foreground">Separate transaction creates a new draft.</span>
                      </div>
                    )}
                    {t.status === 'drafted' && (
                      <span className="flex items-center gap-1.5 justify-end">
                        {t.journal_entry_id && <button onClick={() => setEditing({ txnId: t.id, entryId: t.journal_entry_id! })} className={actionBtn}>Edit</button>}
                        <button onClick={() => act(t.id, 'post')} className={actionBtn}>Post</button>
                        <button onClick={() => act(t.id, 'ignore')} className={actionBtn}>Ignore</button>
                      </span>
                    )}
                    {t.status === 'reconciled' && (
                      <span className="flex items-center gap-2 justify-end">
                        {t.quickbooks_linked && <span className="text-xs text-muted-foreground">Matched to QuickBooks</span>}
                        {t.investment_linked && <span className="text-xs text-muted-foreground">Matched to an investment</span>}
                        {t.journal_entry_id
                          ? <button onClick={() => setEditing({ txnId: t.id, entryId: t.journal_entry_id!, readOnly: true })} title="See the journal entry that was booked — unpost from there to edit it" className={actionBtn}>View / edit</button>
                          : <button onClick={() => act(t.id, 'unpost')} title="Revert to draft" className={actionBtn}>Unpost</button>}
                      </span>
                    )}
                    {t.status === 'ignored' && (
                      <span className="flex items-center gap-1.5 justify-end">
                        <span className="text-sm text-muted-foreground">Ignored</span>
                        <button onClick={() => act(t.id, 'restore')} title="Restore to draft so you can edit it" className={actionBtn}>Restore</button>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-center">{t.status === 'drafted' && <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleRow(t.id)} aria-label="Select transaction" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          )}
        </>
      )}

      {editing && <EntryModal txnId={editing.txnId} entryId={editing.entryId} readOnly={editing.readOnly} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  )
}
