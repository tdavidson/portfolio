// Invented figures for the check tests: Example Fund I with two partners, round numbers that roll.

import { contextFor } from '../compare'
import type { PartnerStatement, StatementPackage } from '../types'

export const ctx = contextFor({ amount: 100, navShare: 0 }, null)

export function acme(over: Partial<PartnerStatement> = {}): PartnerStatement {
  return {
    externalId: 'p-1', name: 'Acme Partners LP', lpEntityId: 'lp-acme',
    commitment: 1_000_000, beginning: 500_000, contributions: 100_000, distributions: 50_000,
    allocations: { income: 10_000, expenses: -5_000, managementFee: -5_000, unrealized: 40_000 },
    ending: 590_000, unfunded: 400_000, paidInToDate: 600_000, distributedToDate: 50_000,
    cite: { ending: { document: 'Q3 statements.pdf', page: 4, label: 'Ending capital' } },
    ...over,
  }
}

export function northwind(over: Partial<PartnerStatement> = {}): PartnerStatement {
  return {
    externalId: 'p-2', name: 'Northwind Capital', lpEntityId: 'lp-northwind',
    commitment: 500_000, beginning: 250_000, contributions: 50_000, distributions: 25_000,
    allocations: { income: 5_000, expenses: -2_500, managementFee: -2_500, unrealized: 20_000 },
    ending: 295_000, unfunded: 200_000, paidInToDate: 300_000, distributedToDate: 25_000,
    ...over,
  }
}

export function pkg(over: Partial<StatementPackage> = {}): StatementPackage {
  return {
    vehicleId: 'veh-1', periodStart: '2026-07-01', periodEnd: '2026-09-30', source: 'administrator', documents: [],
    partners: [acme(), northwind()],
    ...over,
  }
}
