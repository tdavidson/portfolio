import { describe, expect, it } from 'vitest'
import { cashCapitalSource } from './cash-capital-source'

const accounts = [
  { id: 'cash', code: '1000', subtype: 'cash' },
  { id: 'due', code: '1300', subtype: 'receivable' },
  { id: 'ar', code: '1100', subtype: 'receivable' },
  { id: 'capA', code: '3100-a', subtype: 'lp_capital' },
  { id: 'capB', code: '3100-b', subtype: 'lp_capital' },
  { id: 'fee', code: '5000', subtype: 'management_fee' },
  { id: 'payable', code: '2300', subtype: 'distributions_payable' },
  { id: 'gp', code: '3000', subtype: 'gp_capital' },
  { id: 'pool', code: '3100', subtype: 'lp_capital' },
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

  describe('a fund administrator\'s whole-fund entries', () => {
    it('reads a distribution declared through Distributions payable, GP leg included', () => {
      expect(cashCapitalSource([
        { accountId: 'capA', amount: 60_000 }, { accountId: 'capB', amount: 30_000 },
        { accountId: 'gp', amount: 10_000 }, { accountId: 'payable', amount: -100_000 },
      ], accounts)).toBe('distribution')
      expect(cashCapitalSource([{ accountId: 'capA', amount: 5_000 }, { accountId: 'payable', amount: -5_000 }], accounts)).toBe('distribution')
    })

    it('reads a call against Due from LPs with GP and unallocated legs as called capital', () => {
      expect(cashCapitalSource([
        { accountId: 'due', amount: 102_000 }, { accountId: 'gp', amount: -2_000 }, { accountId: 'gp', amount: 2_000 },
        { accountId: 'pool', amount: -2_000 }, { accountId: 'capA', amount: -60_000 }, { accountId: 'capB', amount: -40_000 },
      ], accounts)).toBe('capital_call')
    })

    it('reads cash in against partners\' capital as a contribution, even when it clears Due from LPs', () => {
      expect(cashCapitalSource([
        { accountId: 'cash', amount: 105_000 }, { accountId: 'gp', amount: -5_000 }, { accountId: 'capA', amount: -100_000 },
      ], accounts)).toBe('contribution')
      expect(cashCapitalSource([
        { accountId: 'cash', amount: 15_000 }, { accountId: 'due', amount: -10_000 }, { accountId: 'capA', amount: -5_000 },
      ], accounts)).toBe('contribution')
    })

    it('leaves fees, transfers and mixed directions unclassified', () => {
      expect(cashCapitalSource([
        { accountId: 'capA', amount: 10_000 }, { accountId: 'gp', amount: -8_000 }, { accountId: 'fee', amount: -2_000 },
      ], accounts)).toBeNull()
      expect(cashCapitalSource([
        { accountId: 'capA', amount: 10_000 }, { accountId: 'pool', amount: -10_000 }, { accountId: 'gp', amount: 0 },
      ], accounts)).toBeNull()
      expect(cashCapitalSource([
        { accountId: 'capA', amount: 10_000 }, { accountId: 'payable', amount: -6_000 }, { accountId: 'cash', amount: -4_000 }, { accountId: 'due', amount: 0 },
      ], accounts)).toBeNull()
    })

    it('reads the partners\' net when their legs point both ways', () => {
      expect(cashCapitalSource([
        { accountId: 'capA', amount: 12_000 }, { accountId: 'capB', amount: -2_000 }, { accountId: 'payable', amount: -10_000 },
      ], accounts)).toBe('distribution')
      expect(cashCapitalSource([
        { accountId: 'due', amount: 50_000 }, { accountId: 'capA', amount: -55_000 }, { accountId: 'capB', amount: 5_000 },
        { accountId: 'gp', amount: -1_000 }, { accountId: 'gp', amount: 1_000 },
      ], accounts)).toBe('capital_call')
    })
  })
})
