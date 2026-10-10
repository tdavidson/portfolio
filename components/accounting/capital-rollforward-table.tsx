'use client'

// The per-LP statement of changes in partners' capital — the roll-forward — shared by the accounting
// capital-accounts page and the LP-tracking surface. Fed by /api/accounting/capital-accounts for BOTH
// producers (posted ledger and pasted positions); drop-zero columns mean a pasting vehicle shows only
// the lines its snapshots can express.
//
// Optionally appends performance ratios (% Funded · DPI · RVPI · TVPI · Net IRR) and, for a pasted
// vehicle, makes the amount columns inline-editable (writing back to the LP's position).

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { Loader2, Check, X, Pencil, Trash2 } from 'lucide-react'
import { SortTh, nextSort, compareVals, type SortState } from '@/components/sortable-th'
import { type PeriodPreset } from '@/lib/accounting/statement-period'

export interface Account {
  beginning: number
  contributions: number
  distributions: number
  managementFees: number
  expenses: number
  operatingIncome: number
  realizedGains: number
  unrealizedGains: number
  fxTranslation: number
  transfers: number
  carriedInterest: number
  unclassified: number
  ending: number
}

export interface Row extends Account {
  evidence?: { missing: string[]; conflict: boolean; asOf: string | null; basis: string; values: { contributions: number | null; distributions: number | null; nav: number | null } }
  lpEntityId: string
  name: string
  partnerClass: string
  commitment: number
  called: number
  funded: number
  outstanding: number
  receivable: number
  /** Sent before it was called, not yet applied to a call. Absent on an older response. */
  advance?: number
  /** Per-LP Net IRR (derived from the ledger, or the pasted position figure). */
  irr?: number | null
  period: Account | null
  itd: Account
}

/** What an inline edit writes — the LP's name plus its position fields. */
export interface CapitalEdit {
  name: string | null
  commitment: number | null
  calledCapital: number | null
  distributions: number | null
  nav: number | null
  irr: number | null
}

export const COMMITMENT_COLUMNS: { key: 'commitment' | 'called' | 'funded' | 'outstanding' | 'receivable' | 'advance'; label: string }[] = [
  { key: 'commitment', label: 'Committed' },
  { key: 'called', label: 'Called' },
  { key: 'funded', label: 'Funded' },
  { key: 'outstanding', label: 'Remaining to be called' },
  { key: 'receivable', label: 'Called, unpaid' },
  // Sent before it was called; the next call applies it (lib/accounting/call-extras.ts).
  { key: 'advance', label: 'Received in advance' },
]

export const COLUMNS: { key: keyof Account; label: string }[] = [
  { key: 'beginning', label: 'Beginning' },
  { key: 'contributions', label: 'Contributions' },
  { key: 'distributions', label: 'Distributions' },
  { key: 'managementFees', label: 'Mgmt fees' },
  { key: 'expenses', label: 'Partnership exp.' },
  { key: 'operatingIncome', label: 'Operating income' },
  { key: 'realizedGains', label: 'Net realized G/(L)' },
  { key: 'unrealizedGains', label: 'Net unrealized G/(L)' },
  { key: 'fxTranslation', label: 'FX translation' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'carriedInterest', label: 'Carry accrued' },
  { key: 'unclassified', label: 'Unclassified' },
  { key: 'ending', label: 'Ending' },
]

const METRIC_COLUMNS = [
  { key: 'pctFunded', label: '% Funded' },
  { key: 'dpi', label: 'DPI' },
  { key: 'rvpi', label: 'RVPI' },
  { key: 'tvpi', label: 'TVPI' },
  { key: 'netIrr', label: 'Net IRR' },
] as const

const moicX = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
const pctX = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null)

