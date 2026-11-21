import { describe, expect, it } from 'vitest'
import { STARTER_VIEWS, findStarter, startersFor, starterSpec } from './starters'
import { AREAS } from '@/lib/agent/getting-started'

describe('starter views', () => {
  it.each(STARTER_VIEWS.map(s => [s.key, s]))('%s is a valid spec', (_key, s) => {
    expect(() => starterSpec(s)).not.toThrow()
  })

  it('have unique keys and belong to a help area', () => {
    expect(new Set(STARTER_VIEWS.map(s => s.key)).size).toBe(STARTER_VIEWS.length)
    const areas = new Set(AREAS.map(a => a.key))
    for (const s of STARTER_VIEWS) expect(areas.has(s.area)).toBe(true)
  })

  it('are offered only to members who can read every dataset they use', () => {
    const portfolioOnly = startersFor(d => d === 'portfolio')
    expect(portfolioOnly.map(s => s.area).every(a => a === 'portfolio')).toBe(true)
    expect(portfolioOnly.length).toBeGreaterThan(0)
    expect(startersFor(() => false)).toEqual([])
    expect(startersFor()).toEqual(STARTER_VIEWS)
  })

  it('are found by key or name, within what the member may read', () => {
    expect(findStarter('lp-capital')?.key).toBe('lp-capital')
    expect(findStarter('LP Capital')?.key).toBe('lp-capital')
    expect(findStarter('lp-capital', d => d === 'portfolio')).toBeUndefined()
    expect(findStarter('')).toBeUndefined()
  })
})
