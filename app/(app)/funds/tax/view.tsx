'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Download, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle, useVehicleBase } from '@/components/accounting-vehicle'
import { useCanRead, useCanWrite } from '@/components/access-context'
import { EmptyState } from '@/components/ui/empty-state'
import { EntryModal } from '../entry-modal'
import { TaxPackageLink } from '@/components/accounting/download-menu'
import { TaxFormRecord } from '@/components/accounting/tax-form-record'

// The tax page: the year's book-to-tax work, in the order a preparer does it.
//
// Everything here already existed as routes and had no page. Each section reads one of them and
// says plainly when the caller's access does not reach it — the K-1 routes require GP economics,
// because a K-1 package contains the carry (lib/tax/access.ts) — rather than rendering an error.

interface Fetched<T> { ok: boolean; status: number; data: T | null }

interface TaxYearState {
  taxYear: number; closed: boolean; closedAt: string | null; reopenedAt: string | null; reopenedReason: string | null
  packages: { id: string; version: number; status: string }[]
  outstandingK1s: unknown[]; amendedK1s: unknown[]
}
interface Proposal { kind: string; amount: number; permanent: boolean; label: string; rationale: string }
interface TaxRun { taxYear: number; proposals: Proposal[]; entryIds: string[]; skipped: { reason?: string; kind?: string }[]; voided: number; missingAccounts: string[] }
interface JournalEntryRow { id: string; entry_date: string; memo: string | null; source_type: string | null; status: string; reference?: string | null; journal_postings: { id: string; account_code: string | null; account_name: string | null; amount: number }[] }
interface K1Package { id: string; vehicle_id: string; tax_year: number; version: number; status: string; finalized_at: string | null; warnings: { kind: string; detail: string }[] | null }
interface TaxFormsReport { asOf: string; blocked: number; nameMismatches: number; partners: { lpEntityId: string; name: string; investorId: string | null; status: { blocker: string | null; standing?: string }; nameMatch: string }[] }
interface ReceivedReport { taxYear: number; received: number; outstanding: { companyName?: string; name?: string }[]; amended: { companyName?: string; name?: string }[]; blocker: string | null }
interface Worklist { summary: string[]; states: { state: string; partners: number; nonresident: boolean }[]; foreign: unknown[]; unknown: unknown[] }
interface RealizedLot { company: string; acquired: string | null; sold: string; units: number; proceeds: number; basis: number; gain: number; term: 'short' | 'long' | 'undetermined' }
interface VendorPaymentRow { vendorId: string; name: string; is1099Eligible: boolean; tinOnFile: boolean; paid: number; entries: number; needsW9: boolean; reportable: boolean }
interface VendorPayments { rows: VendorPaymentRow[]; totalPaid: number }
interface RealizedGains { method: string; disposals: { company: string; sold: string; units: number; proceeds: number; basis: number; gain: number; unmatchedUnits: number; lots: RealizedLot[] }[]; totals: { proceeds: number; basis: number; gain: number; shortTerm: number; longTerm: number; undetermined: number } }

const thisYear = new Date().getFullYear()

