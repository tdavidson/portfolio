import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Each holding is created, recorded and configured on its own page; nothing about a single holding
 * is configured on /funds/[id]/status (plans/spec-ledger-one-writer.md §6).
 */
describe('the status page configures no single holding', () => {
  it('has no price-feed or wallet panel', () => {
    expect(readFileSync('app/(app)/funds/status/view.tsx', 'utf8')).not.toMatch(/PriceFeedsPanel|WalletsPanel/)
    expect(existsSync('app/(app)/funds/status/price-feeds-panel.tsx')).toBe(false)
    expect(existsSync('app/(app)/funds/status/wallets-panel.tsx')).toBe(false)
  })

  it('has no fund-wide feed, wallet or quote-mark routes — they live on the holding', () => {
    for (const r of ['crypto-wallets', 'price-feeds', 'quote-marks']) {
      expect(existsSync(`app/api/accounting/${r}/route.ts`), r).toBe(false)
    }
  })
})
