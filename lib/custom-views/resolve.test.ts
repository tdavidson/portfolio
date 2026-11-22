import { describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { pivotSeries, resolveView } from './resolve'
import { parseViewSpec } from './spec'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'

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
  it('opens a view whose ledger blocks need one entity on the viewer\'s first, rather than refusing every block', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    // As a ledger dataset does in a fund with several entities and none named.
    const lpPositions = vi.fn(async (_ctx: unknown, p: { vehicle?: string }) => {
      if (!p.vehicle) throw new VehicleResolutionError('Specify a vehicle — this fund has several: Example Fund I, Example Fund II')
      return LP_POSITIONS
    })
    const payload = await resolveView({ ...d.deps, loaders: { positions: d.positions, lp_positions: lpPositions } as never }, spec, {}, { id: null })
    expect(payload.data.values.vehicle).toBe('Example Fund I')
    expect(payload.subtitle).toBe('Example Fund I')
    expect(payload.data.blocks.every(b => b.status === 'ok')).toBe(true)
  })

  it('keeps "all entities" when every block can load without one', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    const payload = await resolveView(d.deps, spec, {}, { id: null })
    expect(payload.data.values.vehicle).toBeUndefined()
    expect(payload.subtitle).toBe('All vehicles')
  })

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

describe('chart types', () => {
  const run = async (block: Record<string, unknown>) => {
    const d = deps({ portfolio: 'read' })
    const spec = parseViewSpec({ title: 'T', blocks: [{ label: 'C', format: 'currency', ...block }] })
    return (await resolveView(d.deps, spec, {}, { id: null })).data.blocks[0]
  }
  const byCompany = { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company', 'cost', 'fair_value', 'moic'] } }

  it('draws a scatter as one dot per row, named by point_label', async () => {
    const b = await run({ type: 'scatter', source: byCompany, x: 'cost', y: 'moic', point_label: 'company', x_format: 'currency', format: 'multiple' })
    expect(b).toMatchObject({ status: 'ok', xFormat: 'currency', dots: [{ label: 'Acme', x: 100_000, y: 2.5 }, { label: 'Northwind', x: 200_000, y: 0.75 }] })
  })

  it('pairs a combo\'s bars and line, and names the line', async () => {
    const b = await run({ type: 'combo', source: byCompany, x: 'company', y: 'cost', y2: 'fair_value' })
    expect(b.points).toEqual([{ label: 'Acme', value: 100_000, value2: 250_000 }, { label: 'Northwind', value: 200_000, value2: 150_000 }])
    expect(b.label2).toBe('Fair value')
  })

  it('orders pie slices largest first and keeps waterfall steps in order with a total', async () => {
    const pie = await run({ type: 'pie', source: byCompany, x: 'company', y: 'cost', donut: true })
    expect(pie).toMatchObject({ donut: true, points: [{ label: 'Northwind', value: 200_000 }, { label: 'Acme', value: 100_000 }] })
    const walk = await run({ type: 'waterfall', source: byCompany, x: 'company', y: 'fair_value' })
    expect(walk).toMatchObject({ total: true, points: [{ label: 'Acme', value: 250_000 }, { label: 'Northwind', value: 150_000 }] })
  })
})

describe('report features', () => {
  const src = (query: object, extra: object = {}) => ({ tool: 'query_portfolio', dataset: 'positions', query, ...extra })

  it('adds calculated columns, and sorts and limits on them after they exist', async () => {
    const d = deps({ portfolio: 'read' })
    const view = parseViewSpec({
      title: 'Gain', blocks: [{
        id: 't', type: 'table', label: 'Gain', source: src(
          { columns: ['company', 'fair_value', 'cost'], order_by: [{ column: 'gain', direction: 'asc' }], limit: 1 },
          { computed: [{ as: 'gain', formula: 'fair_value - cost' }, { as: 'gain_pct', formula: 'round(gain / cost * 100, 1)' }] },
        ),
        columns: ['company', 'gain', { column: 'gain_pct', format: 'percent' }],
      }],
    })
    const [t] = (await resolveView(d.deps, view, {}, { id: null })).data.blocks
    expect(t.rows).toEqual([{ company: 'Northwind', gain: -50_000, gain_pct: -25 }])
  })

  it('adds a totals row over the currency and number columns only', async () => {
    const d = deps({ portfolio: 'read' })
    const view = parseViewSpec({
      title: 'T', blocks: [{ id: 't', type: 'table', label: 'T', totals: true, source: src({ columns: ['company', 'fair_value', 'moic'] }) }],
    })
    const [t] = (await resolveView(d.deps, view, {}, { id: null })).data.blocks
    expect(t.totalsRow).toEqual({ company: null, fair_value: 400_000, moic: null })
  })

  it('cross-tabs a pivot with row, column and grand totals', async () => {
    const d = deps({ portfolio: 'read' })
    const view = parseViewSpec({
      title: 'P', blocks: [{
        id: 'p', type: 'pivot', label: 'By stage', rows: 'status', columns: 'stage', value: 'fv', format: 'currency',
        source: src({ group_by: ['status', 'stage'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }),
      }],
    })
    const [p] = (await resolveView(d.deps, view, {}, { id: null })).data.blocks
    expect(p.pivot).toEqual({
      rowLabel: 'Status', rows: ['active'], columns: ['Seed', 'Series A'], cells: [[250_000, 150_000]],
      rowTotals: [400_000], columnTotals: [250_000, 150_000], grandTotal: 400_000,
    })
  })

  it('compares a figure with the same figure at an earlier date', async () => {
    const d = deps({ portfolio: 'read' })
    d.positions.mockImplementation((async (_ctx: unknown, opts: { as_of?: string }) =>
      opts.as_of === '2026-06-30' ? POSITIONS.map(p => ({ ...p, fair_value: p.fair_value / 2 })) : POSITIONS) as never)
    const view = parseViewSpec({
      title: 'C', params: ['as_of'], blocks: [{
        id: 'k', type: 'kpi', label: 'FV', format: 'currency', compare: 'prior_quarter', value: 'fv',
        source: src({ aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }),
      }],
    })
    const [k] = (await resolveView(d.deps, view, { as_of: '2026-09-30' }, { id: null })).data.blocks
    expect(k).toMatchObject({ value: 400_000, previous: 200_000, previousLabel: 'vs Jun 30, 2026' })
  })

  it('offers pick filters from the viewer\'s rows and applies them to every block with the column', async () => {
    const d = deps({ portfolio: 'read', lp_capital: 'read' })
    const view = parseViewSpec({
      title: 'F', filters: [{ column: 'stage' }], blocks: [
        { id: 'k', type: 'kpi', label: 'FV', format: 'currency', value: 'fv', source: src({ aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }) },
        { id: 'l', type: 'table', label: 'LPs', source: { tool: 'query_lps', dataset: 'lp_positions', query: { columns: ['investor', 'nav'] } } },
      ],
    })
    const payload = await resolveView(d.deps, view, { 'filter.stage': 'Seed' }, { id: 'v' })
    expect(payload.data.filters).toEqual([{ column: 'stage', label: 'Stage', kind: 'pick', options: ['Seed', 'Series A'], value: { pick: 'Seed' } }])
    expect(payload.data.values).toEqual({ 'filter.stage': 'Seed' })
    expect(payload.subtitle).toBe('Stage: Seed')
    const [k, l] = payload.data.blocks
    expect(k.value).toBe(250_000)
    // A dataset without the column is left alone.
    expect(l.rows).toHaveLength(1)
  })
})

describe('more blocks and table options', () => {
  const src = (query: object) => ({ tool: 'query_portfolio', dataset: 'positions', query })
  const fvSrc = src({ aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] })

  it('works out a formula tile from tiles on different datasets, and denies it with one it cannot read', async () => {
    const view = parseViewSpec({ title: 'F', blocks: [
      { id: 'fair_value', type: 'kpi', label: 'FV', source: fvSrc, value: 'fv', format: 'currency' },
      { id: 'nav', type: 'kpi', label: 'LP NAV', source: { tool: 'query_lps', dataset: 'lp_positions', query: { aggregates: [{ fn: 'sum', column: 'nav', as: 'nav' }] } }, value: 'nav', format: 'currency' },
      { id: 'ratio', type: 'kpi', label: 'NAV / FV', formula: 'nav / fair_value', format: 'multiple' },
    ] })
    const ok = (await resolveView(deps({ portfolio: 'read', lp_capital: 'read' }).deps, view, {}, { id: null })).data.blocks[2]
    expect(ok).toMatchObject({ status: 'ok', value: 1, format: 'multiple' })
    const denied = (await resolveView(deps({ portfolio: 'read' }).deps, view, {}, { id: null })).data.blocks[2]
    expect(denied).toMatchObject({ status: 'denied' })
  })

  it('reads a gauge against a column, and a sparkline under a tile', async () => {
    const view = parseViewSpec({ title: 'G', blocks: [
      { type: 'gauge', label: 'G', format: 'currency', value: 'fv', max_column: 'inv', target: 350_000,
        source: src({ aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }, { fn: 'sum', column: 'invested', as: 'inv' }] }) },
      { type: 'kpi', label: 'K', source: fvSrc, value: 'fv', format: 'currency', trend: { source: src({ columns: ['company', 'fair_value'] }), x: 'company', y: 'fair_value' } },
    ] })
    const [g, k] = (await resolveView(deps({ portfolio: 'read' }).deps, view, {}, { id: null })).data.blocks
    expect(g).toMatchObject({ value: 400_000, gaugeMax: 300_000, target: 350_000 })
    expect(k.spark).toEqual([{ label: 'Acme', value: 250_000 }, { label: 'Northwind', value: 150_000 }])
  })

  it('draws measures as series, and groups a table with subtotals and company links', async () => {
    const view = parseViewSpec({ title: 'M', blocks: [
      { type: 'column', label: 'C', source: src({ columns: ['company', 'cost', 'fair_value'] }), x: 'company', y: 'cost', measures: ['fair_value'] },
      { type: 'table', label: 'T', source: src({ columns: ['company', 'company_id', 'status', 'fair_value'] }), subtotal_by: 'status',
        columns: [{ column: 'company', link: 'company' }, { column: 'fair_value', tone: 'scale' }] },
    ] })
    const [c, t] = (await resolveView(deps({ portfolio: 'read' }).deps, view, {}, { id: null })).data.blocks
    expect(c).toMatchObject({ stack: 'grouped', series: ['Cost', 'Fair value'], points: [{ label: 'Acme', value: 350_000, values: [100_000, 250_000] }, { label: 'Northwind', values: [200_000, 150_000] }] })
    expect(t.subtotals).toEqual([{ after: 1, label: 'active', values: { company: null, fair_value: 400_000 } }])
    expect(t.links).toEqual([{ company: 'company:c1' }, { company: 'company:c2' }])
    expect(t.columns?.[1]).toMatchObject({ tone: 'scale' })
  })

  it('shades a heatmap with no totals unless asked', async () => {
    const view = parseViewSpec({ title: 'H', blocks: [{ type: 'heatmap', label: 'H', rows: 'company', columns: 'stage', value: 'fv', format: 'currency',
      source: src({ group_by: ['company', 'stage'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }) }] })
    const [h] = (await resolveView(deps({ portfolio: 'read' }).deps, view, {}, { id: null })).data.blocks
    expect(h.type).toBe('heatmap')
    expect(h.pivot).toMatchObject({ rows: ['Acme', 'Northwind'], columns: ['Seed', 'Series A'] })
    expect(h.pivot?.rowTotals).toBeUndefined()
  })
})