export function TaxView() {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const { vehicleId, group } = useVehicle()
  const base = useVehicleBase()
  const canReadCarry = useCanRead('gp_economics')
  const canReadPartners = useCanRead('lp_capital')
  const canSeeK1 = canReadCarry && canReadPartners
  const canWrite = useCanWrite('accounting', 'tax_reporting')

  const [year, setYear] = useState(thisYear - 1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [state, setState] = useState<Fetched<TaxYearState> | null>(null)
  const [run, setRun] = useState<Fetched<TaxRun> | null>(null)
  const [taxEntries, setTaxEntries] = useState<JournalEntryRow[]>([])
  const [adjusting, setAdjusting] = useState<JournalEntryRow[]>([])
  const [packages, setPackages] = useState<Fetched<K1Package[]> | null>(null)
  const [forms, setForms] = useState<Fetched<TaxFormsReport> | null>(null)
  const [received, setReceived] = useState<Fetched<ReceivedReport> | null>(null)
  const [worklist, setWorklist] = useState<Fetched<Worklist> | null>(null)
  const [gains, setGains] = useState<Fetched<RealizedGains> | null>(null)
  const [payments, setPayments] = useState<Fetched<VendorPayments> | null>(null)
  const [viewing, setViewing] = useState<{ id: string; book: 'actual' | 'tax' } | null>(null)

  const get = useCallback(async <T,>(url: string): Promise<Fetched<T>> => {
    try {
      const r = await lf(url)
      const data = await r.json().catch(() => null)
      return { ok: r.ok, status: r.status, data: r.ok ? (data as T) : null }
    } catch { return { ok: false, status: 0, data: null } }
  }, [lf])

  const load = useCallback(async () => {
    setLoading(true)
    const start = `${year}-01-01`, end = `${year}-12-31`
    const [s, r, te, aj, f, rk, pk, rg, vp] = await Promise.all([
      get<TaxYearState>(`/api/accounting/tax-year?taxYear=${year}`),
      get<TaxRun>(`/api/accounting/tax-adjustments?taxYear=${year}`),
      get<{ entries: JournalEntryRow[] }>(`/api/accounting/journal?preset=custom&start=${start}&end=${end}&book=tax&limit=200`),
      get<{ entries: JournalEntryRow[] }>(`/api/accounting/journal?preset=custom&start=${start}&end=${end}&adjusting=1&limit=200`),
      get<TaxFormsReport>(`/api/accounting/tax-forms?asOf=${end}`),
      get<ReceivedReport>(`/api/accounting/received-k1s?taxYear=${year}`),
      canSeeK1 ? get<{ packages: K1Package[] }>('/api/accounting/k1-packages') : Promise.resolve<Fetched<{ packages: K1Package[] }>>({ ok: false, status: 403, data: null }),
      get<RealizedGains>(`/api/accounting/realized-gains?year=${year}`),
      get<VendorPayments>(`/api/accounting/vendor-payments?year=${year}`),
    ])
    setState(s); setRun(r); setForms(f); setReceived(rk); setGains(rg); setPayments(vp)
    setTaxEntries(te.data?.entries ?? [])
    setAdjusting(aj.data?.entries ?? [])
    const mine = (pk.data?.packages ?? []).filter(p => p.tax_year === year && (!vehicleId || p.vehicle_id === vehicleId))
    setPackages({ ok: pk.ok, status: pk.status, data: pk.ok ? mine : null })
    const latest = mine.find(p => p.status !== 'superseded') ?? null
    setWorklist(latest ? await get<Worklist>(`/api/accounting/state-worklist?packageId=${latest.id}`) : null)
    setLoading(false)
  }, [get, year, vehicleId, canSeeK1])
  useEffect(() => { load() }, [load])

  const post = async (label: string, url: string, body: object): Promise<boolean> => {
    setBusy(label); setNotice(null)
    const r = await lf(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    setBusy(null)
    if (!r.ok) { setNotice(d?.error ?? `${label} failed (${r.status})`); return false }
    return true
  }

  const postAdjustments = async () => {
    if (!window.confirm(`Post the ${year} book-to-tax adjustments to the tax book? A prior run for ${year} is voided and rewritten.`)) return
    if (await post('Post adjustments', '/api/accounting/tax-adjustments', { taxYear: year })) { setNotice(`Posted the ${year} adjustments to the tax book.`); load() }
  }
  const closeYear = async () => {
    if (!window.confirm(`Close tax year ${year}? The tax book for the year locks; reopen it to change anything.`)) return
    if (await post('Close year', '/api/accounting/tax-year', { taxYear: year, action: 'close' })) { setNotice(`Tax year ${year} closed.`); load() }
  }
  const reopenYear = async () => {
    const reason = window.prompt(`Why reopen tax year ${year}? (recorded)`) ?? ''
    if (!reason.trim()) return
    if (await post('Reopen year', '/api/accounting/tax-year', { taxYear: year, action: 'reopen', reason })) { setNotice(`Tax year ${year} reopened.`); load() }
  }
  const k1Action = async (action: 'generate' | 'finalize' | 'amend', packageId?: string) => {
    const ok = await post(`K-1 ${action}`, '/api/accounting/k1-packages', action === 'finalize' ? { action, packageId } : { action, taxYear: year })
    if (ok) { setNotice(`K-1 package ${action === 'generate' ? 'generated' : action === 'finalize' ? 'finalised' : 'amended'}.`); load() }
  }

  const denied = (f: Fetched<unknown> | null, what: string) =>
    f && !f.ok ? <p className="text-sm text-muted-foreground">{f.status === 403 ? `${what} needs access your account does not hold.` : f.status === 404 || f.status === 400 ? `${what}: not available for this vehicle and year.` : `${what} could not be loaded (${f.status}).`}</p> : null

  const entryList = (rows: JournalEntryRow[], book: 'actual' | 'tax', empty: string) => rows.length === 0
    ? <p className="text-sm text-muted-foreground">{empty}</p>
    : (
      <div className="divide-y rounded-md border font-mono text-xs">
        {rows.map(e => (
          <div key={e.id} onClick={() => setViewing({ id: e.id, book })} className="cursor-pointer px-3 py-2 hover:bg-muted/30">
            <div><span className="text-muted-foreground">{e.entry_date}</span> {e.reference && <span className="text-muted-foreground">#{e.reference} </span>}&quot;{(e.memo || e.source_type || 'Entry').replace(/"/g, "'")}&quot;</div>
            {e.journal_postings.map(p => (
              <div key={p.id} className="flex items-baseline gap-3 pl-4">
                <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{p.account_code}</span> {p.account_name}</span>
                <span className="w-24 shrink-0 text-right tabular-nums">{Number(p.amount) > 0 ? Number(p.amount).toFixed(2) : ''}</span>
                <span className="w-24 shrink-0 text-right tabular-nums">{Number(p.amount) < 0 ? (-Number(p.amount)).toFixed(2) : ''}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    )

  const card = 'rounded-card border p-4 space-y-2'
  const h = 'text-sm font-semibold'
  const latestPkg = packages?.data?.find(p => p.status !== 'superseded') ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))} aria-label="Tax year" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          {Array.from({ length: 8 }, (_, i) => thisYear - i).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {notice && <span className="text-sm text-muted-foreground">{notice}</span>}
        <div className="ml-auto">
          {base && <Link href={`${base}/statements`} className="text-sm text-muted-foreground hover:underline">Statements on a tax basis →</Link>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 1. The year */}
        <section className={card}>
          <h2 className={h}>Tax year {year}</h2>
          {denied(state, 'The year’s status') ?? (state?.data && (
            <>
              <p className="text-sm">
                {state.data.closed
                  ? <>Closed{state.data.closedAt ? ` on ${state.data.closedAt.slice(0, 10)}` : ''}. The tax book for {year} is locked.</>
                  : <>Open. {state.data.reopenedAt ? `Reopened ${state.data.reopenedAt.slice(0, 10)}${state.data.reopenedReason ? ` — ${state.data.reopenedReason}` : ''}. ` : ''}Close it once the adjustments are posted and the K-1s are final.</>}
              </p>
              {state.data.outstandingK1s.length > 0 && <p className="text-sm text-warning">{state.data.outstandingK1s.length} underlying fund{state.data.outstandingK1s.length === 1 ? '' : 's'} still owe this vehicle a K-1 for {year}.</p>}
              {canWrite && (
                <div className="flex gap-2">
                  {state.data.closed
                    ? <Button size="sm" variant="outline" disabled={!!busy} onClick={reopenYear}>Reopen year…</Button>
                    : <Button size="sm" variant="outline" disabled={!!busy} onClick={closeYear}>Close tax year</Button>}
                </div>
              )}
            </>
          ))}
          <div className="border-t pt-2 -mx-2 -mb-1.5"><TaxPackageLink group={group} /></div>
        </section>

        {/* 2. Book-to-tax adjustments */}
        <section className={card}>
          <h2 className={h}>Book-to-tax adjustments</h2>
          <p className="text-xs text-muted-foreground">Derived from the year’s books: unrealized appreciation, carry accrued on unrealized gains, organizational and syndication costs. Posted to the tax book, never to the ledger.</p>
          {denied(run, 'The adjustments') ?? (run?.data && (
            <>
              {run.data.proposals.length === 0
                ? <p className="text-sm text-muted-foreground">Nothing to adjust for {year}.</p>
                : (
                  <table className="w-full text-sm">
                    <tbody>
                      {run.data.proposals.map(p => (
                        <tr key={p.kind} className="border-t align-top">
                          <td className="py-1.5 pr-2">
                            <div>{p.label}<span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">{p.permanent ? 'permanent' : 'timing'}</span></div>
                            <div className="text-xs text-muted-foreground">{p.rationale}</div>
                          </td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{fmt(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              {run.data.missingAccounts.length > 0 && <p className="text-sm text-warning">The chart is missing {run.data.missingAccounts.join(', ')} — add them under Admin → Chart of accounts first.</p>}
              {run.data.skipped.length > 0 && <p className="text-sm text-warning">{run.data.skipped.length} difference{run.data.skipped.length === 1 ? '' : 's'} could not be built: {run.data.skipped.map(s => s.reason ?? s.kind).join('; ')}</p>}
              {canWrite && run.data.proposals.length > 0 && !state?.data?.closed && (
                <Button size="sm" disabled={!!busy || run.data.missingAccounts.length > 0} onClick={postAdjustments}>
                  {busy === 'Post adjustments' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Post to the tax book
                </Button>
              )}
            </>
          ))}
          <div className="pt-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">In the tax book for {year}</div>
            {entryList(taxEntries, 'tax', 'No tax-book entries yet — nothing has been posted for this year.')}
          </div>
        </section>

        {/* 3. Adjusting entries in the books */}
        <section className={card}>
          <h2 className={h}>Adjusting entries in the books</h2>
          <p className="text-xs text-muted-foreground">Entries flagged adjusting in {year} — the AJE list. Tick “Adjusting entry” on any entry to put it here; it is exported on its own in the tax package.</p>
          {entryList(adjusting, 'actual', 'No adjusting entries flagged for this year.')}
          {base && <Link href={`${base}/journal`} className="text-xs text-muted-foreground hover:underline">Open the journal →</Link>}
        </section>

        {/* 4. K-1 packages */}
        <section className={card}>
          <h2 className={h}>K-1 package</h2>
          {!canSeeK1
            ? <p className="text-sm text-muted-foreground">K-1 packages include the carried-interest allocation, which needs GP economics access.</p>
            : denied(packages, 'K-1 packages') ?? (packages?.data && (
              <>
                {packages.data.length === 0
                  ? <p className="text-sm text-muted-foreground">No package for {year} yet.</p>
                  : (
                    <table className="w-full text-sm">
                      <tbody>
                        {packages.data.map(p => (
                          <tr key={p.id} className="border-t align-top">
                            <td className="py-1.5 pr-2">
                              <div>v{p.version} <span className={`ml-1 rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${p.status === 'final' ? 'bg-success/15 text-success' : p.status === 'draft' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'}`}>{p.status}</span>{p.finalized_at && <span className="ml-2 text-xs text-muted-foreground">finalised {p.finalized_at.slice(0, 10)}</span>}</div>
                              {(p.warnings ?? []).length > 0 && <ul className="mt-1 text-sm text-warning">{(p.warnings ?? []).map((w, i) => <li key={i}>{w.detail}</li>)}</ul>}
                            </td>
                            <td className="py-1.5 text-right whitespace-nowrap">
                              <a href={`/api/accounting/k1-packages/export?packageId=${p.id}`} className="inline-flex items-center gap-1 text-xs hover:underline"><Download className="h-3 w-3" />Workbook</a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    {!latestPkg && <Button size="sm" disabled={!!busy} onClick={() => k1Action('generate')}>Generate package</Button>}
                    {latestPkg?.status === 'draft' && <>
                      <Button size="sm" disabled={!!busy} onClick={() => k1Action('generate')} variant="outline">Regenerate draft</Button>
                      <Button size="sm" disabled={!!busy} onClick={() => k1Action('finalize', latestPkg.id)}>Finalise</Button>
                    </>}
                    {latestPkg?.status === 'final' && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => k1Action('amend')}>Amend (new version)</Button>}
                  </div>
                )}
                {worklist?.data && worklist.data.summary.length > 0 && (
                  <div className="pt-2">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">State worklist</div>
                    <ul className="text-sm">{worklist.data.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
              </>
            ))}
        </section>

        {/* 5. Tax forms */}
        <section className={card}>
          <h2 className={h}>Partner tax forms</h2>
          {denied(forms, 'Tax forms') ?? (forms?.data && (
            <>
              <p className="text-sm">
                {forms.data.blocked === 0 ? 'Every partner has a current form on file.' : <span className="text-warning">{forms.data.blocked} partner{forms.data.blocked === 1 ? '' : 's'} without a valid form — a K-1 cannot be finalised until they are.</span>}
                {forms.data.nameMismatches > 0 && <span className="text-muted-foreground"> {forms.data.nameMismatches} form{forms.data.nameMismatches === 1 ? '' : 's'} carry a name that differs from the partner record.</span>}
              </p>
              {forms.data.blocked > 0 && (
                // Collapsed by default: a fund with a couple of hundred partners and no forms
                // on file yet would otherwise run this card the length of the page.
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium">
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                    Show the {forms.data.blocked} partner{forms.data.blocked === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-2 text-sm space-y-1">
                    {forms.data.partners.filter(p => p.status.blocker).map(p => (
                      <li key={p.lpEntityId}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{p.name}</span>
                          <span className="text-muted-foreground">— {p.status.blocker}</span>
                          {canWrite && <TaxFormRecord lpEntityId={p.lpEntityId} investorId={p.investorId} partnerName={p.name} onSaved={() => { setNotice(`Recorded a tax form for ${p.name}.`); load() }} />}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ))}
        </section>

        {/* 6. Realized gains by lot — Schedule D / 8949 */}
        <section className={`${card} lg:col-span-2`}>
          <h2 className={h}>Realized gains by lot</h2>
          <p className="text-xs text-muted-foreground">Each disposal in {year}, the lots it consumed under the {gains?.data?.method ? gains.data.method.toUpperCase() : 'fund’s'} lot method, and whether each lot was held long enough to be long-term. The Schedule D and Form 8949 input; exported in the tax package.</p>
          {denied(gains, 'Realized gains') ?? (gains?.data && (
            gains.data.disposals.length === 0
              ? <p className="text-sm text-muted-foreground">No disposals in {year}.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">Company</th><th className="py-1 pr-2 font-medium">Acquired</th><th className="py-1 pr-2 font-medium">Sold</th>
                        <th className="py-1 pr-2 text-right font-medium">Units</th><th className="py-1 pr-2 text-right font-medium">Proceeds</th><th className="py-1 pr-2 text-right font-medium">Basis</th><th className="py-1 pr-2 text-right font-medium">Gain / (loss)</th><th className="py-1 font-medium">Term</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gains.data.disposals.flatMap(d => d.lots.map((l, i) => (
                        <tr key={`${d.company}-${d.sold}-${i}`} className="border-t">
                          <td className="py-1 pr-2">{i === 0 ? d.company : ''}{i === 0 && d.unmatchedUnits > 0 && <span className="ml-1 text-sm text-warning">({d.unmatchedUnits} units without a lot)</span>}</td>
                          <td className="py-1 pr-2 tabular-nums">{l.acquired ?? <span className="text-muted-foreground">unknown</span>}</td>
                          <td className="py-1 pr-2 tabular-nums">{l.sold}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{l.units}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{fmt(l.proceeds)}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{fmt(l.basis)}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{fmt(l.gain)}</td>
                          <td className="py-1">{l.term === 'long' ? 'Long-term' : l.term === 'short' ? 'Short-term' : <span className="text-muted-foreground">Undetermined</span>}</td>
                        </tr>
                      )))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-semibold"><td className="py-1 pr-2" colSpan={4}>Total</td><td className="py-1 pr-2 text-right tabular-nums">{fmt(gains.data.totals.proceeds)}</td><td className="py-1 pr-2 text-right tabular-nums">{fmt(gains.data.totals.basis)}</td><td className="py-1 pr-2 text-right tabular-nums">{fmt(gains.data.totals.gain)}</td><td /></tr>
                      <tr className="text-muted-foreground"><td className="py-1 pr-2" colSpan={6}>of which short-term / long-term{gains.data.totals.undetermined !== 0 ? ' / undetermined' : ''}</td><td className="py-1 pr-2 text-right tabular-nums">{fmt(gains.data.totals.shortTerm)} / {fmt(gains.data.totals.longTerm)}{gains.data.totals.undetermined !== 0 ? ` / ${fmt(gains.data.totals.undetermined)}` : ''}</td><td /></tr>
                    </tfoot>
                  </table>
                </div>
              )
          ))}
        </section>

        {/* 7. 1099 worksheet — cash paid per vendor */}
        <section className={card}>
          <h2 className={h}>1099 worksheet</h2>
          <p className="text-xs text-muted-foreground">Cash paid to each vendor in {year}, from posted entries that name one. Reportable at $600 and above for a 1099-eligible vendor; a reportable vendor without a TIN on file needs a W-9. Exported in the tax package.</p>
          {denied(payments, 'Vendor payments') ?? (payments?.data && (
            payments.data.rows.length === 0
              ? <p className="text-sm text-muted-foreground">No payments to a vendor in {year}. Pick a vendor on an entry, or import a bank file or QuickBooks journal with payees.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">Vendor</th><th className="py-1 pr-2 text-right font-medium">Paid</th><th className="py-1 pr-2 text-right font-medium">Entries</th><th className="py-1 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.data.rows.map(v => (
                        <tr key={v.vendorId} className="border-t">
                          <td className="py-1 pr-2">{v.name}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{fmt(v.paid)}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{v.entries}</td>
                          <td className="py-1">
                            {v.needsW9
                              ? <span className="text-sm text-warning">Reportable — needs W-9</span>
                              : v.reportable ? 'Reportable' : v.is1099Eligible ? <span className="text-muted-foreground">Below threshold</span> : <span className="text-muted-foreground">Not 1099-eligible</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-semibold"><td className="py-1 pr-2">Total</td><td className="py-1 pr-2 text-right tabular-nums">{fmt(payments.data.totalPaid)}</td><td colSpan={2} /></tr>
                    </tfoot>
                  </table>
                </div>
              )
          ))}
        </section>

        {/* 8. Received K-1s */}
        <section className={card}>
          <h2 className={h}>K-1s owed to this vehicle</h2>
          <p className="text-xs text-muted-foreground">Underlying funds this vehicle holds send their own K-1s; ours cannot be final until they arrive.</p>
          {denied(received, 'Received K-1s') ?? (received?.data && (
            <>
              <p className="text-sm">{received.data.received} received{received.data.outstanding.length > 0 ? <span className="text-warning">, {received.data.outstanding.length} outstanding</span> : ''}{received.data.amended.length > 0 ? <span className="text-warning">, {received.data.amended.length} amended after arriving</span> : ''}.</p>
              {received.data.blocker && <p className="text-sm text-warning">{received.data.blocker}</p>}
            </>
          ))}
        </section>
      </div>

      {!loading && !state && !run && <EmptyState>Tax reporting has nothing for this vehicle yet.</EmptyState>}

      {viewing && (
        <EntryModal entryId={viewing.id} readOnly book={viewing.book} onClose={() => setViewing(null)} onSaved={load} />
      )}
    </div>
  )
}
