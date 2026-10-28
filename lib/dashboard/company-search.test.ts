import { describe, expect, it } from 'vitest'
import { searchCompanies } from './company-search'

const companies = [
  { id: 'c1', name: 'Northwind Robotics', aliases: ['NWR'], tags: ['hardware'], industry: ['Robotics'] },
  { id: 'c2', name: 'Acme Analytics', aliases: null, tags: ['saas'], industry: ['Data'] },
  { id: 'c3', name: 'Blue Acme', aliases: [], tags: [], industry: null },
]

describe('dashboard company search', () => {
  it('matches nothing on a blank query', () => {
    expect(searchCompanies('', companies)).toEqual([])
    expect(searchCompanies('   ', companies)).toEqual([])
  })

  it('ranks a name prefix above a later word in the name', () => {
    expect(searchCompanies('acme', companies).map(c => c.id)).toEqual(['c2', 'c3'])
  })

  it('finds a company by alias, tag or industry', () => {
    expect(searchCompanies('nwr', companies).map(c => c.id)).toEqual(['c1'])
    expect(searchCompanies('saas', companies).map(c => c.id)).toEqual(['c2'])
    expect(searchCompanies('data', companies).map(c => c.id)).toEqual(['c2'])
  })

  it('needs every token to match, ignoring case and accents', () => {
    expect(searchCompanies('NORTH robo', companies).map(c => c.id)).toEqual(['c1'])
    expect(searchCompanies('north acme', companies)).toEqual([])
    expect(searchCompanies('ácme an', companies).map(c => c.id)).toEqual(['c2'])
  })

  it('returns the caller’s own rows', () => {
    expect(searchCompanies('blue', companies)[0]).toBe(companies[2])
  })
})
