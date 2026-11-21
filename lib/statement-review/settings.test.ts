import { describe, expect, it } from 'vitest'
import { cleanSettings } from './settings'
import { DEFAULT_SETTINGS } from './types'

describe('cleanSettings', () => {
  it('reads every part, snake or camel case', () => {
    const s = cleanSettings({
      materiality: { amount: '1,000', nav_share: 0.005 },
      instructions: '  Check the fee offset every quarter.  ',
      watch_accounts: [{ account: '5100', note: 'fee offsets', threshold: '2,500' }, '2100'],
      adjustments: [{ description: 'Wire in transit at quarter end', check: 'cash', amount: '(1,250.00)' }],
    })
    expect(s).toEqual({
      materiality: { amount: 1_000, navShare: 0.005 },
      instructions: 'Check the fee offset every quarter.',
      watchAccounts: [{ account: '5100', note: 'fee offsets', threshold: 2_500 }, { account: '2100' }],
      adjustments: [{ description: 'Wire in transit at quarter end', check: 'cash', amount: -1_250 }],
    })
  })

  it('keeps what a caller leaves out', () => {
    const current = { ...DEFAULT_SETTINGS, instructions: 'Keep me', watchAccounts: [{ account: '5100' }] }
    expect(cleanSettings({ materiality: { amount: 500 } }, current)).toMatchObject({ instructions: 'Keep me', watchAccounts: [{ account: '5100' }], materiality: { amount: 500 } })
  })

  it('refuses an adjustment that names neither a subject nor an amount', () => {
    expect(cleanSettings({ adjustments: [{ description: 'Everything in cash is fine', check: 'cash' }] })).toMatch(/subject .* or an amount/)
  })

  it('refuses an unknown check and a bad amount', () => {
    expect(cleanSettings({ adjustments: [{ description: 'x', check: 'vibes', subject: 'Acme' }] })).toMatch(/check must be one of/)
    expect(cleanSettings({ watch_accounts: [{ account: '5100', threshold: 'big' }] })).toMatch(/threshold must be an amount/)
    expect(cleanSettings({ watch_accounts: [{ note: 'no account' }] })).toMatch(/account is required/)
  })
})
