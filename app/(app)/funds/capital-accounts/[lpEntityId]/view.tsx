'use client'

import { useEffect, useState } from 'react'
import { Loader2, FileText, Pencil, Download } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useCurrency, formatAccountingPrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { quarterWindow, type PeriodPreset } from '@/lib/accounting/statement-period'
import { EmptyState } from '@/components/ui/empty-state'
import { useCanWrite } from '@/components/access-context'
import { VehicleLetterheadDialog } from '@/components/vehicle-letterhead'
import type { CapitalAccount } from '@/lib/accounting/capital-account'
import { rollForwardRows, commitmentSummaryRows, statementColumns } from '@/lib/accounting/capital-statement-layout'
import { BASIS_LABELS, STATEMENT_BASES, type StatementBasis } from '@/lib/accounting/statement-basis'

interface Row { lpEntityId: string; name: string; partnerClass: string; commitment: number; called: number; funded: number; outstanding: number; receivable: number; ending: number }
interface Period { preset: PeriodPreset; start: string | null; end: string | null; label: string }
interface LetterheadParts { logo: string | null; name: string | null; address: string | null; email: string | null }
interface Statement {
  row: Row
  rollForward: CapitalAccount
  periodRollForward: CapitalAccount
  ytdRollForward: CapitalAccount
  ytdPeriod: { start: string; end: string }
  ownership: number
  /** The partner's first capital movement in this vehicle. Bounds the year picker. */
  inception: string | null
  period: Period
  /** What the PDF prints, the fund's default, and this vehicle's overrides. */
  letterhead: { letterhead: LetterheadParts; fund: LetterheadParts; vehicle: LetterheadParts }
  /** The basis these figures are on, and the vehicle's default (what an unspecified request gets). */
  basis: StatementBasis
  defaultBasis: StatementBasis
  /** False for a partner on administrator snapshots: fair value only, so no toggle. */
  basesAvailable: boolean
}

// The period picker: a year (or inception to date, or custom dates), then within a year the whole
// year or one quarter. The current year's "whole year" is year to date. A calendar quarter or year
// goes to the API as a custom window, which names it ("Q1 2026", "FY 2025") for the statement.
type Scope = 'itd' | 'custom' | `${number}`
type Part = 'year' | '1' | '2' | '3' | '4'

const THIS_YEAR = new Date().getUTCFullYear()
const THIS_QUARTER = Math.floor(new Date().getUTCMonth() / 3) + 1

function periodRequest(scope: Scope, part: Part, start: string, end: string): { preset: PeriodPreset; start?: string; end?: string } {
  if (scope === 'itd') return { preset: 'itd' }
  if (scope === 'custom') return { preset: 'custom', ...(start ? { start } : {}), ...(end ? { end } : {}) }
  const year = Number(scope)
  if (part === 'year') return year === THIS_YEAR ? { preset: 'ytd' } : { preset: 'custom', start: `${year}-01-01`, end: `${year}-12-31` }
  return { preset: 'custom', ...quarterWindow(year, Number(part)) }
}

