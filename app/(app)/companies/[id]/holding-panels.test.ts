// app/(app)/companies/[id]/holding-panels.test.ts
import { describe, it, expect } from 'vitest'
import { holdingPanels, initialEntity, quoteBasisNote, chainVarianceText } from './holding-panels'

describe('holdingPanels', () => {
  it('a company keeps its profile and may carry a price feed', () => {
    expect(holdingPanels('company')).toEqual({ companyProfile: true, register: false, wallets: false, priceFeed: true, units: false })
  })
  it('a fund holding shows its register, not a company profile', () => {
    expect(holdingPanels('fund')).toEqual({ companyProfile: false, register: true, wallets: false, priceFeed: false, units: false })
  })
  it('a digital asset shows its units, its wallets and its price feed', () => {
    expect(holdingPanels('crypto')).toEqual({ companyProfile: false, register: false, wallets: true, priceFeed: true, units: true })
  })
  it('a row from before the discriminator reads as a company', () => {
    expect(holdingPanels(undefined)).toEqual(holdingPanels('company'))
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