export function CapitalRollforwardTable({
  rows,
  scope,
  fmt,
  search = '',
  metrics = false,
  lpHref,
  editable,
}: {
  rows: Row[]
  /** Which account to show per row: the period-scoped roll-forward, or ITD. */
  scope: { preset: PeriodPreset; start?: string | null }
  fmt: (v: number) => string
  /** Client-side LP-name filter. */
  search?: string
  /** Append the % Funded / DPI / RVPI / TVPI / Net IRR columns. */
  metrics?: boolean
  /** Per-LP drilldown link; omit to render the name as plain text. */
  lpHref?: (lpEntityId: string) => string
  /** When set, the name + amount columns are inline-editable (hover pencil → inputs → onSave), and
   *  a delete action appears when onDelete is provided. */
  editable?: { onSave: (lpEntityId: string, patch: CapitalEdit) => Promise<void>; onDelete?: (lpEntityId: string, name: string) => void }
}) {
  const acctOf = (r: Row): Account => (scope.preset === 'itd' ? r.itd : r.period ?? r.itd)

  const q = search.trim().toLowerCase()
  const shown = useMemo(
    () => (q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows),
    [rows, q],
  )

  // Drop lines that are zero for every shown partner (keep beginning/ending always).
  const columns = useMemo(
    () => COLUMNS.filter(c =>
      c.key === 'beginning' || c.key === 'ending' ||
      shown.some(r => Math.abs(acctOf(r)[c.key]) > 0.004)
    ),
    [shown, scope], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const commitmentCols = useMemo(
    () => COMMITMENT_COLUMNS.filter(c => (c.key !== 'receivable' && c.key !== 'advance') || shown.some(r => Math.abs(r[c.key] ?? 0) > 0.004)),
    [shown],
  )

  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const onSort = (key: string) => setSort(s => nextSort(s, key, key === 'name' ? 'asc' : 'desc'))
  const sortedRows = useMemo(() => {
    const accountKeys = new Set<string>(COLUMNS.map(c => c.key))
    const metric = (r: Row, key: string): number => {
      const a = acctOf(r), dist = -a.distributions
      switch (key) {
        case 'pctFunded': return ratio(r.called, r.commitment) ?? -1
        case 'dpi': return ratio(dist, r.called) ?? -1
        case 'rvpi': return ratio(a.ending, r.called) ?? -1
        case 'tvpi': return ratio(dist + a.ending, r.called) ?? -1
        case 'netIrr': return r.irr ?? -1
        default: return 0
      }
    }
    const val = (r: Row): number | string => {
      if (sort.key === 'name') return r.name
      if (accountKeys.has(sort.key)) return acctOf(r)[sort.key as keyof Account]
      if (METRIC_COLUMNS.some(m => m.key === sort.key)) return metric(r, sort.key)
      return (r as any)[sort.key] ?? 0
    }
    return [...shown].sort((a, b) => compareVals(val(a), val(b), sort.dir))
  }, [shown, sort, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  const totals = columns.reduce((acc, c) => {
    acc[c.key] = shown.reduce((s, r) => s + acctOf(r)[c.key], 0)
    return acc
  }, {} as Record<string, number>)
  const commitTotals = commitmentCols.reduce((acc, c) => {
    acc[c.key] = shown.reduce((s, r) => s + (r[c.key] ?? 0), 0)
    return acc
  }, {} as Record<string, number>)
  // Ratio totals come from the summed commitment/called and the summed distributions/ending.
  const tDist = -(totals['distributions'] ?? shown.reduce((s, r) => s - acctOf(r).distributions, 0))
  const tEnd = totals['ending'] ?? shown.reduce((s, r) => s + acctOf(r).ending, 0)

  const incomplete = shown.some(r => (r.evidence?.missing.length ?? 0) > 0)
  const metricTotal = (key: string): string => {
    if (incomplete) return '—'
    switch (key) {
      case 'pctFunded': return pctX(ratio(commitTotals['called'] ?? 0, commitTotals['commitment'] ?? 0))
      case 'dpi': return moicX(ratio(tDist, commitTotals['called'] ?? 0))
      case 'rvpi': return moicX(ratio(tEnd, commitTotals['called'] ?? 0))
      case 'tvpi': return moicX(ratio(tDist + tEnd, commitTotals['called'] ?? 0))
      default: return '—'
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr className="border-b bg-muted/50">
            <SortTh label="Partner" sortKey="name" sort={sort} onSort={onSort} align="left" />
            {commitmentCols.map(c => <SortTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} align="right" />)}
            {columns.map(c => <SortTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} align="right" />)}
            {metrics && METRIC_COLUMNS.map(c => <SortTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} align="right" />)}
            {editable && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(r => (
            <RollforwardRow
              key={r.lpEntityId}
              r={r} a={acctOf(r)}
              commitmentCols={commitmentCols} accountCols={columns} metrics={metrics}
              fmt={fmt} lpHref={lpHref} editable={editable}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-semibold">
            <td className="px-3 py-2">Total</td>
            {commitmentCols.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums">{shown.some(r => r[c.key] == null) ? '—' : fmt(commitTotals[c.key])}</td>)}
            {columns.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums">{incomplete ? '—' : fmt(totals[c.key])}</td>)}
            {metrics && METRIC_COLUMNS.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums text-muted-foreground">{metricTotal(c.key)}</td>)}
            {editable && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function RollforwardRow({
  r, a, commitmentCols, accountCols, metrics, fmt, lpHref, editable,
}: {
  r: Row
  a: Account
  commitmentCols: { key: 'commitment' | 'called' | 'funded' | 'outstanding' | 'receivable' | 'advance'; label: string }[]
  accountCols: { key: keyof Account; label: string }[]
  metrics: boolean
  fmt: (v: number) => string
  lpHref?: (lpEntityId: string) => string
  editable?: { onSave: (lpEntityId: string, patch: CapitalEdit) => Promise<void>; onDelete?: (lpEntityId: string, name: string) => void }
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rowErr, setRowErr] = useState<string | null>(null)
  const distPos = -a.distributions
  const [draft, setDraft] = useState({
    name: r.name ?? '',
    commitment: String(r.commitment ?? ''),
    calledCapital: String(r.called ?? ''),
    distributions: distPos ? String(distPos) : '',
    nav: String(a.ending ?? ''),
    irr: r.irr == null ? '' : String(r.irr),
  })

  const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s))
  async function save() {
    if (!editable) return
    setSaving(true); setRowErr(null)
    try {
      await editable.onSave(r.lpEntityId, {
        name: draft.name.trim() || null,
        commitment: numOrNull(draft.commitment),
        calledCapital: numOrNull(draft.calledCapital),
        distributions: numOrNull(draft.distributions),
        nav: numOrNull(draft.nav),
        irr: numOrNull(draft.irr),
      })
      setEditing(false)
    } catch (e: any) {
      setRowErr(e?.message ?? 'Could not save')
    } finally {
      setSaving(false)
    }
  }
  const inp = (k: 'commitment' | 'calledCapital' | 'distributions' | 'nav' | 'irr', w = 'w-24') => (
    <Input value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} inputMode="decimal" className={`h-8 ${w} text-right tabular-nums ml-auto`} />
  )

  const metricCell = (key: string) => {
    if (r.evidence?.missing.length && key !== 'netIrr') return '—'
    switch (key) {
      case 'pctFunded': return pctX(ratio(r.called, r.commitment))
      case 'dpi': return moicX(ratio(distPos, r.called))
      case 'rvpi': return moicX(ratio(a.ending, r.called))
      case 'tvpi': return moicX(ratio(distPos + a.ending, r.called))
      case 'netIrr': return pctX(r.irr)
      default: return '—'
    }
  }

  if (editing) {
    return (
      <tr className="border-b last:border-b-0 bg-muted/20">
        <td className="px-3 py-1.5 font-medium">
          <span className="flex items-center gap-2">
            <Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="LP name" className="h-8 w-44 text-sm" />
            <span className="flex items-center gap-1 shrink-0">
              <button onClick={save} disabled={saving} title="Save" className="text-success hover:text-success">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : <Check className="h-3.5 w-3.5 inline" />}</button>
              <button onClick={() => { setEditing(false); setRowErr(null) }} title="Cancel" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5 inline" /></button>
            </span>
          </span>
          {rowErr && <p className="text-sm text-destructive mt-1">{rowErr}</p>}
        </td>
        {commitmentCols.map(c => (
          <td key={c.key} className="px-3 py-1.5 text-right tabular-nums">
            {c.key === 'commitment' ? inp('commitment') : c.key === 'called' ? inp('calledCapital') : fmt(r[c.key] ?? 0)}
          </td>
        ))}
        {accountCols.map(c => (
          <td key={c.key} className="px-3 py-1.5 text-right tabular-nums">
            {c.key === 'distributions' ? inp('distributions') : c.key === 'ending' ? inp('nav') : fmt(a[c.key])}
          </td>
        ))}
        {metrics && METRIC_COLUMNS.map(c => (
          <td key={c.key} className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
            {c.key === 'netIrr' ? inp('irr', 'w-20') : metricCell(c.key)}
          </td>
        ))}
        <td />
      </tr>
    )
  }

  const href = lpHref?.(r.lpEntityId)
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30 group">
      <td className="px-3 py-2 max-w-[200px]">
        <div className="flex items-center gap-1.5 min-w-0">
          {href
            ? <Link href={href} className="hover:underline truncate" title={r.name}>{r.name}</Link>
            : <span className="truncate" title={r.name}>{r.name}</span>}
          {r.partnerClass === 'gp' && <span className="text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">GP</span>}
          {editable && (
            <button onClick={() => setEditing(true)} title="Edit name & figures" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground shrink-0"><Pencil className="h-3.5 w-3.5" /></button>
          )}
          {editable?.onDelete && (
            <button onClick={() => editable.onDelete!(r.lpEntityId, r.name)} title="Delete LP" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0"><Trash2 className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </td>
      {commitmentCols.map(c => (
        <td key={c.key} className={`px-3 py-2 text-right tabular-nums ${Math.abs(r[c.key] ?? 0) > 0.004 ? '' : 'text-muted-foreground'}`}>{r[c.key] == null ? '—' : fmt(r[c.key] ?? 0)}</td>
      ))}
      {accountCols.map(c => (
        <td key={c.key} className={`px-3 py-2 text-right tabular-nums ${c.key === 'ending' ? 'font-semibold' : ''} ${c.key === 'unclassified' && Math.abs(a[c.key]) > 0.004 ? 'text-warning' : ''}`}>{r.evidence?.missing.length ? (c.key === 'ending' && r.evidence.values.nav != null ? fmt(r.evidence.values.nav) : '—') : fmt(a[c.key])}</td>
      ))}
      {metrics && METRIC_COLUMNS.map(c => (
        <td key={c.key} className="px-3 py-2 text-right tabular-nums text-muted-foreground">{metricCell(c.key)}</td>
      ))}
      {editable && <td />}
    </tr>
  )
}