// The statement as the PDF lays it out (lib/accounting/capital-statement-layout.ts): the letterhead,
// the roll-forward in three columns, and the commitment summary. Nothing after the summary — the
// transaction list and fund-of-funds exhibits belong to the fund's financials, not a partner's
// capital account.
export function LpStatementView({ lpEntityId, vehicleId }: { lpEntityId: string; vehicleId?: string | null }) {
  const currency = useCurrency()
  // Accounting style, as the PDF prints it: negatives in parentheses around symbol and figure.
  const fmt = (v: number) => formatAccountingPrice(v, currency)
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const canEditLetterhead = useCanWrite('accounting')
  const [data, setData] = useState<Statement | null>(null)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<Scope>(`${THIS_YEAR}`)
  const [part, setPart] = useState<Part>('year')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  // Null until the person picks one: the statement then opens on the vehicle's default basis.
  const [basis, setBasis] = useState<StatementBasis | null>(null)
  const request = { ...periodRequest(scope, part, start, end), ...(basis ? { basis } : {}) }
  const requestKey = JSON.stringify(request)
  const [editingLetterhead, setEditingLetterhead] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({ lp: lpEntityId, ...JSON.parse(requestKey) })
    lf(`/api/accounting/lp-statement?${qs}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setData(d && !d.error ? d : null))
      .finally(() => setLoading(false))
  }, [lf, lpEntityId, requestKey, reload])

  if (loading && !data) return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
  if (!data) return <EmptyState>No statement for this LP in the selected vehicle.</EmptyState>

  const { row, period, ownership } = data
  const columns = statementColumns(period, {
    period: { account: data.periodRollForward, sub: period.start && period.end ? `${period.start} to ${period.end}` : period.label },
    ytd: { account: data.ytdRollForward, sub: `${data.ytdPeriod.start} to ${data.ytdPeriod.end}` },
    itd: { account: data.rollForward, sub: period.end ? `Through ${period.end}` : '' },
  })
  const accounts = columns.map(c => c.value.account)
  const rows = rollForwardRows(accounts)
  const summary = commitmentSummaryRows(accounts, row, ownership, data.basis)
  const lastCol = accounts.length - 1
  // The PDF names the basis on screen explicitly, so it can't come out on a different one.
  const pdfQs = new URLSearchParams({ lp: lpEntityId, ...request, basis: data.basis })
  if (group) pdfQs.set('group', group)
  const firstYear = Math.min(THIS_YEAR, Number(data.inception?.slice(0, 4)) || THIS_YEAR)
  const years = Array.from({ length: THIS_YEAR - firstYear + 1 }, (_, i) => THIS_YEAR - i)
  const quarters = scope === `${THIS_YEAR}` ? [1, 2, 3, 4].filter(q => q <= THIS_QUARTER) : [1, 2, 3, 4]
  const statementPdfUrl = `/api/accounting/lp-statement/pdf?${pdfQs}`
  // The ILPA Reporting Template is quarterly: the quarter picked, a past year's Q4, or else the last
  // quarter ended (the route's default).
  const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31']
  const ilpaQuarterEnd = scope === 'itd' || scope === 'custom' ? null
    : part !== 'year' ? `${scope}-${QUARTER_ENDS[Number(part) - 1]}`
    : scope !== `${THIS_YEAR}` ? `${scope}-12-31` : null
  const ilpaQs = new URLSearchParams({ lpEntityId, format: 'xlsx', ...(ilpaQuarterEnd ? { quarterEnd: ilpaQuarterEnd } : {}), ...(group ? { group } : {}) })

  const lh = data.letterhead
  const vehicleName = group ?? 'This vehicle'
  const contact = [lh.letterhead.address, lh.letterhead.email].filter(Boolean).join('\n')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{row.name}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <select
            value={scope}
            onChange={e => {
              const next = e.target.value as Scope
              setScope(next)
              // A quarter that hasn't started yet in the current year falls back to the whole year.
              if (next === `${THIS_YEAR}` && part !== 'year' && Number(part) > THIS_QUARTER) setPart('year')
            }}
            aria-label="Statement year"
            className="h-8 px-2 rounded-md border border-input bg-background text-xs"
          >
            {years.map(y => <option key={y} value={`${y}`}>{y}</option>)}
            <option value="itd">Inception to date</option>
            <option value="custom">Custom dates…</option>
          </select>
          {scope !== 'itd' && scope !== 'custom' && (
            <select
              value={part}
              onChange={e => setPart(e.target.value as Part)}
              aria-label="Statement period"
              className="h-8 px-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="year">{scope === `${THIS_YEAR}` ? 'Year to date' : 'Full year'}</option>
              {quarters.map(q => <option key={q} value={`${q}`}>Q{q}</option>)}
            </select>
          )}
          {scope === 'custom' && (
            <>
              <Input type="date" value={start} onChange={e => setStart(e.target.value)} className="h-8 w-36 text-xs" />
              <Input type="date" value={end} onChange={e => setEnd(e.target.value)} className="h-8 w-36 text-xs" />
            </>
          )}
          {/* The basis: fair value (the books as they stand), cost (no unrealized marks) or
              contributions and income only (no gains or losses at all). A reporting filter only. */}
          {data.basesAvailable && <select
            value={basis ?? data.basis}
            onChange={e => setBasis(e.target.value as StatementBasis)}
            aria-label="Statement basis"
            className="h-8 px-2 rounded-md border border-input bg-background text-xs"
          >
            {STATEMENT_BASES.map(b => (
              <option key={b} value={b}>{BASIS_LABELS[b]}{b === data.defaultBasis && data.defaultBasis !== 'fair_value' ? ' (default)' : ''}</option>
            ))}
          </select>}
          {/* The vehicle's letterhead (logo, name, address, email), each part falling back to the fund's. */}
          {vehicleId && canEditLetterhead && (
            <button
              onClick={() => setEditingLetterhead(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />Edit Details
            </button>
          )}
          {/* Preview only — renders the PDF without storing or sharing it. Publishing
              to the portal is the bulk action on the capital accounts page. */}
          <a
            href={statementPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FileText className="h-3.5 w-3.5" />Generate PDF
          </a>
          <a
            href={`/api/accounting/ilpa/reporting?${ilpaQs}`}
            title="The quarter as the ILPA Reporting Template (v. 2.0) states it: fees, expenses, offsets and carried interest in ILPA's categories, the commitment reconciliation and portfolio-company fees"
            className="inline-flex h-8 items-center gap-1.5 rounded border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />ILPA report (.xlsx)
          </a>
        </div>
      </div>

      <div className={`border rounded-card p-4 sm:p-6 space-y-6 ${loading ? 'opacity-60' : ''}`}>
        {/* Letterhead, as the PDF prints it */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="shrink-0">
            {lh.letterhead.logo && <img src={lh.letterhead.logo} alt="" className="h-10 w-auto object-contain" />}
          </div>
          <div className="text-right">
            <p className="text-heading font-display font-normal">{lh.letterhead.name}</p>
            {contact && <p className="text-xs text-muted-foreground whitespace-pre-line leading-snug mt-0.5">{contact}</p>}
          </div>
        </div>

        <div>
          <p className="text-heading font-display font-normal">Capital Account Statement</p>
          <p className="text-sm font-semibold">{row.name}</p>
          <p className="text-sm text-muted-foreground">{vehicleName} · {period.label}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs">
                <th className="text-left px-3 py-2 font-medium" />
                {columns.map(({ label, value }) => (
                  <th key={label} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                    {label}
                    {value.sub && <div className="font-normal text-muted-foreground">{value.sub}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className={`border-b last:border-b-0 ${r.style === 'total' ? 'font-semibold bg-muted/30' : ''}`}>
                  <td className="px-3 py-2">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={`px-3 py-2 text-right tabular-nums ${r.key === 'unclassified' && Math.abs(v) > 0.004 ? 'text-warning' : ''}`}>{fmt(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {/* The commitment summary shares the roll-forward's columns, so its figures sit under
                the same headings. A period flow of nothing (no capital called this quarter) is left
                blank rather than printed as $0.00, the way the PDF prints a dash. */}
            <tbody>
              <tr>
                <td colSpan={columns.length + 1} className="px-0 pt-6 pb-2 text-sm font-medium">Commitment summary</td>
              </tr>
              {summary.map(r => (
                <tr key={r.label} className="border-b last:border-b-0">
                  <td className="px-3 py-2">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">
                      {i < lastCol && (v === null || Math.abs(v) < 0.005) ? '' : r.format === 'percent' ? `${((v ?? 0) * 100).toFixed(3)}%` : fmt(v ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editingLetterhead && vehicleId && (
        <VehicleLetterheadDialog
          vehicleId={vehicleId}
          vehicleName={vehicleName}
          onClose={() => { setEditingLetterhead(false); setReload(n => n + 1) }}
          onSaved={() => { setEditingLetterhead(false); setReload(n => n + 1) }}
        />
      )}
    </div>
  )
}
