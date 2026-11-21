// app/(app)/companies/[id]/holding-panels.test.ts
import { describe, it, expect } from 'vitest'
import { holdingPanels, holdingSections, needsEntities, initialEntity, initialAsOf, quoteBasisNote, chainVarianceText } from './holding-panels'

describe('holdingPanels', () => {
  it('a company keeps its profile and may carry a price feed', () => {
    expect(holdingPanels('company')).toEqual({ aiSummary: true, metricCharts: true, companyProfile: true, register: false, updates: true, wallets: false, priceFeed: true, units: false })
  })
  it('a fund holding shows its register, an AI summary and any KPI charts, not a company profile', () => {
    expect(holdingPanels('fund')).toEqual({ aiSummary: true, metricCharts: true, companyProfile: false, register: true, updates: false, wallets: false, priceFeed: false, units: false })
  })
  it('a digital asset shows its units, its wallets and its price feed', () => {
    expect(holdingPanels('crypto')).toEqual({ aiSummary: false, metricCharts: false, companyProfile: false, register: false, updates: false, wallets: true, priceFeed: true, units: true })
  })
  it('a row from before the discriminator reads as a company', () => {
    expect(holdingPanels(undefined)).toEqual(holdingPanels('company'))
  })
})

describe('holdingSections', () => {
  it('keeps metrics and the analyst on when nothing was set', () => {
    expect(holdingSections('company', {}, false)).toEqual({ metrics: true, analyst: true, priceFeed: false })
    expect(holdingSections('fund', undefined, false)).toEqual({ metrics: true, analyst: true, priceFeed: false })
  })
  it('hides metrics and the analyst a holding turned off', () => {
    expect(holdingSections('fund', { metrics_enabled: false, analyst_enabled: false }, false)).toEqual({ metrics: false, analyst: false, priceFeed: false })
  })
  it('shows a company\'s price feed only once turned on, or when it already has one', () => {
    expect(holdingSections('company', { price_feed_enabled: true }, false).priceFeed).toBe(true)
    expect(holdingSections('company', { price_feed_enabled: false }, true).priceFeed).toBe(true)
  })
  it('always shows a digital asset\'s feed, and never a fund holding\'s', () => {
    expect(holdingSections('crypto', {}, false).priceFeed).toBe(true)
    expect(holdingSections('fund', { price_feed_enabled: true }, true).priceFeed).toBe(false)
  })
  it('a setting cannot add a section the kind does not have', () => {
    expect(holdingSections('crypto', { metrics_enabled: true, analyst_enabled: true }, false)).toMatchObject({ metrics: false, analyst: false })
  })
})

describe('needsEntities', () => {
  it('reads the entities only for the per-entity panels — never for a company', () => {
    expect(needsEntities('company')).toBe(false)
    expect(needsEntities(null)).toBe(false)
    expect(needsEntities('fund')).toBe(true)
    expect(needsEntities('crypto')).toBe(true)
  })
})

describe('initialEntity', () => {
  const two = [{ id: 'v1' }, { id: 'v2' }]
  it('opens on the entity a link named, when the viewer has it', () => {
    expect(initialEntity(two, 'v2')).toBe('v2')
  })
  it('ignores an entity the viewer does not have', () => {
    expect(initialEntity(two, 'v9')).toBeNull()
  })
  it('opens on the only entity there is', () => {
    expect(initialEntity([{ id: 'v1' }], null)).toBe('v1')
  })
})

describe('initialAsOf', () => {
  it('opens on the date a link named — the period end the close is missing a mark for', () => {
    expect(initialAsOf('2026-03-31')).toBe('2026-03-31')
  })
  it('ignores anything that is not one real date, and opens on today instead', () => {
    expect(initialAsOf(undefined)).toBeNull()
    expect(initialAsOf('2026-02-30')).toBeNull()
    expect(initialAsOf('31/03/2026')).toBeNull()
    expect(initialAsOf(['2026-03-31', '2026-06-30'])).toBeNull()
  })
})

describe('quoteBasisNote', () => {
  it('names the basis a mark rests on, never a bare level', () => {
    expect(quoteBasisNote(null)).toBe('No quote stored yet')
    expect(quoteBasisNote({ as_of_date: '2026-03-31', basis: 'close' })).toBe('Official close, 2026-03-31')
    expect(quoteBasisNote({ as_of_date: '2026-03-31', basis: 'intraday' })).toBe('Intraday price, 2026-03-31 — Level 2, not an official close')
  })
})

describe('chainVarianceText', () => {
  it('says which way the chain and the books disagree, for which entity', () => {
    expect(chainVarianceText({ entity: 'Fund I', observedUnits: 12, recordedUnits: 10, delta: 2, asOf: '2026-03-31' }))
      .toBe('Fund I: the chain shows 12 units at 2026-03-31, the books record 10 — 2 more on-chain than recorded.')
    expect(chainVarianceText({ entity: 'Fund II', observedUnits: 8, recordedUnits: 10, delta: -2, asOf: '2026-03-31' }))
      .toBe('Fund II: the chain shows 8 units at 2026-03-31, the books record 10 — 2 fewer on-chain than recorded.')
  })
})
