'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, ChevronUp, ChevronDown, Lock, Pencil, Link2Off } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import type { CompanyStatus } from '@/lib/types/database'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AddCompanyButton } from '@/components/add-company-button'
import { AddVehicleButton } from '@/components/add-vehicle-button'
import { AddFundHoldingButton } from '@/components/add-fund-holding-button'
import { AddDigitalAssetButton } from '@/components/add-digital-asset-button'
import { holdingHref } from '@/lib/portfolio/holding-href'
import { VehicleEditModal, VehicleLinkModal, type EditableVehicle } from '@/components/vehicle-edit-modal'
import { InvestmentVehicleFilters } from '@/components/investments-vehicle-filters'
import { AnalystPanel } from '@/components/analyst-panel'
import { PortfolioNotesProvider, PortfolioNotesButton, PortfolioNotesPanel } from '@/components/portfolio-notes'
import { useFeatureVisibility } from '@/components/feature-visibility-context'

interface CompanySummary {
  companyId: string
  companyName: string
  status: CompanyStatus
  holdingType: 'company' | 'fund' | 'crypto'
  portfolioGroup: string[]
  totalInvested: number
  totalRealized: number
  unrealizedValue: number
  fmv: number
  moic: number | null
  irr: number | null
  proceedsReceived: number
  proceedsEscrow: number
  totalCostBasisExited: number
}

const KIND_LABELS: Record<CompanySummary['holdingType'], string> = {
  company: 'Company',
  fund: 'Fund',
  crypto: 'Digital asset',
}

interface GroupSummary {
  group: string
  totalInvested: number
  proceedsReceived: number
  proceedsEscrow: number
  totalRealized: number
  unrealizedValue: number
  totalCostBasisExited: number
  moic: number | null
  irr: number | null
}


interface PortfolioData {
  totalInvested: number
  totalRealized: number
  totalUnrealized: number
  totalFMV: number
  portfolioMOIC: number | null
  portfolioIRR: number | null
  companies: CompanySummary[]
  groups: GroupSummary[]
}

type SortKey = 'companyName' | 'status' | 'portfolioGroup' | 'totalInvested' | 'currentCost' | 'proceedsReceived' | 'proceedsEscrow' | 'unrealizedValue' | 'totalValue' | 'realizedGL' | 'unrealizedGL' | 'totalGL' | 'moic' | 'realizedMoic' | 'unrealizedMoic' | 'irr' | 'pctUnrealized' | 'pctTotalValue'
type SortDir = 'asc' | 'desc'

type GroupSortKey = 'group' | 'vintage' | 'totalInvested' | 'currentCost' | 'proceedsReceived' | 'proceedsEscrow' | 'unrealizedValue' | 'totalValue' | 'realizedGL' | 'unrealizedGL' | 'totalGL' | 'moic' | 'realizedMoic' | 'unrealizedMoic' | 'irr'

// Derived metric helpers
function currentCost(row: { totalInvested: number; totalCostBasisExited: number }) {
  return row.totalInvested - row.totalCostBasisExited
}
function totalValue(row: { totalRealized: number; unrealizedValue: number }) {
  return row.totalRealized + row.unrealizedValue
}
function realizedGL(row: { totalRealized: number; totalCostBasisExited: number }) {
  return row.totalRealized - row.totalCostBasisExited
}
function unrealizedGL(row: { totalInvested: number; totalCostBasisExited: number; unrealizedValue: number }) {
  return row.unrealizedValue - currentCost(row)
}
function totalGL(row: { totalInvested: number; totalRealized: number; unrealizedValue: number }) {
  return totalValue(row) - row.totalInvested
}
function realizedMoic(row: { totalRealized: number; totalCostBasisExited: number }) {
  return row.totalCostBasisExited > 0 ? row.totalRealized / row.totalCostBasisExited : null
}
function unrealizedMoic(row: { totalInvested: number; totalCostBasisExited: number; unrealizedValue: number }) {
  const cc = currentCost(row)
  return cc > 0 ? row.unrealizedValue / cc : null
}

function fmtMoic(val: number | null): string {
  if (val == null) return '-'
  return `${val.toFixed(2)}x`
}

