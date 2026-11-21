import { describe, it, expect } from 'vitest'
import { applyFeatureAccess, parseFeatureAccess, visibilityOf } from './feature-access'

describe('featureAccess (setup_fund over MCP)', () => {
  it('accepts everyone or admin for a known feature', () => {
    expect(parseFeatureAccess({ inbound: 'admin' })).toEqual({ inbound: 'admin' })
  })

  it('refuses an unknown feature, a level other than everyone/admin, and an empty change', () => {
    expect(parseFeatureAccess({ mailbox: 'admin' })).toHaveProperty('error')
    expect(parseFeatureAccess({ inbound: 'off' })).toHaveProperty('error')
    expect(parseFeatureAccess({})).toHaveProperty('error')
    expect(parseFeatureAccess('admin')).toHaveProperty('error')
  })

  it('makes Inbound admins only, and back', () => {
    const start = visibilityOf(null)
    expect(start.inbound).toBe('everyone')
    const closed = applyFeatureAccess(start, { inbound: 'admin' })
    expect(closed.visibility.inbound).toBe('admin')
    expect(closed.changed).toEqual({ inbound: 'admin' })
    expect(applyFeatureAccess(closed.visibility, { inbound: 'everyone' }).visibility.inbound).toBe('everyone')
  })

  it('leaves a feature that is off alone and reports it', () => {
    const out = applyFeatureAccess(visibilityOf({ deals: 'off' }), { deals: 'everyone' })
    expect(out.visibility.deals).toBe('off')
    expect(out.refused).toEqual(['deals'])
    expect(out.changed).toEqual({})
  })
})
