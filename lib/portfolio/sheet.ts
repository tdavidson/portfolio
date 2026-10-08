// The portfolio sheet: every holding the viewer's entities hold — companies (listed stocks among
// them), fund holdings and digital assets — one row each, sectioned by kind.
//
// Built FROM the schedule of investments, per entity, so the management view and the accounting
// statement read the same positions and cannot disagree about cost or fair value. The sheet adds
// what accounting does not carry: stage, cash, last report, a listed stock's ticker.
//
// One entity: that entity's sheet (GET /api/portfolio/sheet?group=). Several: the viewer's aggregate
// (`/dashboard`) — a company two of their entities hold is ONE row, summed, naming both. An entity
// the viewer cannot see never reaches this function, so it cannot leak through a sum.

import type { SoiRow } from '@/lib/accounting/statements'

export type HoldingKind = 'company' | 'fund' | 'crypto'

export interface ListedQuote { symbol: string; price: number | null; asOf: string | null }

export interface CompanyMeta {
  stage?: string | null
  status?: string | null
  latestCash?: number | null
  lastReportAt?: string | null
}

export interface SheetRow {
  key: string
  companyId: string | null
  name: string
  kind: HoldingKind
  /** The viewer's entities that hold it. */
  vehicles: string[]
  cost: number
  fairValue: number
  invested: number
  distributions: number
  /** (distributions + fair value) / invested, over the combined position. */
  moic: number | null
  /** Companies */
  listed: ListedQuote | null
  stage: string | null
  status: string | null
  latestCash: number | null
  lastReportAt: string | null
  /** Funds */
  commitment: number
  called: number
  unfunded: number
  navAsOf: string | null
  /** Digital assets (and share counts generally) */
  units: number | null
  price: number | null
}

export interface SectionTotals { cost: number; fairValue: number; commitment: number; called: number; unfunded: number }

export interface PortfolioSheet {
  companies: SheetRow[]
  funds: SheetRow[]
  crypto: SheetRow[]
  sectionTotals: Record<'companies' | 'funds' | 'crypto', SectionTotals>
  totals: { cost: number; fairValue: number }
  /** Set when listed prices could not be read, so the sheet says so rather than showing none. */
  quoteWarning?: string
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const zeroTotals = (): SectionTotals => ({ cost: 0, fairValue: 0, commitment: 0, called: 0, unfunded: 0 })

export function buildPortfolioSheet(input: {
  byVehicle: { vehicle: string; rows: SoiRow[] }[]
  meta?: Map<string, CompanyMeta>
  quotes?: Map<string, ListedQuote>
}): PortfolioSheet {
  const rows = new Map<string, SheetRow>()

  for (const { vehicle, rows: soi } of input.byVehicle) {
    for (const r of soi) {
      const key = r.companyId ?? `name:${r.name}`
      const kind: HoldingKind = r.holdingType ?? 'company'
      const existing = rows.get(key)
      const row: SheetRow = existing ?? {
        key, companyId: r.companyId ?? null, name: r.name, kind, vehicles: [],
        cost: 0, fairValue: 0, invested: 0, distributions: 0, moic: null,
        listed: null, stage: r.stage ?? null, status: r.status ?? null, latestCash: null, lastReportAt: null,
        commitment: 0, called: 0, unfunded: 0, navAsOf: null, units: null, price: null,
      }
      if (!row.vehicles.includes(vehicle)) row.vehicles.push(vehicle)
      row.cost += n(r.cost)
      row.fairValue += n(r.fairValue)
      row.invested += n(r.invested ?? r.cost)
      row.distributions += n(r.distributions)
      row.commitment += n(r.commitment)
      row.called += n(r.called)
      row.unfunded += n(r.unfunded)
      // The newest statement across entities carries the position.
      if (r.navAsOf && (!row.navAsOf || r.navAsOf > row.navAsOf)) row.navAsOf = r.navAsOf
      if (r.shares != null) row.units = n(row.units) + r.shares
      if (r.sharePrice != null) row.price = r.sharePrice
      rows.set(key, row)
    }
  }

  for (const row of rows.values()) {
    row.vehicles.sort()
    row.moic = row.invested > 0 ? (row.distributions + row.fairValue) / row.invested : null
    const meta = row.companyId ? input.meta?.get(row.companyId) : undefined
    if (meta) {
      row.stage = meta.stage ?? row.stage
      row.status = meta.status ?? row.status
      row.latestCash = meta.latestCash ?? null
      row.lastReportAt = meta.lastReportAt ?? null
    }
    if (row.companyId && row.kind === 'company') row.listed = input.quotes?.get(row.companyId) ?? null
  }

  const byName = (a: SheetRow, b: SheetRow) => a.name.localeCompare(b.name)
  const all = Array.from(rows.values()).sort(byName)
  const companies = all.filter(r => r.kind === 'company')
  const funds = all.filter(r => r.kind === 'fund')
  const crypto = all.filter(r => r.kind === 'crypto')

  const total = (rs: SheetRow[]): SectionTotals => rs.reduce((t, r) => ({
    cost: t.cost + r.cost, fairValue: t.fairValue + r.fairValue,
    commitment: t.commitment + r.commitment, called: t.called + r.called, unfunded: t.unfunded + r.unfunded,
  }), zeroTotals())

  const sectionTotals = { companies: total(companies), funds: total(funds), crypto: total(crypto) }
  return {
    companies, funds, crypto, sectionTotals,
    totals: {
      cost: sectionTotals.companies.cost + sectionTotals.funds.cost + sectionTotals.crypto.cost,
      fairValue: sectionTotals.companies.fairValue + sectionTotals.funds.fairValue + sectionTotals.crypto.fairValue,
    },
  }
}
