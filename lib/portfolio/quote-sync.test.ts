import { describe, it, expect } from 'vitest'
import { syncableFeeds } from './quote-sync'
import { resolveQuotes, providerFor, PROVIDER_NAMES } from './quote-providers'
import type { PriceFeed } from './quotes'

const feed = (o: Partial<PriceFeed> = {}): PriceFeed => ({
  id: 'f1', companyId: 'c1', kind: 'listed_equity', symbol: 'AAPL',
  exchange: 'NASDAQ', quoteCurrency: 'USD', quoteScale: 1,
  activeFrom: '2026-01-01', activeUntil: null,
  restrictionUntil: null, restrictionDiscount: null,
  ...o,
})

describe('syncableFeeds', () => {
  it('skips a manually priced feed — nothing to ask a provider', () => {
    const feeds = [feed({ id: 'a' }), feed({ id: 'b' })]
    const providers = new Map([['a', 'manual'], ['b', 'some_vendor']])
    expect(syncableFeeds(feeds, providers, '2026-03-31').map(f => f.id)).toEqual(['b'])
  })

  it('treats an unconfigured feed as manual rather than guessing a provider', () => {
    expect(syncableFeeds([feed()], new Map(), '2026-03-31')).toEqual([])
  })

  it('skips a feed that is not active today', () => {
    const providers = new Map([['f1', 'some_vendor']])
    expect(syncableFeeds([feed({ activeFrom: '2026-06-01' })], providers, '2026-03-31')).toEqual([])
    expect(syncableFeeds([feed({ activeUntil: '2026-02-01' })], providers, '2026-03-31')).toEqual([])
  })
})

describe('provider registry', () => {
  it('falls back to manual for an unknown provider instead of throwing', () => {
    expect(providerFor('a-vendor-we-dropped').name).toBe('manual')
    expect(providerFor(null).name).toBe('manual')
  })

  it('always offers hand entry', () => {
    expect(PROVIDER_NAMES).toContain('manual')
  })

  it('never calls a provider for manual feeds', async () => {
    const { quotes, errors } = await resolveQuotes(
      [feed()], { fundId: 'f' }, new Map([['f1', 'manual']]),
    )
    expect(quotes).toEqual([])
    expect(errors).toEqual([])
  })

  it('returns nothing rather than throwing for an unregistered provider', () => {
    // A feed left pointing at a vendor that has since been removed must not break a sync run.
    expect(providerFor('a-vendor-we-dropped').name).toBe('manual')
  })
})
