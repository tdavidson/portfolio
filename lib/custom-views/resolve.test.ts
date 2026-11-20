import { describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { pivotSeries, resolveView } from './resolve'
import { parseViewSpec } from './spec'

const access = (grants: Partial<Record<Domain, AccessLevel>>): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

const POSITIONS = [
  { company: 'Acme', company_id: 'c1', status: 'active', stage: 'Seed', industry: ['AI'], invested: 100_000, cost: 100_000, fair_value: 250_000, unrealized: 150_000, realized: 0, moic: 2.5, pct_of_portfolio: 62.5 },
  { company: 'Northwind', company_id: 'c2', status: 'active', stage: 'Series A', industry: [], invested: 200_000, cost: 200_000, fair_value: 150_000, unrealized: -50_000, realized: 0, moic: 0.75, pct_of_portfolio: 37.5 },
]

const LP_POSITIONS = [
  { investor: 'Jane Doe', lp_entity: 'Doe Trust', vehicle: 'Example Fund I', commitment: 500_000, nav: 400_000 },
]

function deps(grants: Partial<Record<Domain, AccessLevel>>) {
  const positions = vi.fn(async () => POSITIONS)
  const lpPositions = vi.fn(async () => LP_POSITIONS)
  return {
    positions,
    lpPositions,
    deps: {
      admin: {} as never,
      fundId: 'fund-1',
      userId: 'user-me',
      access: access(grants),
      loaders: { positions, lp_positions: lpPositions } as never,
      branding: async () => ({ fundName: 'Example Fund', currency: 'USD', cssVars: '' }),
      vehicles: async () => ['Example Fund I', 'Example Fund II'],
    },
  }
}

const spec = parseViewSpec({
  title: 'Monday view',
  params: ['vehicle'],
  blocks: [
    { id: 'fv', type: 'kpi', label: 'Fair value', source: { tool: 'query_portfolio', dataset: 'positions', query: { aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] } }, value: 'fv', format: 'currency' },
    { id: 'bars', type: 'bar', label: 'Fair value by company', source: { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company', 'fair_value'], order_by: [{ column: 'fair_value', direction: 'desc' }] } }, x: 'company', y: 'fair_value', format: 'currency' },
    { id: 'tbl', type: 'table', label: 'Positions', source: { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company', 'moic', 'industry'] } } },
    { id: 'lps', type: 'table', label: 'LP NAV', source: { tool: 'query_lps', dataset: 'lp_positions', query: { columns: ['investor', 'nav'] } } },
    { id: 'note', type: 'text', text: 'Live figures.' },
  ],
})

describe('resolveView', () => {
  it('loads every block as the viewer and lays it out', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    const payload = await resolveView(d.deps, spec, { vehicle: 'Example Fund I' }, { id: 'view-1', name: 'My Monday', url: '/views/view-1' })

    expect(payload.view).toBe('custom')
    expect(payload.title).toBe('My Monday')
    expect(payload.subtitle).toBe('Example Fund I')
    expect(payload.data).toMatchObject({ id: 'view-1', url: '/views/view-1', params: ['vehicle'], values: { vehicle: 'Example Fund I' }, vehicles: ['Example Fund I', 'Example Fund II'] })

    const [kpi, bars, table, lps, text] = payload.data.blocks
    expect(kpi).toMatchObject({ status: 'ok', value: 400_000, format: 'currency' })
    expect(bars.points).toEqual([{ label: 'Acme', value: 250_000 }, { label: 'Northwind', value: 150_000 }])
    expect(table.columns).toEqual([
      { key: 'company', label: 'Company', format: 'text' },
      { key: 'moic', label: 'Moic', format: 'multiple' },
      { key: 'industry', label: 'Industry', format: 'text' },
    ])
    // Lists are joined for display.
    expect(table.rows?.[0]).toEqual({ company: 'Acme', moic: 2.5, industry: 'AI' })
    expect(lps).toMatchObject({ status: 'ok', rows: [{ investor: 'Jane Doe', nav: 400_000 }] })
    expect(text).toMatchObject({ status: 'ok', text: 'Live figures.' })
  })

  it('loads a dataset once however many blocks use it, with the view\'s filter', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    await resolveView(d.deps, spec, { vehicle: 'Example Fund I' }, { id: null })
    expect(d.positions).toHaveBeenCalledTimes(1)
    expect((d.positions.mock.calls[0] as unknown[])[1]).toEqual({ vehicle: 'Example Fund I', as_of: undefined })
  })

  it('marks a block the viewer cannot read and loads nothing for it', async () => {
    const d = deps({ portfolio: 'read' })
    const payload = await resolveView(d.deps, spec, {}, { id: null })
    const lps = payload.data.blocks.find(b => b.id === 'lps')!
    expect(lps.status).toBe('denied')
    expect(lps.rows).toBeUndefined()
    expect(lps.message).toMatch(/Needs access to/)
    expect(d.lpPositions).not.toHaveBeenCalled()
    // The rest of the view still loads.
    expect(payload.data.blocks.find(b => b.id === 'fv')?.status).toBe('ok')
  })

  it('denies every data block to a member with no grants, without failing the view', async () => {
    const d = deps({})
    const payload = await resolveView(d.deps, spec, {}, { id: null })
    expect(payload.data.blocks.filter(b => b.type !== 'text').every(b => b.status === 'denied')).toBe(true)
    expect(d.positions).not.toHaveBeenCalled()
  })

  it('turns a loader failure into one failed block', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    d.lpPositions.mockRejectedValueOnce(new Error('No vehicle named "Fund Z".'))
    const payload = await resolveView(d.deps, spec, {}, { id: null })
    expect(payload.data.blocks.find(b => b.id === 'lps')).toMatchObject({ status: 'error', message: 'No vehicle named "Fund Z".' })
    expect(payload.data.blocks.find(b => b.id === 'tbl')?.status).toBe('ok')
  })

  it('ignores filter values the view does not offer', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    const noFilter = parseViewSpec({ ...spec, params: [] })
    const payload = await resolveView(d.deps, noFilter, { vehicle: 'Example Fund II' }, { id: null })
    expect(payload.data.values).toEqual({})
    expect(payload.data.vehicles).toEqual([])
    expect((d.positions.mock.calls[0] as unknown[])[1]).toEqual({ vehicle: undefined, as_of: undefined })
  })
})

describe('chart series', () => {
  it('stacks a split bar chart: one point per x, a figure per series, largest series first', async () => {
    const d = deps({ portfolio: 'read' })
    const split = parseViewSpec({
      title: 'Split',
      blocks: [{
        type: 'bar', label: 'Fair value by stage', format: 'currency', x: 'stage', y: 'fv', series: 'company',
        source: { tool: 'query_portfolio', dataset: 'positions', query: { group_by: ['stage', 'company'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] } },
      }],
    })
    const [block] = (await resolveView(d.deps, split, {}, { id: null })).data.blocks
    expect(block.series).toEqual(['Acme', 'Northwind'])
    expect(block.points).toEqual([
      { label: 'Seed', value: 250_000, values: [250_000, 0] },
      { label: 'Series A', value: 150_000, values: [0, 150_000] },
    ])
  })

  it('folds series past the eighth into Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ quarter: 'Q1', sector: `Sector ${i}`, amount: (10 - i) * 1_000 }))
    const { series, points } = pivotSeries(rows, 'quarter', 'amount', 'sector')
    expect(series).toHaveLength(8)
    expect(series[7]).toBe('Other')
    expect(points[0].values[7]).toBe(2_000 + 1_000 + 3_000)
    expect(points[0].value).toBe(55_000)
  })
})
