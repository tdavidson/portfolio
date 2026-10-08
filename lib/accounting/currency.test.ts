import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { fundCurrency, forgetFundCurrency } from './currency'

describe('fundCurrency', () => {
  it('reads the fund setting, and a fund with none is USD', async () => {
    const m = memoryAdmin({ fund_settings: [{ fund_id: 'eur', currency: 'EUR' }] })
    expect(await fundCurrency(m.admin, 'eur')).toBe('EUR')
    expect(await fundCurrency(m.admin, 'none')).toBe('USD')
    forgetFundCurrency('eur'); forgetFundCurrency('none')
  })
  it('throws on a failed read and does not cache the failure', async () => {
    const m = memoryAdmin({ fund_settings: [{ fund_id: 'f2', currency: 'EUR' }] })
    m.failNext('fund_settings', 'select', 'db down')
    await expect(fundCurrency(m.admin, 'f2')).rejects.toThrow(/could not be read: db down/)
    // The next call reads again and gets the real currency — not a cached USD.
    expect(await fundCurrency(m.admin, 'f2')).toBe('EUR')
    forgetFundCurrency('f2')
  })
  it('caches a successful read', async () => {
    const m = memoryAdmin({ fund_settings: [{ fund_id: 'f3', currency: 'GBP' }] })
    expect(await fundCurrency(m.admin, 'f3')).toBe('GBP')
    m.tables.fund_settings[0].currency = 'EUR'
    expect(await fundCurrency(m.admin, 'f3')).toBe('GBP')
    forgetFundCurrency('f3')
    expect(await fundCurrency(m.admin, 'f3')).toBe('EUR')
    forgetFundCurrency('f3')
  })
})
