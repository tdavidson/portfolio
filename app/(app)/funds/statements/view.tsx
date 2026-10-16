'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { Button } from '@/components/ui/button'
import { useLedgerFetch, useVehicle, useFundSeg, useVehicleBase } from '@/components/accounting-vehicle'
import { useCanRead } from '@/components/access-context'
import { type PeriodPreset } from '@/lib/accounting/statement-period'
import { PeriodPicker } from '@/components/accounting/period-picker'
import { DownloadMenu, TaxPackageLink } from '@/components/accounting/download-menu'
import { EmptyState } from '@/components/ui/empty-state'

interface Section { label: string; rows: { code: string; name: string; amount: number }[]; total: number }
interface PartnerRow {
  id: string
  name: string
  beginning: number
  contributions: number
  distributions: number
  managementFees: number
  expenses: number
  operatingIncome: number
  realizedGains: number
  unrealizedGains: number
  transfers: number
  carriedInterest: number
  unclassified: number
  ending: number
}
interface CFSection { label: string; lines: { code: string; name: string; amount: number }[]; total: number }
interface Period { preset: PeriodPreset; start: string | null; end: string | null; label: string }
interface Data {
  period: Period
  trialBalance: { rows: { code: string; name: string; debit: number; credit: number }[]; totalDebits: number; totalCredits: number; balanced: boolean }
  balanceSheet: {
    assets: Section
    liabilities: Section
    equity: Section
    check: number
    partnersCapital: { total: number; unallocatedEarnings: number }
  }
  incomeStatement: { income: Section; expenses: Section; netIncome: number }
  changesInPartnersCapital: { partners: PartnerRow[]; totals: PartnerRow }
  cashFlows: {
    operating: CFSection
    financing: CFSection
    netChange: number
    openingCash: number
    endingCash: number
    nonCash: { entryId: string; date: string | null; description: string; amount: number; legs: { name: string; amount: number }[] }[]
  } | null
  // Prior-period payloads, most-recent-first, present only when ?compare= was sent.
  comparisons?: Omit<Data, 'comparisons'>[]
}

const CAP_COLS: { key: keyof PartnerRow; label: string }[] = [
  { key: 'beginning', label: 'Beginning' },
  { key: 'contributions', label: 'Contributions' },
  { key: 'distributions', label: 'Distributions' },
  { key: 'managementFees', label: 'Mgmt fees' },
  { key: 'expenses', label: 'Partnership exp.' },
  { key: 'operatingIncome', label: 'Operating income' },
  { key: 'realizedGains', label: 'Net realized G/(L)' },
  { key: 'unrealizedGains', label: 'Net unrealized G/(L)' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'carriedInterest', label: 'Carry accrued' },
  { key: 'unclassified', label: 'Unclassified' },
  { key: 'ending', label: 'Ending' },
]

