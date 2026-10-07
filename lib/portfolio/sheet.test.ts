import { describe, it, expect } from 'vitest'
import { buildPortfolioSheet } from './sheet'
import type { SoiRow } from '@/lib/accounting/statements'

const row = (over: Partial<SoiRow>): SoiRow => ({ name: 'X', cost: 0, fairValue: 0, pctOfNetAssets: 0, ...over })

describe('buildPortfolioSheet', () => {
  it('sections holdings by kind — companies, funds, digital assets', () => {
    const sheet = buildPortfolioSheet({
      byVehicle: [{ vehicle: 'Fund I', rows: [
        row({ companyId: 'c1', name: 'Acme', holdingType: 'company', cost: 100, fairValue: 300 }),
        row({ companyId: 'f1', name: 'Manager III', holdingType: 'fund', cost: 50, fairValue: 60, commitment: 200, called: 50, unfunded: 150 }),
        row({ companyId: 't1', name: 'Token', holdingType: 'crypto', cost: 10, fairValue: 40, shares: 4, sharePrice: 10 }),
      ] }],
    })
    expect(sheet.companies.map(r => r.name)).toEqual(['Acme'])
    expect(sheet.funds.map(r => r.name)).toEqual(['Manager III'])
    expect(sheet.crypto.map(r => r.name)).toEqual(['Token'])
    expect(sheet.totals).toMatchObject({ cost: 160, fairValue: 400 })
    expect(sheet.sectionTotals.funds).toMatchObject({ commitment: 200, unfunded: 150 })
  })

  it('combines a company held by two of the viewer\'s entities into one row, naming both', () => {
    const sheet = buildPortfolioSheet({
      byVehicle: [
        { vehicle: 'Fund I', rows: [row({ companyId: 'c1', name: 'Acme', holdingType: 'company', cost: 100, fairValue: 300, invested: 100, distributions: 0 })] },
        { vehicle: 'Fund II', rows: [row({ companyId: 'c1', name: 'Acme', holdingType: 'company', cost: 50, fairValue: 100, invested: 50, distributions: 20 })] },
      ],
    })
    expect(sheet.companies).toHaveLength(1)
    expect(sheet.companies[0]).toMatchObject({ cost: 150, fairValue: 400, vehicles: ['Fund I', 'Fund II'] })
    // MOIC recomputed over the combined position — (distributions + value) / invested — not averaged.
    expect(sheet.companies[0].moic).toBeCloseTo((20 + 400) / 150)
  })

  it('marks a company with a quote source as a listed stock, with its ticker and last price', () => {
    const sheet = buildPortfolioSheet({
      byVehicle: [{ vehicle: 'Fund I', rows: [row({ companyId: 'c1', name: 'Acme', holdingType: 'company', cost: 1, fairValue: 2 })] }],
      quotes: new Map([['c1', { symbol: 'ACME', price: 12.5, asOf: '2026-10-06' }]]),
    })
    expect(sheet.companies[0].listed).toEqual({ symbol: 'ACME', price: 12.5, asOf: '2026-10-06' })
  })

  it('carries the company\'s own metadata — stage, cash, last report — when given', () => {
    const sheet = buildPortfolioSheet({
      byVehicle: [{ vehicle: 'Fund I', rows: [row({ companyId: 'c1', name: 'Acme', holdingType: 'company' })] }],
      meta: new Map([['c1', { stage: 'Series A', status: 'active', latestCash: 5_000_000, lastReportAt: '2026-09-30' }]]),
    })
    expect(sheet.companies[0]).toMatchObject({ stage: 'Series A', latestCash: 5_000_000, lastReportAt: '2026-09-30' })
  })

  it('is empty, not an error, for a viewer with no entities', () => {
    const sheet = buildPortfolioSheet({ byVehicle: [] })
    expect(sheet.companies).toEqual([])
    expect(sheet.totals).toMatchObject({ cost: 0, fairValue: 0 })
  })
})
