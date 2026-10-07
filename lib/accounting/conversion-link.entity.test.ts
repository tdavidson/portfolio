import { describe, it, expect } from 'vitest'
import { validateConversionLink } from './conversion-link'

const txns: Record<string, any> = {
  s1: { id: 's1', company_id: 'c1', transaction_type: 'investment', portfolio_group: 'Fund I' },
  s2: { id: 's2', company_id: 'c1', transaction_type: 'investment', portfolio_group: 'Fund II' },
}
const admin = {
  from: () => {
    const eq: Record<string, any> = {}
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { eq[k] = v; return chain },
      maybeSingle: async () => {
        const t = txns[eq.id]
        return { data: t && t.company_id === eq.company_id ? t : null, error: null }
      },
    }
    return chain
  },
} as any

describe('validateConversionLink — the converted instrument must be the caller\'s', () => {
  it('accepts a SAFE in one of their entities', async () => {
    expect(await validateConversionLink(admin, 'c1', 's1', 'investment', ['Fund I'])).toBeNull()
  })
  it('refuses another entity\'s SAFE on the same company, as not found', async () => {
    expect(await validateConversionLink(admin, 'c1', 's2', 'investment', ['Fund I'])).toMatch(/not found/)
  })
  it('an unscoped caller may link any of the company\'s instruments', async () => {
    expect(await validateConversionLink(admin, 'c1', 's2', 'investment', null)).toBeNull()
  })
})
