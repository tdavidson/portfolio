import { describe, it, expect } from 'vitest'
import { findExact, normalizeName, suggestPairs } from './matching'

const inv = (id: string, name: string, contact_email: string | null = null) => ({ id, name, contact_email })

describe('suggestPairs', () => {
  it('matches by email first, then by name', () => {
    const ours = [inv('a1', 'Jane Doe', 'jane@x.com'), inv('a2', 'Smith Family Trust')]
    const theirs = [inv('b1', 'J. Doe', 'JANE@x.com '), inv('b2', 'Smith  Family Trust.'), inv('b3', 'Someone Else')]
    const s = suggestPairs(ours, theirs)
    expect(s.map(x => [x.ours.id, x.theirs.id, x.reason])).toEqual([
      ['a1', 'b1', 'email'],
      ['a2', 'b2', 'name'],
    ])
  })

  it('never lists an investor of theirs that matches nobody of ours', () => {
    const s = suggestPairs([inv('a1', 'Jane Doe')], [inv('b1', 'Jane Doe'), inv('b2', 'Private LP')])
    expect(s.flatMap(x => [x.theirs.id])).toEqual(['b1'])
  })

  it('suggests nothing for an ambiguous key', () => {
    const s = suggestPairs([inv('a1', 'Jane Doe')], [inv('b1', 'Jane Doe'), inv('b2', 'jane doe')])
    expect(s).toEqual([])
  })

  it('skips investors already paired', () => {
    const s = suggestPairs([inv('a1', 'Jane Doe')], [inv('b1', 'Jane Doe')], new Set(['a1']))
    expect(s).toEqual([])
  })

  it('does not reuse an email match for a name match', () => {
    const ours = [inv('a1', 'Jane Doe', 'jane@x.com'), inv('a2', 'Jane Doe')]
    const theirs = [inv('b1', 'Jane Doe', 'jane@x.com')]
    expect(suggestPairs(ours, theirs).map(x => x.ours.id)).toEqual(['a1'])
  })
})

describe('findExact', () => {
  const theirs = [inv('b1', 'Jane Doe', 'jane@x.com'), inv('b2', 'Acme Ventures, LLC')]
  it('finds by normalized name or email', () => {
    expect(findExact(theirs, 'acme ventures llc')?.id).toBe('b2')
    expect(findExact(theirs, ' Jane@X.com')?.id).toBe('b1')
  })
  it('finds nothing for a partial name', () => {
    expect(findExact(theirs, 'Acme')).toBeNull()
  })
  it('normalizes accents and punctuation', () => {
    expect(normalizeName('  Café  Partners, L.P. ')).toBe('cafe partners l p')
  })
})
