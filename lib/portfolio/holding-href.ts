/**
 * Where a holding lives. Companies, fund holdings and digital assets all open on /companies/[id]
 * (plans/spec-ledger-one-writer.md §6). `vehicleId` opens the page on one entity's view of it —
 * the fund register is kept per (holding, entity).
 */
export function holdingHref(companyId: string, vehicleId?: string | null): string {
  const base = `/companies/${encodeURIComponent(companyId)}`
  return vehicleId ? `${base}?entity=${encodeURIComponent(vehicleId)}` : base
}

/** A schedule-of-investments row's link, on the entity the schedule is for. Null for a pooled
 *  ledger-only row, which names no holding. */
export function soiRowHref(row: { companyId?: string }, vehicleId?: string | null): string | null {
  return row.companyId ? holdingHref(row.companyId, vehicleId) : null
}
