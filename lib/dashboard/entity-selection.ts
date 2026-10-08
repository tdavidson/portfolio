// Which entities the portfolio dashboard shows.
//
// The options are the viewer's entities that hold at least one ACTIVE position — a company, a fund
// holding or a digital asset (companies.holding_type) — never an entity they cannot see, and never
// one holding nothing live (offering it would be offering an empty filter).
//
// Both the person's saved selection and the fund-wide default are stored as EXCLUDED entity ids, so
// an entity created later appears by default rather than silently missing from everyone's view.
//
// Resolution: the person's saved selection (a row exists, even an empty one meaning "all") → the
// fund default an admin set → every option.

import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { effectiveCompanyStatus } from '@/lib/investments'
import type { CompanyStatus, InvestmentTransaction } from '@/lib/types/database'

export const DASHBOARD_HOLDING_TYPES = ['company', 'fund', 'crypto'] as const

export interface EntityOption {
  id: string
  name: string
  /** The name and its legacy aliases — the strings `portfolio_group` may carry for this entity. */
  names: string[]
}

export interface EntityVehicle { id: string; name: string; aliases?: string[] | null; kind?: string | null }
export interface EntityHolding { companyId: string; vehicleId: string }
export interface EntityHoldingCompany { id: string; status: string; holdingType: string }

/**
 * The entities to offer: visible to the viewer, and holding at least one active position. A holding
 * whose company column says 'active' but whose transactions IN THAT ENTITY close the position out is
 * not active there (the same rule the dashboard uses to show a company as exited).
 */
export function activeEntityOptions(input: {
  access: Pick<AccessContext, 'vehicles'>
  vehicles: EntityVehicle[]
  holdings: EntityHolding[]
  companies: EntityHoldingCompany[]
  transactionsByCompany?: Map<string, InvestmentTransaction[]>
  /** Management companies are listed only to a viewer holding that domain, like every entity list. */
  includeManagementCompanies?: boolean
}): EntityOption[] {
  const companies = new Map(input.companies.map(c => [c.id, c]))
  const visible = input.vehicles.filter(v =>
    canSeeVehicle(input.access, v.id) && (input.includeManagementCompanies !== false || v.kind !== 'manco'))
  const byId = new Map(visible.map(v => [v.id, v]))

  const active = new Set<string>()
  for (const h of input.holdings) {
    if (active.has(h.vehicleId)) continue
    const v = byId.get(h.vehicleId)
    const c = companies.get(h.companyId)
    if (!v || !c) continue
    if (!(DASHBOARD_HOLDING_TYPES as readonly string[]).includes(c.holdingType)) continue
    if (c.status !== 'active') continue
    const names = vehicleNames(v)
    const txns = (input.transactionsByCompany?.get(c.id) ?? [])
      .filter(t => t.portfolio_group == null || names.includes(t.portfolio_group))
    if (effectiveCompanyStatus(txns, 'active' as CompanyStatus) !== 'active') continue
    active.add(v.id)
  }

  return visible
    .filter(v => active.has(v.id))
    .map(v => ({ id: v.id, name: v.name, names: vehicleNames(v) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function vehicleNames(v: EntityVehicle): string[] {
  return Array.from(new Set([v.name, ...(v.aliases ?? [])]))
}

export type SelectionSource = 'saved' | 'fund' | 'all'

/**
 * The exclusions in force for this viewer, and where they came from. Only ids among the options
 * count — an exclusion of an entity the viewer cannot see, or one holding nothing live, says nothing
 * about their view. A selection that would leave NOTHING shown (every option excluded — say, a fund
 * default excluding the one entity a restricted member holds) falls back to all of them: an empty
 * dashboard is never the right default.
 */
export function resolveExcluded(input: {
  options: EntityOption[]
  /** The person's saved exclusions; null when they have never saved a selection. */
  saved: string[] | null
  fundDefault: string[] | null
}): { excluded: string[]; source: SelectionSource } {
  const ids = new Set(input.options.map(o => o.id))
  const pick = (list: string[]) => list.filter(id => ids.has(id))
  let excluded: string[]
  let source: SelectionSource
  if (input.saved !== null) {
    excluded = pick(input.saved); source = 'saved'
  } else if (input.fundDefault && input.fundDefault.length > 0) {
    excluded = pick(input.fundDefault); source = 'fund'
  } else {
    excluded = []; source = 'all'
  }
  if (input.options.length > 0 && excluded.length >= input.options.length) return { excluded: [], source }
  return { excluded, source }
}

/** The button's label: "All entities", the one name, or "3 entities". */
export function selectionLabel(options: EntityOption[], excluded: string[]): string {
  const selected = options.filter(o => !excluded.includes(o.id))
  if (selected.length === options.length) return 'All entities'
  if (selected.length === 1) return selected[0].name
  return `${selected.length} entities`
}

/**
 * Does a company stay on the dashboard? It is hidden only when every entity it belongs to is
 * excluded. A company in no entity, or in an entity that is not an option (one holding nothing
 * live, so it could not be excluded), stays.
 */
export function companyInSelection(
  portfolioGroup: string[] | null,
  options: EntityOption[],
  excluded: string[],
): boolean {
  if (excluded.length === 0) return true
  const groups = portfolioGroup ?? []
  if (groups.length === 0) return true
  const excludedNames = new Set(options.filter(o => excluded.includes(o.id)).flatMap(o => o.names))
  return groups.some(g => !excludedNames.has(g))
}

/** Normalise a request body's id list: strings only, de-duplicated. Null when it is not a list. */
export function parseIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.some(x => typeof x !== 'string')) return null
  return Array.from(new Set(raw as string[]))
}
