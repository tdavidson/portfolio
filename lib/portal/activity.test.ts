import { describe, expect, it } from 'vitest'
import { buildActivity, activityKind } from './activity'

const names = new Map([['e1', 'Example Trust'], ['e2', 'Example IRA']])

describe('activityKind', () => {
  it('reads calls, distributions and both kinds of transfer from the investor side', () => {
    expect(activityKind({ sourceType: 'capital_call', amount: -100 })).toBe('contribution')
    expect(activityKind({ sourceType: 'distribution', amount: 100 })).toBe('distribution')
    expect(activityKind({ sourceType: 'transfer', amount: -100 })).toBe('transfer_in')
    expect(activityKind({ sourceType: 'transfer', amount: 100 })).toBe('transfer_out')
    expect(activityKind({ sourceType: 'secondary_transfer', amount: -100 })).toBe('secondary_purchase')
    expect(activityKind({ sourceType: 'secondary_transfer', amount: 100 })).toBe('secondary_sale')
  })

  it('leaves out fees, marks and gains, which are not movements the investor made', () => {
    for (const sourceType of ['management_fee', 'valuation', 'realized_gain', 'income', 'manual']) {
      expect(activityKind({ sourceType, amount: 100 })).toBeNull()
    }
  })
})

describe('buildActivity', () => {
  it('sums one entry split across lines, newest first, without any memo', () => {
    const lines = buildActivity([{ vehicle: 'Example Fund I', positions: [], postings: [
      { lpEntityId: 'e1', entryDate: '2024-01-15', sourceType: 'capital_call', amount: -100_000 },
      { lpEntityId: 'e1', entryDate: '2024-06-30', sourceType: 'distribution', amount: 30_000 },
      { lpEntityId: 'e1', entryDate: '2024-06-30', sourceType: 'distribution', amount: 10_000 },
      { lpEntityId: 'e1', entryDate: '2024-06-30', sourceType: 'valuation', amount: -5_000 },
    ] }], names)
    expect(lines).toEqual([
      expect.objectContaining({ date: '2024-06-30', kind: 'distribution', label: 'Distribution', amount: 40_000, detail: 'transaction' }),
      expect.objectContaining({ date: '2024-01-15', kind: 'contribution', label: 'Capital call', amount: 100_000 }),
    ])
    expect(Object.keys(lines[0])).not.toContain('memo')
  })

  it("never shows another partner's postings", () => {
    const lines = buildActivity([{ vehicle: 'Example Fund I', positions: [], postings: [
      { lpEntityId: 'someone-else', entryDate: '2024-01-15', sourceType: 'capital_call', amount: -100_000 },
    ] }], names)
    expect(lines).toEqual([])
  })

  it('shows quarterly changes for a vehicle tracked by positions', () => {
    const lines = buildActivity([{ vehicle: 'Example Fund II', postings: [], positions: [
      { lpEntityId: 'e2', asOfDate: '2024-03-31', commitment: 100, calledCapital: 40, distributions: 0, nav: 40 },
      { lpEntityId: 'e2', asOfDate: '2024-06-30', commitment: 100, calledCapital: 60, distributions: 5, nav: 58 },
    ] }], names)
    expect(lines).toEqual([
      expect.objectContaining({ date: '2024-06-30', kind: 'contribution', amount: 20, detail: 'quarterly', since: '2024-03-31' }),
      expect.objectContaining({ date: '2024-06-30', kind: 'distribution', amount: 5, detail: 'quarterly', since: '2024-03-31' }),
    ])
  })

  it('uses statements only after the books stop, so nothing is counted twice', () => {
    const lines = buildActivity([{ vehicle: 'Example Fund I', postings: [
      { lpEntityId: 'e1', entryDate: '2024-06-30', sourceType: 'capital_call', amount: -60 },
    ], positions: [
      { lpEntityId: 'e1', asOfDate: '2024-03-31', commitment: 100, calledCapital: 0, distributions: 0, nav: 0 },
      { lpEntityId: 'e1', asOfDate: '2024-06-30', commitment: 100, calledCapital: 60, distributions: 0, nav: 60 },
    ] }], names)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ detail: 'transaction', amount: 60 })
  })
})