export function StatementsView() {
  const currency = useCurrency()
  // A tax basis is the ledger plus the book-to-tax adjusting entries the tax run writes. With tax
  // reporting off there are none, so the option would read identically to book — hide it.
  const taxOn = useCanRead('tax')
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<PeriodPreset>('ytd')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [compare, setCompare] = useState<string>('0') // '0'|'1'|'2'|'3'|'4'|'all'
  const [order, setOrder] = useState<'recent' | 'oldest'>('recent')
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const fundSeg = useFundSeg()
  const base = useVehicleBase()
  // The statements are the figures; the trial balance is the working paper behind them. Same
  // package, same period controls — a second lens on it, not a second fetch.
  const [view, setView] = useState<'statements' | 'trial-balance'>('statements')
  // Book: the ledger as kept. Tax: the ledger plus the book-to-tax adjusting entries, read
  // together — what Schedule L and M-1 reconcile to. Every fetch and every download carries it.
  const [basis, setBasis] = useState<'book' | 'tax'>('book')

  // Every coded line links to its account's register over the same window, so a figure on a
  // statement is one click from the postings behind it. The register's closing balance for the
  // window IS the balance-sheet figure, and its activity IS the income-statement one.
  const registerHref = (code: string): string | null => {
    if (!base || !code) return null
    const qs = new URLSearchParams({ account: code, preset })
    if (preset === 'custom') { if (start) qs.set('start', start); if (end) qs.set('end', end) }
    if (basis === 'tax') qs.set('basis', 'tax')
    return `${base}/ledger?${qs}`
  }

  // Same period params as the on-screen fetch, plus the selected vehicle — the export
  // route computes the identical package and serializes it to a multi-tab .xlsx.
  const exportQs = new URLSearchParams({ preset })
  if (preset === 'custom') {
    if (start) exportQs.set('start', start)
    if (end) exportQs.set('end', end)
  }
  if (group) exportQs.set('group', group)
  if (compare !== '0') exportQs.set('compare', compare)
  if (basis === 'tax') exportQs.set('basis', 'tax')
  const canExport = !loading && !!data && data.trialBalance.rows.length > 0
  // The journal and chart exports take the window but not the comparison.
  const windowQs = new URLSearchParams(exportQs)
  windowQs.delete('compare')
  const downloads = [
    { label: 'Workpapers (Excel)', note: 'Trial balance, statements, capital, schedule of investments, cash flows, GL detail.', href: `/api/accounting/statements/export?${exportQs}` },
    { label: 'Statements (PDF)', note: 'The statement set as a document, one per page.', href: `/api/accounting/statements/pdf?${exportQs}` },
    { label: 'Journal (CSV)', note: 'Every posted entry in the period, one row per line.', href: `/api/accounting/journal/export?${windowQs}&format=csv` },
    { label: 'Journal for QuickBooks (CSV)', note: 'The same journal in the layout of QuickBooks’ Journal report.', href: `/api/accounting/journal/export?${windowQs}&format=quickbooks` },
    { label: 'Chart of accounts (CSV)', href: `/api/accounting/chart/export${group ? `?group=${encodeURIComponent(group)}` : ''}` },
  ]

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({ preset })
    if (preset === 'custom') {
      if (start) qs.set('start', start)
      if (end) qs.set('end', end)
    }
    if (compare !== '0') qs.set('compare', compare)
    if (basis === 'tax') qs.set('basis', 'tax')
    lf(`/api/accounting/statements?${qs}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false))
  }, [lf, preset, start, end, compare, basis])

  // Comparisons arrive most-recent-first and exclude the primary, so most-recent-first
  // columns = [primary, ...comparisons]; oldest-first is that reversed.
  const colData = data ? [data, ...(data.comparisons ?? [])] : []
  const cols = order === 'recent' ? colData : [...colData].reverse()

  const period = data?.period
  // A balance sheet is a snapshot; an income statement and cash flows cover a span.
  const asOfLabel = period?.end ? `as of ${period.end}` : 'as of today'
  const overLabel = period?.preset === 'itd'
    ? 'since inception'
    : period?.start && period?.end ? `for ${period.label}` : period?.label ?? ''

  const fmtCell = (v: number | undefined) => (v === undefined ? '' : fmt(v))

  // The equity's name comes with the payload (lib/accounting/vocab.ts): partners' capital on a
  // fund, members' capital on a management company, owner's equity on an individual.
  const equityLabel = data?.balanceSheet.equity.label ?? "Partners' capital"
  const equityWord = equityLabel.charAt(0).toLowerCase() + equityLabel.slice(1)
  const showPartners = !data || equityLabel === "Partners' capital" || data.changesInPartnersCapital.partners.length > 0
  const holderWord = equityLabel === "Members' capital" ? 'Member' : 'Partner'

  // Header row of period labels for a statement table. With compare='0', cols has
  // length 1 and this renders exactly the single-column header shape used before.
  const PeriodHead = ({ kind }: { kind: 'asOf' | 'over' }) => (
    <tr className="border-b bg-muted/50">
      <th className="text-left px-3 py-2 font-medium" />
      {cols.map((c, i) => (
        <th key={i} className="text-right px-3 py-2 font-medium whitespace-nowrap">
          <div>{c.period.label}</div>
          <div className="text-[10px] font-normal text-muted-foreground">
            {kind === 'asOf' ? (c.period.end ? `as of ${c.period.end}` : 'as of today') : (c.period.preset === 'itd' ? 'since inception' : c.period.label)}
          </div>
        </th>
      ))}
    </tr>
  )

  // Union section rows across columns by key, pulling each column's amount.
  const sectionMatrix = (pick: (d: Omit<Data, 'comparisons'>) => Section) => {
    const label = pick(cols[0]).label
    const keys: { key: string; name: string; code: string }[] = []
    const seen = new Set<string>()
    for (const c of cols) for (const r of pick(c).rows) {
      const key = r.code || r.name
      if (!seen.has(key)) { seen.add(key); keys.push({ key, name: r.name, code: r.code }) }
    }
    const amountFor = (c: Omit<Data, 'comparisons'>, key: string) =>
      pick(c).rows.find(r => (r.code || r.name) === key)?.amount
    return { label, keys, amountFor, totalFor: (c: Omit<Data, 'comparisons'>) => pick(c).total }
  }

  // A section with no detail rows (partners' capital) renders as a single total line.
  const MultiSec = ({ pick }: { pick: (d: Omit<Data, 'comparisons'>) => Section }) => {
    const m = sectionMatrix(pick)
    if (m.keys.length === 0 && cols.every(c => pick(c).total === 0)) return null
    return (
      <>
        {m.keys.length > 0 && (
          <tr className="border-t bg-muted/30"><td className="px-3 py-1.5 font-medium" colSpan={cols.length + 1}>{m.label}</td></tr>
        )}
        {m.keys.map(k => (
          <tr key={k.key} className="border-t">
            <td className="px-3 py-1.5 text-muted-foreground">
              {k.code && registerHref(k.code)
                ? <Link href={registerHref(k.code)!} className="hover:underline hover:text-foreground" title="Open this account's register">{k.code} · {k.name}</Link>
                : <>{k.code ? `${k.code} · ` : ''}{k.name}</>}
            </td>
            {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtCell(m.amountFor(c, k.key))}</td>)}
          </tr>
        ))}
        <tr className="border-t font-semibold">
          <td className="px-3 py-1.5">Total {m.label}</td>
          {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmt(m.totalFor(c))}</td>)}
        </tr>
      </>
    )
  }

  // Cash-flow sections have a slightly different shape ({ lines } not { rows }); map
  // them into Section so MultiSec can be reused instead of duplicating the renderer.
  const cfAsSection = (get: (cf: NonNullable<Data['cashFlows']>) => CFSection) =>
    (d: Omit<Data, 'comparisons'>): Section => {
      const cf = d.cashFlows
      if (!cf) return { label: get({ operating: { label: '', lines: [], total: 0 }, financing: { label: '', lines: [], total: 0 } } as any).label, rows: [], total: 0 }
      const s = get(cf)
      return { label: s.label, rows: s.lines.map(l => ({ code: l.code, name: l.name, amount: l.amount })), total: s.total }
    }

  return (
    <div className="space-y-4">
      {/* Action bar — export on the LEFT, the statement-period select (and custom from/to)
          pushed RIGHT via ml-auto, matching /funds/capital-accounts. Each statement's subheader
          below already states its as-of / covering dates, so there is no explainer line here. */}
      <div className="flex flex-wrap items-center gap-2">
        <DownloadMenu items={downloads} disabled={!canExport}>
          <TaxPackageLink group={group} />
        </DownloadMenu>

        <div className="inline-flex rounded-md border border-input text-sm" role="tablist" aria-label="Statements or trial balance">
          <button
            role="tab" aria-selected={view === 'statements'}
            onClick={() => setView('statements')}
            className={`h-9 rounded-l-md px-3 ${view === 'statements' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Statements
          </button>
          <button
            role="tab" aria-selected={view === 'trial-balance'}
            onClick={() => setView('trial-balance')}
            className={`h-9 rounded-r-md border-l border-input px-3 ${view === 'trial-balance' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Trial balance
          </button>
        </div>

        {taxOn && (
          <select
            value={basis}
            onChange={e => setBasis(e.target.value as 'book' | 'tax')}
            aria-label="Basis"
            title="Book: the ledger as kept. Tax basis: the ledger plus the book-to-tax adjusting entries."
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="book">Book basis</option>
            <option value="tax">Tax basis</option>
          </select>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PeriodPicker
            preset={preset} onPreset={setPreset}
            start={start} end={end} onStart={setStart} onEnd={setEnd}
          />
          <select
            value={compare}
            onChange={e => setCompare(e.target.value)}
            aria-label="Compare periods"
            className="h-9 px-3 rounded-md border border-input bg-background text-sm"
          >
            <option value="0">No comparison</option>
            <option value="1">+ Previous period</option>
            <option value="2">+ Past 2</option>
            <option value="3">+ Past 3</option>
            <option value="4">+ Past 4</option>
            <option value="all">+ All prior</option>
          </select>
          {compare !== '0' && (
            <button
              onClick={() => setOrder(o => (o === 'recent' ? 'oldest' : 'recent'))}
              className="h-9 px-3 rounded-md border border-input bg-background text-sm text-muted-foreground hover:text-foreground"
              title="Toggle column order"
            >
              {order === 'recent' ? 'Recent → old' : 'Old → recent'}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : !data || data.trialBalance.rows.length === 0 ? (
        <EmptyState
          action={base && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`${base}/journal`}>Open journal</Link>
            </Button>
          )}
        >
          No statements yet — the ledger has no posted entries{period?.end ? ` as of ${period.end}` : ''}.
        </EmptyState>
      ) : view === 'trial-balance' ? (() => {
        // Union accounts across the columns by code; a column with no balance shows blank.
        const keys: { code: string; name: string }[] = []
        const seen = new Set<string>()
        for (const c of cols) for (const row of c.trialBalance.rows) {
          if (!seen.has(row.code)) { seen.add(row.code); keys.push({ code: row.code, name: row.name }) }
        }
        keys.sort((a, b) => a.code.localeCompare(b.code))
        const rowFor = (c: Omit<Data, 'comparisons'>, code: string) => c.trialBalance.rows.find(r => r.code === code)
        const cell = (v: number | undefined) => (v ? fmt(v) : '')
        return (
          <section>
            <h2 className="text-base font-semibold">Trial balance</h2>
            <p className="text-xs text-muted-foreground mb-2">
              Cumulative balances {asOfLabel} — every account with a balance, debits and credits. Click an account for its register.
            </p>
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium" rowSpan={2}>Account</th>
                    {cols.map((c, i) => (
                      <th key={i} colSpan={2} className="text-center px-3 py-1 font-medium whitespace-nowrap border-l">
                        <div>{c.period.label}</div>
                        <div className="text-[10px] font-normal text-muted-foreground">{c.period.end ? `as of ${c.period.end}` : 'as of today'}</div>
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    {cols.map((_, i) => (
                      <Fragment key={i}>
                        <th className="text-right px-3 py-1 font-medium border-l">Debit</th>
                        <th className="text-right px-3 py-1 font-medium">Credit</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.code} className="border-t">
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {registerHref(k.code)
                          ? <Link href={registerHref(k.code)!} className="hover:underline hover:text-foreground" title="Open this account's register">{k.code} · {k.name}</Link>
                          : <>{k.code} · {k.name}</>}
                      </td>
                      {cols.map((c, i) => {
                        const row = rowFor(c, k.code)
                        return (
                          <Fragment key={i}>
                            <td className="px-3 py-1.5 text-right tabular-nums border-l">{cell(row?.debit)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{cell(row?.credit)}</td>
                          </Fragment>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30 font-semibold">
                    <td className="px-3 py-2">Total</td>
                    {cols.map((c, i) => (
                      <Fragment key={i}>
                        <td className="px-3 py-2 text-right tabular-nums border-l">{fmt(c.trialBalance.totalDebits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(c.trialBalance.totalCredits)}</td>
                      </Fragment>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            {cols.some(c => !c.trialBalance.balanced) && (
              <p className="text-sm text-warning mt-1">
                Out of balance in {cols.filter(c => !c.trialBalance.balanced).map(c => c.period.label).join(', ')} — total debits and credits differ.
              </p>
            )}
          </section>
        )
      })() : (
    // ASC 946 order: assets & liabilities, then operations, then cash flows, then
    // changes in partners' capital last — the per-partner detail behind the single
    // capital line on the balance sheet.
    <div className="space-y-8">
      <section>
        <h2 className="text-base font-semibold">Statement of assets, liabilities and {equityWord}</h2>
        <p className="text-xs text-muted-foreground mb-2">Balance sheet — {asOfLabel}</p>
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead><PeriodHead kind="asOf" /></thead>
            <tbody>
              <MultiSec pick={d => d.balanceSheet.assets} />
              <MultiSec pick={d => d.balanceSheet.liabilities} />
              <MultiSec pick={d => d.balanceSheet.equity} />
            </tbody>
          </table>
        </div>
        {/* Only worth saying when it's actionable: unallocated earnings mean the
            per-LP capital accounts understate until the period is closed. */}
        {data.balanceSheet.partnersCapital.unallocatedEarnings !== 0 && (
          <p className="text-sm text-warning mt-1">
            {fmt(data.balanceSheet.partnersCapital.unallocatedEarnings)} of net income is not yet allocated to partners.
            Close the period to allocate it — until then each partner&rsquo;s capital account understates their NAV.
          </p>
        )}
        {data.balanceSheet.check !== 0 && (
          <p className="text-sm text-warning mt-1">
            Does not balance — residual {fmt(data.balanceSheet.check)}.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-base font-semibold">Statement of operations</h2>
        <p className="text-xs text-muted-foreground mb-2">Income statement — {overLabel}</p>
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead><PeriodHead kind="over" /></thead>
            <tbody>
              <MultiSec pick={d => d.incomeStatement.income} />
              <MultiSec pick={d => d.incomeStatement.expenses} />
              <tr className="border-t font-semibold bg-muted/30">
                <td className="px-3 py-1.5">Net income</td>
                {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmt(c.incomeStatement.netIncome)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
        {/* A balanced trial balance is the expected state — only worth saying when it isn't. */}
        {!data.trialBalance.balanced && (
          <p className="text-sm text-warning mt-1">
            Trial balance is out of balance — debits {fmt(data.trialBalance.totalDebits)} vs credits {fmt(data.trialBalance.totalCredits)}.
          </p>
        )}
      </section>

      {data.cashFlows && (
        <section>
          <h2 className="text-base font-semibold">Statement of cash flows</h2>
          <p className="text-xs text-muted-foreground mb-2">{overLabel}</p>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead><PeriodHead kind="over" /></thead>
              <tbody>
                <MultiSec pick={cfAsSection(cf => cf.operating)} />
                <MultiSec pick={cfAsSection(cf => cf.financing)} />
                <tr className="border-t font-semibold bg-muted/30">
                  <td className="px-3 py-1.5">Net change in cash</td>
                  {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtCell(c.cashFlows?.netChange)}</td>)}
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-1.5 text-muted-foreground">Opening cash</td>
                  {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtCell(c.cashFlows?.openingCash)}</td>)}
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-1.5 text-muted-foreground">Ending cash</td>
                  {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtCell(c.cashFlows?.endingCash)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          {/* Required by ASC 230: investing/financing that bypassed the bank account.
              Without it, a loan the lender paid straight to the company looks like a
              repayment of money that was never borrowed. */}
          {data.cashFlows.nonCash.length > 0 && (
            <div className="mt-4">
              <h3 className="text-base font-medium">Supplemental — non-cash investing and financing activities</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Transactions that changed investments, borrowings, or partners&rsquo; capital without moving cash,
                so they do not appear above.
              </p>
              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.cashFlows.nonCash.map(n => (
                      <tr key={n.entryId} className="border-t first:border-t-0">
                        <td className="px-3 py-1.5">
                          <span className="tabular-nums text-xs text-muted-foreground mr-2">{n.date}</span>
                          {n.description}
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {n.legs.map(l => `${l.amount > 0 ? 'Dr' : 'Cr'} ${l.name}`).join(' · ')}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums align-top whitespace-nowrap">{fmt(n.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* An owner's-equity vehicle has no partners to roll forward: the single equity line on the
          balance sheet is the whole story, and an empty partner table would only raise a question. */}
      {showPartners && (
      <section>
        <h2 className="text-base font-semibold">Statement of changes in {equityWord}</h2>
        <p className="text-xs text-muted-foreground mb-2">
          {overLabel} — beginning capital is the balance carried into the period; this is the detail behind the
          single {equityWord} line on the balance sheet
        </p>
        {cols.length > 1 ? (() => {
          // Union partners across periods by id; value = that period's ending capital.
          const rows: { id: string; name: string }[] = []
          const seen = new Set<string>()
          for (const c of cols) for (const p of c.changesInPartnersCapital.partners) {
            if (!seen.has(p.id)) { seen.add(p.id); rows.push({ id: p.id, name: p.name }) }
          }
          const endingFor = (c: Omit<Data, 'comparisons'>, id: string) =>
            c.changesInPartnersCapital.partners.find(p => p.id === id)?.ending
          return (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium">{holderWord}</th>
                    {cols.map((c, i) => <th key={i} className="text-right px-3 py-2 font-medium whitespace-nowrap">{c.period.label}<div className="text-[10px] font-normal text-muted-foreground">ending capital{c.period.end ? ` · ${c.period.end}` : ''}</div></th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-1.5 text-muted-foreground">{r.name}</td>
                      {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtCell(endingFor(c, r.id))}</td>)}
                    </tr>
                  ))}
                  <tr className="border-t font-semibold">
                    <td className="px-3 py-1.5">Total</td>
                    {cols.map((c, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmt(c.changesInPartnersCapital.totals.ending)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          )
        })() : (
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium">{holderWord}</th>
                  {CAP_COLS.map(c => <th key={c.key} className="text-right px-3 py-2 font-medium">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.changesInPartnersCapital.partners.map(p => (
                  <tr key={p.id} className="border-b last:border-b-0 hover:bg-muted/30">
                    {/* p.id is the lpEntityId — link through to that partner's capital
                        account. The synthetic GP row has no entity to link to. */}
                    <td className="px-3 py-2">
                      {p.id === 'gp'
                        ? p.name
                        : <Link href={fundSeg ? `/funds/${fundSeg}/capital-accounts/${p.id}` : '/funds'} className="hover:underline">{p.name}</Link>}
                    </td>
                    {CAP_COLS.map(c => <td key={c.key} className={`px-3 py-2 text-right tabular-nums ${c.key === 'ending' ? 'font-semibold' : ''}`}>{fmt(p[c.key] as number)}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  {CAP_COLS.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums">{fmt(data.changesInPartnersCapital.totals[c.key] as number)}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
      )}
    </div>
      )}
    </div>
  )
}
