import { describe, it, expect } from 'vitest'
import {
  activeEntityOptions, resolveExcluded, selectionLabel, companyInSelection, parseIdList, type EntityOption,
} from './entity-selection'

const all = { vehicles: { all: true, ids: [] } }
const only = (...ids: string[]) => ({ vehicles: { all: false, ids } })

const vehicles = [
  { id: 'v1', name: 'Fund I', aliases: ['Fund 1'] },
  { id: 'v2', name: 'SPV A' },
  { id: 'v3', name: '3SE Holdings LP' },
  { id: 'v4', name: 'Fund II' },
  { id: 'm1', name: 'ManCo', kind: 'manco' },
]
const txn = (o: Record<string, unknown>) => ({ transaction_type: 'investment', transaction_date: '2024-01-01', ...o }) as any

describe('activeEntityOptions', () => {
  const companies = [
    { id: 'c1', status: 'active', holdingType: 'company' },
    { id: 'f1', status: 'active', holdingType: 'fund' },
    { id: 'k1', status: 'active', holdingType: 'crypto' },
    { id: 'x1', status: 'exited', holdingType: 'company' },
  ]

  it('lists entities holding an active company, fund holding or digital asset — and not one holding none', () => {
    const opts = activeEntityOptions({
      access: all, vehicles, companies,
      holdings: [
        { companyId: 'c1', vehicleId: 'v1' },
        { companyId: 'f1', vehicleId: 'v2' },
        { companyId: 'k1', vehicleId: 'v3' },
        { companyId: 'x1', vehicleId: 'v4' }, // only an exited company: not offered
      ],
    })
    expect(opts.map(o => o.name)).toEqual(['3SE Holdings LP', 'Fund I', 'SPV A'])
    expect(opts.find(o => o.id === 'v1')!.names).toEqual(['Fund I', 'Fund 1'])
  })

  it('an entity whose own transactions closed the position out is not active there', () => {
    const transactionsByCompany = new Map([['c1', [
      txn({ portfolio_group: 'Fund I', investment_cost: 100, shares_acquired: 10 }),
      txn({ portfolio_group: 'Fund I', transaction_type: 'proceeds', cost_basis_exited: 100, proceeds_received: 150 }),
      txn({ portfolio_group: 'SPV A', investment_cost: 50, shares_acquired: 5 }),
    ]]])
    const opts = activeEntityOptions({
      access: all, vehicles, companies, transactionsByCompany,
      holdings: [{ companyId: 'c1', vehicleId: 'v1' }, { companyId: 'c1', vehicleId: 'v2' }],
    })
    expect(opts.map(o => o.id)).toEqual(['v2'])
  })

  it('never offers an entity the viewer cannot see', () => {
    const opts = activeEntityOptions({
      access: only('v2'), vehicles, companies,
      holdings: [{ companyId: 'c1', vehicleId: 'v1' }, { companyId: 'f1', vehicleId: 'v2' }],
    })
    expect(opts.map(o => o.id)).toEqual(['v2'])
    expect(activeEntityOptions({ access: only(), vehicles, companies, holdings: [{ companyId: 'c1', vehicleId: 'v1' }] })).toEqual([])
  })

  it('lists a management company only with that grant', () => {
    const input = { access: all, vehicles, companies, holdings: [{ companyId: 'c1', vehicleId: 'm1' }] }
    expect(activeEntityOptions({ ...input, includeManagementCompanies: false })).toEqual([])
    expect(activeEntityOptions({ ...input, includeManagementCompanies: true }).map(o => o.id)).toEqual(['m1'])
  })

  it('ignores a holding of an unknown company or entity', () => {
    expect(activeEntityOptions({ access: all, vehicles, companies, holdings: [{ companyId: 'nope', vehicleId: 'v1' }, { companyId: 'c1', vehicleId: 'v9' }] })).toEqual([])
  })
})

const opts: EntityOption[] = [
  { id: 'v3', name: '3SE Holdings LP', names: ['3SE Holdings LP'] },
  { id: 'v1', name: 'Fund I', names: ['Fund I', 'Fund 1'] },
  { id: 'v2', name: 'SPV A', names: ['SPV A'] },
]

describe('resolveExcluded', () => {
  it('uses the saved selection first, even over a fund default', () => {
    expect(resolveExcluded({ options: opts, saved: ['v2'], fundDefault: ['v3'] })).toEqual({ excluded: ['v2'], source: 'saved' })
  })

  it('an empty saved selection means "all" and still beats the fund default', () => {
    expect(resolveExcluded({ options: opts, saved: [], fundDefault: ['v3'] })).toEqual({ excluded: [], source: 'saved' })
  })

  it('falls back to the fund default when nothing is saved', () => {
    expect(resolveExcluded({ options: opts, saved: null, fundDefault: ['v3'] })).toEqual({ excluded: ['v3'], source: 'fund' })
  })

  it('falls back to all with neither', () => {
    expect(resolveExcluded({ options: opts, saved: null, fundDefault: [] })).toEqual({ excluded: [], source: 'all' })
    expect(resolveExcluded({ options: opts, saved: null, fundDefault: null })).toEqual({ excluded: [], source: 'all' })
  })

  it('drops exclusions of entities that are not options (not visible, or nothing active)', () => {
    expect(resolveExcluded({ options: opts, saved: null, fundDefault: ['v3', 'hidden'] }).excluded).toEqual(['v3'])
  })

  it('never resolves to an empty dashboard — excluding every option means all', () => {
    const one = [opts[0]]
    expect(resolveExcluded({ options: one, saved: null, fundDefault: ['v3'] }).excluded).toEqual([])
    expect(resolveExcluded({ options: opts, saved: ['v1', 'v2', 'v3'], fundDefault: null }).excluded).toEqual([])
  })

  it('a new entity (not in any stored list) is shown by default', () => {
    const withNew = [...opts, { id: 'v9', name: 'Fund III', names: ['Fund III'] }]
    expect(resolveExcluded({ options: withNew, saved: null, fundDefault: ['v3'] }).excluded).not.toContain('v9')
  })
})

describe('selectionLabel', () => {
  it('summarises the selection', () => {
    expect(selectionLabel(opts, [])).toBe('All entities')
    expect(selectionLabel(opts, ['v3', 'v2'])).toBe('Fund I')
    expect(selectionLabel(opts, ['v3'])).toBe('2 entities')
  })
})

describe('companyInSelection', () => {
  it('shows everything with no exclusions', () => {
    expect(companyInSelection(['3SE Holdings LP'], opts, [])).toBe(true)
  })
  it('hides a company only when every entity holding it is excluded', () => {
    expect(companyInSelection(['3SE Holdings LP'], opts, ['v3'])).toBe(false)
    expect(companyInSelection(['3SE Holdings LP', 'Fund I'], opts, ['v3'])).toBe(true)
  })
  it('matches an entity by its legacy alias', () => {
    expect(companyInSelection(['Fund 1'], opts, ['v1'])).toBe(false)
  })
  it('keeps a company in no entity, or only in entities that are not options', () => {
    expect(companyInSelection(null, opts, ['v3'])).toBe(true)
    expect(companyInSelection(['Old Fund'], opts, ['v3'])).toBe(true)
  })
})

describe('parseIdList', () => {
  it('accepts a list of strings, de-duplicated; rejects anything else', () => {
    expect(parseIdList(['a', 'a', 'b'])).toEqual(['a', 'b'])
    expect(parseIdList([])).toEqual([])
    expect(parseIdList('a')).toBeNull()
    expect(parseIdList([1])).toBeNull()
    expect(parseIdList(undefined)).toBeNull()
  })
})
