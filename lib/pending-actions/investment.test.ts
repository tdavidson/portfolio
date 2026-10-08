import { describe, it, expect } from 'vitest'
import { ledgerEffectText } from './investment'

describe('ledgerEffectText', () => {
  it('a purchase, an exit and a mark all post', () => {
    expect(ledgerEffectText({ transaction_type: 'investment', investment_cost: 100, vehicle: 'Fund I' } as any)).toBe("Posts a journal entry to Fund I's ledger.")
    expect(ledgerEffectText({ transaction_type: 'proceeds', proceeds_received: 100, vehicle: 'Fund I' } as any)).toBe("Posts a journal entry to Fund I's ledger.")
    expect(ledgerEffectText({ transaction_type: 'unrealized_gain_change', vehicle: 'Fund I' } as any)).toBe("Posts a journal entry to Fund I's ledger.")
  })
  it('a round and a split book nothing', () => {
    expect(ledgerEffectText({ transaction_type: 'split' } as any)).toBe('Books nothing — it moves neither value nor cash.')
  })
})
