/**
 * Where a holding lives. Companies, fund holdings and digital assets all open on /companies/[id]
 * (plans/spec-ledger-one-writer.md §6). `vehicleId` opens the page on one entity's view of it —
 * the fund register is kept per (holding, entity).
 */
export function holdingHref(companyId: string, vehicleId?: string | null): string {
  const base = `/companies/${encodeURIComponent(companyId)}`
  return vehicleId ? `${base}?entity=${encodeURIComponent(vehicleId)}` : base
}
