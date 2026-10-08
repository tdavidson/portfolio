import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { allQuotes } from './quote-read'

describe('allQuotes', () => {
  it('returns every quote when the API row cap is below the page size', async () => {
    const rows = Array.from({ length: 1300 }, (_, i) => ({
      fund_id: 'f', feed_id: 'pf', as_of_date: new Date(Date.UTC(2022, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), price: i, basis: 'close',
    }))
    const { admin } = memoryAdmin({ price_observations: rows }, { maxRows: 500 })
    const out = await allQuotes(admin as any, 'f', ['pf'])
    expect(out).toHaveLength(1300)
    expect(out[out.length - 1].price).toBe(1299)
  })

  it('throws on a failed read rather than returning none', async () => {
    const m = memoryAdmin({ price_observations: [] })
    m.failNext('price_observations', 'select', 'boom')
    await expect(allQuotes(m.admin as any, 'f', ['pf'])).rejects.toThrow('quotes read failed: boom')
  })
})