function fmtIrr(val: number | null): string {
  if (val == null) return '-'
  let pct = val * 100
  if (Object.is(pct, -0) || (pct < 0 && pct > -0.05)) pct = 0
  return `${pct.toFixed(1)}%`
}

const STATUS_COLORS: Record<CompanyStatus, string> = {
  active: 'text-success',
  exited: 'text-info',
  'written-off': 'text-muted-foreground',
}

const TEXT_SORT_KEYS: SortKey[] = ['companyName', 'status', 'portfolioGroup']

function getDerivedValue(row: CompanySummary, key: SortKey, helpers?: { pctUnrealized: (c: CompanySummary) => number | null; pctTotalValue: (c: CompanySummary) => number | null }): number {
  switch (key) {
    case 'currentCost': return currentCost(row)
    case 'proceedsReceived': return row.proceedsReceived
    case 'proceedsEscrow': return row.proceedsEscrow
    case 'unrealizedValue': return row.unrealizedValue
    case 'totalValue': return totalValue(row)
    case 'realizedGL': return realizedGL(row)
    case 'unrealizedGL': return unrealizedGL(row)
    case 'totalGL': return totalGL(row)
    case 'realizedMoic': return realizedMoic(row) ?? -Infinity
    case 'unrealizedMoic': return unrealizedMoic(row) ?? -Infinity
    case 'totalInvested': return row.totalInvested
    case 'moic': return row.moic ?? -Infinity
    case 'irr': return row.irr ?? -Infinity
    case 'pctUnrealized': return helpers?.pctUnrealized(row) ?? -Infinity
    case 'pctTotalValue': return helpers?.pctTotalValue(row) ?? -Infinity
    default: return 0
  }
}

function getGroupDerivedValue(row: GroupSummary, key: GroupSortKey): number {
  switch (key) {
    case 'currentCost': return currentCost(row)
    case 'proceedsReceived': return row.proceedsReceived
    case 'proceedsEscrow': return row.proceedsEscrow
    case 'unrealizedValue': return row.unrealizedValue
    case 'totalValue': return totalValue(row)
    case 'realizedGL': return realizedGL(row)
    case 'unrealizedGL': return unrealizedGL(row)
    case 'totalGL': return totalGL(row)
    case 'realizedMoic': return realizedMoic(row) ?? -Infinity
    case 'unrealizedMoic': return unrealizedMoic(row) ?? -Infinity
    case 'totalInvested': return row.totalInvested
    case 'moic': return row.moic ?? -Infinity
    case 'irr': return row.irr ?? -Infinity
    default: return 0
  }
}

