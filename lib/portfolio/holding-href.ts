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
