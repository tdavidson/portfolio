import { describe, expect, it } from 'vitest'
import { cashCapitalSource } from './cash-capital-source'

const accounts = [
  { id: 'cash', code: '1000', subtype: 'cash' },
  { id: 'due', code: '1300', subtype: 'receivable' },
  { id: 'ar', code: '1100', subtype: 'receivable' },
  { id: 'capA', code: '3100-a', subtype: 'lp_capital' },
  { id: 'capB', code: '3100-b', subtype: 'lp_capital' },
  { id: 'fee', code: '5000', subtype: 'management_fee' },
]

describe('cashCapitalSource', () => {
  it('reads cash against LP capital as a contribution or a distribution', () => {
    expect(cashCapitalSource([{ accountId: 'cash', amount: 100_000 }, { accountId: 'capA', amount: -100_000 }], accounts)).toBe('contribution')
    expect(cashCapitalSource([{ accountId: 'cash', amount: -50_000 }, { accountId: 'capA', amount: 50_000 }], accounts)).toBe('distribution')
  })

  it('reads a call recognized against Due from LPs as called capital', () => {
    expect(cashCapitalSource([
      { accountId: 'due', amount: 150_000 },
      { accountId: 'capA', amount: -100_000 },
      { accountId: 'capB', amount: -50_000 },
    ], accounts)).toBe('capital_call')
  })

  it('reads a call reversal and a transfer of called capital the same way', () => {
    expect(cashCapitalSource([{ accountId: 'capA', amount: 10_000 }, { accountId: 'due', amount: -10_000 }], accounts)).toBe('capital_call')
    expect(cashCapitalSource([
      { accountId: 'capA', amount: 20_000 },
      { accountId: 'capB', amount: -12_000 },
      { accountId: 'due', amount: -8_000 },
    ], accounts)).toBe('capital_call')
  })

  it('leaves other receivables and mixed entries alone', () => {
    expect(cashCapitalSource([{ accountId: 'ar', amount: 10_000 }, { accountId: 'capA', amount: -10_000 }], accounts)).toBeNull()
    expect(cashCapitalSource([
      { accountId: 'due', amount: 10_000 },
      { accountId: 'capA', amount: -9_000 },
      { accountId: 'fee', amount: -1_000 },
    ], accounts)).toBeNull()
    expect(cashCapitalSource([{ accountId: 'capA', amount: 5_000 }, { accountId: 'capB', amount: -5_000 }], accounts)).toBeNull()
  })
})