export default function InvestmentsPage() {
  const fv = useFeatureVisibility()
  const currency = useCurrency()
  const fmt = (val: number) => formatCurrency(val, currency)
  const fmtFull = (val: number) => formatCurrencyFull(val, currency)

  const [data, setData] = useState<PortfolioData | null>(null)
  const [loading, setLoading] = useState(true)
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().split('T')[0])
  const [refreshKey, setRefreshKey] = useState(0) // bumped after adding a vehicle to re-fetch

  const [sortKey, setSortKey] = useState<SortKey>('totalValue')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState('')

  const [groupSortKey, setGroupSortKey] = useState<GroupSortKey>('totalInvested')
  const [groupSortDir, setGroupSortDir] = useState<SortDir>('desc')

  // Vintage year per vehicle. That is ALL this page takes from outside the investment data.
  //
  // It used to also show TVPI / DPI / RVPI / Net IRR here, computed client-side from hand-typed
  // cash flows with an ESTIMATED carry haircut. Those are NET, fund-level metrics and they do
  // not belong on a gross-investments sheet: this page reports what the portfolio did, before
  // fund economics. The net numbers live on /funds, derived from the ledger, where carry is a
  // real accrual rather than a guess — which is also how the carry estimate stopped being a
  // problem on this page: it was deleted, not fixed.
  const [vintages, setVintages] = useState<Map<string, number | null>>(new Map())
  // Full vehicle registry rows, so a group row can be edited in place (name/type/vintage/active).
  const [vehicleList, setVehicleList] = useState<Array<{ id: string; name: string; aliases: string[] | null; kind: string; active: boolean; vintage_year: number | null }>>([])
  const [editingVehicle, setEditingVehicle] = useState<EditableVehicle | null>(null)
  // A group string with no registry vehicle behind it — offer to link or register it rather than
  // silently showing a row with no vintage and no edit.
  const [linkingGroup, setLinkingGroup] = useState<string | null>(null)
  // Filters. Default: hide empty (no-transaction) vehicles and hide GP/associate entities — the
  // common view — but every combination is pickable.
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(() => new Set(['fund', 'spv', 'direct', 'other']))
  const [showEmpty, setShowEmpty] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [invRes, vehRes] = await Promise.all([
          fetch(`/api/portfolio/investments?asOf=${asOfDate}`),
          fetch('/api/vehicles'),
        ])
        if (invRes.ok) setData(await invRes.json())
        if (vehRes.ok) {
          const vs = await vehRes.json()
          // Key the vintage by the vehicle's name AND every alias: the portfolio_group on a
          // transaction is often an alias, not the canonical name, so a name-only map missed it.
          setVehicleList(vs ?? [])
          const norm = (s: string) => s.trim().toLowerCase()
          const vmap = new Map<string, number | null>()
          for (const v of (vs ?? []) as Array<{ name: string; aliases?: string[] | null; vintage_year: number | null }>) {
            const vint = v.vintage_year ?? null
            vmap.set(norm(v.name), vint)
            for (const alias of (v.aliases ?? [])) vmap.set(norm(alias), vint)
          }
          setVintages(vmap)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [asOfDate, refreshKey])

  // The registry vehicle behind a portfolio group (matched by name or alias), for in-place editing.
  const vehicleForGroup = (group: string): EditableVehicle | null => {
    const n = group.trim().toLowerCase()
    const v = vehicleList.find(x => x.name.trim().toLowerCase() === n || (x.aliases ?? []).some(a => a.trim().toLowerCase() === n))
    return v ? { id: v.id, name: v.name, kind: v.kind, vintage_year: v.vintage_year, active: v.active, aliases: v.aliases ?? [] } : null
  }

  // Whether a vehicle/group should be visible per the popover's vehicle-type selection. Shared by
  // the group summary table and the companies table so both respect the same filter.
  const groupIsVisible = (group: string) => {
    const veh = vehicleForGroup(group)
    if (veh && !selectedKinds.has(veh.kind)) return false
    return true
  }

  // Group-level totals for percentage columns
  const groupTotalsMap = useMemo(() => {
    const map = new Map<string, { unrealized: number; totalVal: number }>()
    if (!data) return map
    for (const g of data.groups ?? []) {
      map.set(g.group, { unrealized: g.unrealizedValue, totalVal: totalValue(g) })
    }
    return map
  }, [data])

  function pctOfGroupUnrealized(c: CompanySummary): number | null {
    const groupName = c.portfolioGroup[0] ?? ''
    const gt = groupTotalsMap.get(groupName)
    if (!gt || gt.unrealized === 0) return null
    return c.unrealizedValue / gt.unrealized
  }

  function pctOfGroupTotalValue(c: CompanySummary): number | null {
    const groupName = c.portfolioGroup[0] ?? ''
    const gt = groupTotalsMap.get(groupName)
    if (!gt || gt.totalVal === 0) return null
    return totalValue(c) / gt.totalVal
  }

  // Filter + sort companies
  const filtered = useMemo(() => {
    if (!data) return []
    let list = data.companies

    if (statusFilter) {
      list = list.filter(c => c.status === statusFilter)
    }
    list = list.filter(c => c.portfolioGroup.length === 0 || c.portfolioGroup.some(g => groupIsVisible(g)))

    const dir = sortDir === 'asc' ? 1 : -1

    list = [...list].sort((a, b) => {
      if (sortKey === 'companyName') return dir * a.companyName.localeCompare(b.companyName)
      if (sortKey === 'status') return dir * a.status.localeCompare(b.status)
      if (sortKey === 'portfolioGroup') return dir * (a.portfolioGroup.join(', ')).localeCompare(b.portfolioGroup.join(', '))

      const helpers = { pctUnrealized: pctOfGroupUnrealized, pctTotalValue: pctOfGroupTotalValue }
      const av = getDerivedValue(a, sortKey, helpers)
      const bv = getDerivedValue(b, sortKey, helpers)
      return dir * (av - bv)
    })

    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, statusFilter, sortKey, sortDir, groupTotalsMap, selectedKinds, vehicleList])

  // Sort groups
  const sortedGroups = useMemo(() => {
    const base = data?.groups ?? []
    const norm = (s: string) => s.trim().toLowerCase()
    let list: GroupSummary[] = [...base]
    // "Show empty" adds a zero row for every registry vehicle with no transactions (matched by
    // name/alias), so it can still be edited from here.
    if (showEmpty) {
      const groupKeys = new Set(base.map(g => norm(g.group)))
      const isRep = (v: { name: string; aliases: string[] | null }) =>
        groupKeys.has(norm(v.name)) || (v.aliases ?? []).some(a => groupKeys.has(norm(a)))
      const extras: GroupSummary[] = vehicleList.filter(v => !isRep(v)).map(v => ({
        group: v.name, totalInvested: 0, proceedsReceived: 0, proceedsEscrow: 0,
        totalRealized: 0, unrealizedValue: 0, totalCostBasisExited: 0, moic: null, irr: null,
      }))
      list = [...base, ...extras]
    }
    // Type filter (a group's vehicle kind must be selected; an unmapped group has no kind, so it
    // always shows) + the specific-vehicle picker.
    list = list.filter(g => groupIsVisible(g.group))
    if (list.length === 0) return []
    const dir = groupSortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      if (groupSortKey === 'group') return dir * a.group.localeCompare(b.group)
      if (groupSortKey === 'vintage') {
        const av = vintages.get(a.group.trim().toLowerCase()) ?? 0
        const bv = vintages.get(b.group.trim().toLowerCase()) ?? 0
        return dir * (av - bv)
      }
      const av = getGroupDerivedValue(a, groupSortKey)
      const bv = getGroupDerivedValue(b, groupSortKey)
      return dir * (av - bv)
    })
  }, [data, groupSortKey, groupSortDir, vintages, showEmpty, selectedKinds, vehicleList])

  // Group totals for footer
  const groupTotals = useMemo(() => {
    if (sortedGroups.length === 0) return null
    const t = { totalInvested: 0, proceedsReceived: 0, proceedsEscrow: 0, totalRealized: 0, unrealizedValue: 0, totalCostBasisExited: 0 }
    for (const g of sortedGroups) {
      t.totalInvested += g.totalInvested
      t.proceedsReceived += g.proceedsReceived
      t.proceedsEscrow += g.proceedsEscrow
      t.totalRealized += g.totalRealized
      t.unrealizedValue += g.unrealizedValue
      t.totalCostBasisExited += g.totalCostBasisExited
    }
    const moic = t.totalInvested > 0 ? (t.totalRealized + t.unrealizedValue) / t.totalInvested : null
    return { ...t, moic }
  }, [sortedGroups])

  // Footer totals from filtered company data
  const totals = useMemo(() => {
    const t = { totalInvested: 0, totalRealized: 0, unrealizedValue: 0, proceedsReceived: 0, proceedsEscrow: 0, totalCostBasisExited: 0 }
    for (const c of filtered) {
      t.totalInvested += c.totalInvested
      t.totalRealized += c.totalRealized
      t.unrealizedValue += c.unrealizedValue
      t.proceedsReceived += c.proceedsReceived
      t.proceedsEscrow += c.proceedsEscrow
      t.totalCostBasisExited += c.totalCostBasisExited
    }
    const moic = t.totalInvested > 0 ? (t.totalRealized + t.unrealizedValue) / t.totalInvested : null
    return { ...t, moic }
  }, [filtered])

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(TEXT_SORT_KEYS.includes(key) ? 'asc' : 'desc')
    }
  }

  function handleGroupSort(key: GroupSortKey) {
    if (groupSortKey === key) {
      setGroupSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setGroupSortKey(key)
      setGroupSortDir(key === 'group' || key === 'vintage' ? 'asc' : 'desc')
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null
    return sortDir === 'asc'
      ? <ChevronUp className="inline h-3 w-3 ml-0.5" />
      : <ChevronDown className="inline h-3 w-3 ml-0.5" />
  }

  function GroupSortIcon({ col }: { col: GroupSortKey }) {
    if (groupSortKey !== col) return null
    return groupSortDir === 'asc'
      ? <ChevronUp className="inline h-3 w-3 ml-0.5" />
      : <ChevronDown className="inline h-3 w-3 ml-0.5" />
  }

  // Shared numeric column definitions (used by both group summary and company table)
  const numericColumns: { label: string; sortKey: string; getValue: (row: { totalInvested: number; totalRealized: number; unrealizedValue: number; totalCostBasisExited: number; proceedsReceived: number; proceedsEscrow: number; moic?: number | null; irr?: number | null }) => number | null; format: 'currency' | 'moic' | 'irr' }[] = [
    { label: 'Invested', sortKey: 'totalInvested', getValue: r => r.totalInvested, format: 'currency' },
    { label: 'Current Cost', sortKey: 'currentCost', getValue: r => currentCost(r), format: 'currency' },
    { label: 'Proceeds', sortKey: 'proceedsReceived', getValue: r => r.proceedsReceived, format: 'currency' },
    { label: 'Escrow', sortKey: 'proceedsEscrow', getValue: r => r.proceedsEscrow, format: 'currency' },
    { label: 'Unrealized', sortKey: 'unrealizedValue', getValue: r => r.unrealizedValue, format: 'currency' },
    { label: 'Total Value', sortKey: 'totalValue', getValue: r => totalValue(r), format: 'currency' },
    { label: 'Realized G/L', sortKey: 'realizedGL', getValue: r => realizedGL(r), format: 'currency' },
    { label: 'Unrealized G/L', sortKey: 'unrealizedGL', getValue: r => unrealizedGL(r), format: 'currency' },
    { label: 'Total G/L', sortKey: 'totalGL', getValue: r => totalGL(r), format: 'currency' },
    { label: 'Gross MOIC', sortKey: 'moic', getValue: r => r.moic ?? null, format: 'moic' },
    { label: 'Realized / Cost MOIC', sortKey: 'realizedMoic', getValue: r => realizedMoic(r), format: 'moic' },
    { label: 'Unrealized / Cost MOIC', sortKey: 'unrealizedMoic', getValue: r => unrealizedMoic(r), format: 'moic' },
    { label: 'Gross IRR', sortKey: 'irr', getValue: r => r.irr ?? null, format: 'irr' },
  ]

  // Company-only columns: insert % columns after their absolute counterparts
  const companyColumns: { label: string; sortKey: string; type: 'numeric' | 'pct'; colIdx?: number }[] = []
  for (let i = 0; i < numericColumns.length; i++) {
    companyColumns.push({ label: numericColumns[i].label, sortKey: numericColumns[i].sortKey, type: 'numeric', colIdx: i })
    if (numericColumns[i].sortKey === 'unrealizedValue') {
      companyColumns.push({ label: '% Unrealized', sortKey: 'pctUnrealized', type: 'pct' })
    }
    if (numericColumns[i].sortKey === 'totalValue') {
      companyColumns.push({ label: '% Total Value', sortKey: 'pctTotalValue', type: 'pct' })
    }
  }

  function fmtVal(val: number | null, format: 'currency' | 'moic' | 'irr'): string {
    if (val == null) return '-'
    if (format === 'moic') return fmtMoic(val)
    if (format === 'irr') return fmtIrr(val)
    return fmtFull(val)
  }

  const heading = (
    <div className="mb-6 space-y-1">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.investments === 'admin' && <Lock className="h-4 w-4 text-warning" />}Investments</h1>
        <div className="flex items-center gap-2"><PortfolioNotesButton /><AnalystToggleButton /></div>
      </div>
      <p className="text-sm text-muted-foreground">Every holding — companies, fund holdings and digital assets — at cost and value</p>
      <div className="flex items-center gap-2 pt-3">
        <AddCompanyButton />
        <AddFundHoldingButton onCreated={() => setRefreshKey(k => k + 1)} />
        <AddDigitalAssetButton />
        <AddVehicleButton onCreated={() => setRefreshKey(k => k + 1)} />
        <div className="ml-auto flex items-center gap-2">
          <InvestmentVehicleFilters
            selectedKinds={selectedKinds}
            onToggleKind={k => setSelectedKinds(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })}
            showEmpty={showEmpty}
            onToggleShowEmpty={() => setShowEmpty(v => !v)}
            status={statusFilter}
            onStatusChange={setStatusFilter}
          />
          <span className="text-sm text-muted-foreground">As of</span>
          <input
            type="date"
            value={asOfDate}
            onChange={e => setAsOfDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
        </div>
      </div>
    </div>
  )

  if (loading) {
    return (
      <PortfolioNotesProvider pageContext="investments">
      <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
        {heading}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 w-full">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        </div>
        <PortfolioNotesPanel />
        <AnalystPanel />
        </div>
      </div>
      </PortfolioNotesProvider>
    )
  }

  if (!data || data.companies.length === 0) {
    return (
      <PortfolioNotesProvider pageContext="investments">
      <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
        {heading}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 w-full">
          <p className="text-sm text-muted-foreground">
            No investment data yet. Add transactions from individual company pages or use the Import page.
          </p>
        </div>
        <PortfolioNotesPanel />
        <AnalystPanel />
        </div>
      </div>
      </PortfolioNotesProvider>
    )
  }

  return (
    <PortfolioNotesProvider pageContext="investments">
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
      {heading}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground mb-1">Total Invested</p>
            <p className="text-xl font-semibold">{fmt(data.totalInvested)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground mb-1">Total FMV</p>
            <p className="text-xl font-semibold">{fmt(data.totalFMV)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground mb-1">Total Realized</p>
            <p className="text-xl font-semibold">{fmt(data.totalRealized)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground mb-1">Gross MOIC</p>
            <p className="text-xl font-semibold">{fmtMoic(data.portfolioMOIC)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground mb-1">Gross IRR</p>
            <p className="text-xl font-semibold">{fmtIrr(data.portfolioIRR)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Group summary table, only shown when multiple groups exist */}
      {sortedGroups.length > 0 && groupTotals && (
        <div className="mb-8">
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted">
                  <th className="text-left px-3 py-2 font-medium sticky left-0 bg-muted z-10">
                    <button onClick={() => handleGroupSort('group')} className="hover:text-foreground">
                      Vehicle<GroupSortIcon col="group" />
                    </button>
                  </th>
                  <th className="text-center px-3 py-2 font-medium">
                    <button onClick={() => handleGroupSort('vintage')} className="hover:text-foreground">
                      Vintage<GroupSortIcon col="vintage" />
                    </button>
                  </th>
                  {numericColumns.map(col => (
                    <th key={col.sortKey} className="text-right px-3 py-2 font-medium">
                      <button onClick={() => handleGroupSort(col.sortKey as GroupSortKey)} className="hover:text-foreground">
                        {col.label}<GroupSortIcon col={col.sortKey as GroupSortKey} />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedGroups.map(g => {
                  const veh = vehicleForGroup(g.group)
                  return (
                    <tr key={g.group} className="group border-b last:border-b-0 hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium sticky left-0 bg-background z-10">
                        <span className="inline-flex items-center gap-1.5">
                          {g.group || '(none)'}
                          {veh ? (
                            <button onClick={() => setEditingVehicle(veh)} title="Edit vehicle" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground">
                              <Pencil className="h-3 w-3" />
                            </button>
                          ) : g.group ? (
                            <button
                              onClick={() => setLinkingGroup(g.group)}
                              title="No vehicle matches this group name — link or register it"
                              className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                            >
                              <Link2Off className="h-3 w-3" />
                            </button>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-muted-foreground">{vintages.get(g.group.trim().toLowerCase()) ?? '-'}</td>
                      {numericColumns.map(col => (
                        <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtVal(col.getValue(g), col.format)}</td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
              {sortedGroups.length > 1 && (
              <tfoot>
                <tr className="border-t bg-muted font-medium">
                  <td className="px-3 py-2 sticky left-0 bg-muted z-10">Total</td>
                  <td className="px-3 py-2" />
                  {numericColumns.map(col => {
                    if (col.format === 'irr') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtIrr(data.portfolioIRR)}</td>
                    if (col.sortKey === 'moic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(groupTotals.moic)}</td>
                    if (col.sortKey === 'realizedMoic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(realizedMoic(groupTotals))}</td>
                    if (col.sortKey === 'unrealizedMoic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(unrealizedMoic(groupTotals))}</td>
                    return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtVal(col.getValue(groupTotals), col.format)}</td>
                  })}
                </tr>
              </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Company table */}
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted">
              <th className="text-left px-3 py-2 font-medium sticky left-0 bg-muted z-10">
                <button onClick={() => handleSort('companyName')} className="hover:text-foreground">
                  Holding<SortIcon col="companyName" />
                </button>
              </th>
              <th className="text-left px-3 py-2 font-medium">Kind</th>
              <th className="text-left px-3 py-2 font-medium">
                <button onClick={() => handleSort('status')} className="hover:text-foreground">
                  Status<SortIcon col="status" />
                </button>
              </th>
              <th className="text-left px-3 py-2 font-medium">
                <button onClick={() => handleSort('portfolioGroup')} className="hover:text-foreground">
                  Vehicle<SortIcon col="portfolioGroup" />
                </button>
              </th>
              {companyColumns.map(col => (
                <th key={col.sortKey} className="text-right px-3 py-2 font-medium">
                  <button onClick={() => handleSort(col.sortKey as SortKey)} className="hover:text-foreground">
                    {col.label}<SortIcon col={col.sortKey as SortKey} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const pctUnr = pctOfGroupUnrealized(c)
              const pctTV = pctOfGroupTotalValue(c)
              return (
              <tr key={`${c.companyId}-${c.portfolioGroup.join('')}`} className="border-b last:border-b-0 hover:bg-muted/30">
                <td className="px-3 py-2 sticky left-0 bg-background z-10">
                  <Link
                    href={holdingHref(c.companyId)}
                    className="font-medium hover:underline"
                  >
                    {c.companyName}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{KIND_LABELS[c.holdingType ?? 'company']}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs capitalize ${STATUS_COLORS[c.status]}`}>
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.portfolioGroup.length > 0 ? c.portfolioGroup.join(', ') : '-'}
                </td>
                {companyColumns.map(col => {
                  if (col.type === 'pct') {
                    const val = col.sortKey === 'pctUnrealized' ? pctUnr : pctTV
                    return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{val != null ? `${(val * 100).toFixed(1)}%` : '-'}</td>
                  }
                  const numCol = numericColumns[col.colIdx!]
                  return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtVal(numCol.getValue(c), numCol.format)}</td>
                })}
              </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted font-medium">
              <td className="px-3 py-2 sticky left-0 bg-muted z-10">Total ({filtered.length})</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              {companyColumns.map(col => {
                if (col.type === 'pct') return <td key={col.sortKey} className="px-3 py-2" />
                const numCol = numericColumns[col.colIdx!]
                if (numCol.format === 'irr') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtIrr(data.portfolioIRR)}</td>
                if (numCol.sortKey === 'moic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(totals.moic)}</td>
                if (numCol.sortKey === 'realizedMoic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(realizedMoic(totals))}</td>
                if (numCol.sortKey === 'unrealizedMoic') return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtMoic(unrealizedMoic(totals))}</td>
                return <td key={col.sortKey} className="px-3 py-2 text-right tabular-nums">{fmtVal(numCol.getValue(totals), numCol.format)}</td>
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
    <PortfolioNotesPanel />
    <AnalystPanel />
    </div>
    </div>
    {editingVehicle && (
      <VehicleEditModal
        vehicle={editingVehicle}
        onClose={() => setEditingVehicle(null)}
        onSaved={() => { setEditingVehicle(null); setRefreshKey(k => k + 1) }}
      />
    )}
    {linkingGroup && (
      <VehicleLinkModal
        group={linkingGroup}
        vehicles={vehicleList.map(v => ({ id: v.id, name: v.name, aliases: v.aliases ?? [] }))}
        onClose={() => setLinkingGroup(null)}
        onSaved={() => { setLinkingGroup(null); setRefreshKey(k => k + 1) }}
      />
    )}
    </PortfolioNotesProvider>
  )
}
