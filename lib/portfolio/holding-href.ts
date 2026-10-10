/**
 * Where a holding lives. Companies, fund holdings and digital assets all open on /companies/[id]
 * (plans/spec-ledger-one-writer.md §6). `vehicleId` opens the page on one entity's view of it —
 * the fund register is kept per (holding, entity). `asOf` opens it on a date: the close's quote
 * blocker links with the period end, so the mark the page offers is the one the close is missing.
 */
export function holdingHref(companyId: string, vehicleId?: string | null, asOf?: string | null): string {
  const base = `/companies/${encodeURIComponent(companyId)}`
  const qs = [
    vehicleId ? `entity=${encodeURIComponent(vehicleId)}` : null,
    asOf ? `asOf=${encodeURIComponent(asOf)}` : null,
  ].filter(Boolean)
  return qs.length > 0 ? `${base}?${qs.join('&')}` : base
}

/**
 * A deal vehicle carried at its LP positions (no recorded holdings; app/api/portfolio/investments)
 * has no holding page: its row id is this prefix plus the vehicle id, and it opens on the entity.
 */
export const DEAL_VEHICLE_PREFIX = 'vehicle:'

/** Where an Investments row opens: the holding's page, or the entity's for a deal vehicle. */
export function investmentHref(rowId: string): string {
  return rowId.startsWith(DEAL_VEHICLE_PREFIX) ? `/funds/${encodeURIComponent(rowId.slice(DEAL_VEHICLE_PREFIX.length))}` : holdingHref(rowId)
}

/** A schedule-of-investments row's link, on the entity the schedule is for. Null for a pooled
 *  ledger-only row, which names no holding. */
export function soiRowHref(row: { companyId?: string | null }, vehicleId?: string | null): string | null {
  return row.companyId ? holdingHref(row.companyId, vehicleId) : null
}

/**
 * Where a holding is deleted. A fund holding has its own route, which checks its register (capital
 * events and NAV statements on the ledger); a company or a digital asset goes through the
 * companies route, which checks its transactions and postings.
 */
export function holdingDeletePath(companyId: string, holdingType: 'company' | 'fund' | 'crypto' | null | undefined): string {
  const id = encodeURIComponent(companyId)
  return holdingType === 'fund' ? `/api/portfolio/fund-holdings/${id}` : `/api/companies/${id}`
}
