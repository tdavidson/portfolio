import { describe, expect, it } from 'vitest'
import { MAX_BLOCKS, parseViewSpec, cleanParams, ViewSpecError, type ViewSpec } from './spec'

const positions = (query: Record<string, unknown> = {}) => ({ tool: 'query_portfolio', dataset: 'positions', query })

const valid = {
  title: 'Monday view',
  params: ['vehicle'],
  blocks: [
    { type: 'kpi', label: 'Fair value', source: positions({ aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }), value: 'fv', format: 'currency' },
    { type: 'bar', label: 'Fair value by company', source: positions({ columns: ['company', 'fair_value'], order_by: [{ column: 'fair_value', direction: 'desc' }], limit: 10 }), x: 'company', y: 'fair_value', format: 'currency' },
    { type: 'table', label: 'Positions', source: positions({ columns: ['company', 'cost', 'moic'] }), columns: ['company', { column: 'moic', label: 'MOIC', format: 'multiple' }] },
    { type: 'text', text: 'Figures are live.' },
  ],
}

const fails = (spec: unknown, message: RegExp) => {
  expect(() => parseViewSpec(spec)).toThrow(ViewSpecError)
  expect(() => parseViewSpec(spec)).toThrow(message)
}

describe('parseViewSpec', () => {
  it('accepts a spec of every block type and fills defaults', () => {
    const spec = parseViewSpec(valid)
    expect(spec.spec_version).toBe(1)
    expect(spec.params).toEqual(['vehicle'])
    expect(spec.blocks.map(b => b.type)).toEqual(['kpi', 'bar', 'table', 'text'])
    // Ids and spans are assigned when the assistant leaves them out.
    expect(spec.blocks.map(b => b.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
    expect(spec.blocks.map(b => b.span)).toEqual([3, 6, 6, 12])
    const table = spec.blocks[2] as Extract<ViewSpec['blocks'][number], { type: 'table' }>
    expect(table.columns).toEqual([{ column: 'company' }, { column: 'moic', label: 'MOIC', format: 'multiple' }])
  })

  it('reads a spec given as JSON text', () => {
    expect(parseViewSpec(JSON.stringify(valid)).title).toBe('Monday view')
    fails('{not json', /not valid JSON/)
  })

  it('names the datasets when one is unknown', () => {
    fails({ ...valid, blocks: [{ type: 'table', label: 'X', source: { tool: 'query_portfolio', dataset: 'nope' } }] }, /Datasets: positions, companies/)
    fails({ ...valid, blocks: [{ type: 'table', label: 'X', source: { tool: 'query_secrets', dataset: 'x' } }] }, /source.tool must be one of/)
  })

  it('checks every column through the query engine', () => {
    fails({ ...valid, blocks: [{ type: 'table', label: 'X', source: positions({ where: [{ column: 'salary', op: 'gt', value: 1 }] }) }] }, /unknown column "salary"/)
  })

  it('binds kpi, chart and table columns to the RESULT, not the dataset', () => {
    // After an aggregate the result has only the aggregate's column.
    fails({ ...valid, blocks: [{ type: 'kpi', label: 'X', source: positions({ aggregates: [{ fn: 'sum', column: 'cost' }] }), value: 'cost' }] }, /value must be a column of the result: sum_cost/)
    fails({ ...valid, blocks: [{ type: 'bar', label: 'X', source: positions({ columns: ['company'] }), x: 'company', y: 'fair_value' }] }, /y must be a column of the result/)
  })

  it('takes a lone result column as the kpi value', () => {
    const spec = parseViewSpec({ title: 'T', blocks: [{ type: 'kpi', label: 'Count', source: positions({ aggregates: [{ fn: 'count' }] }) }] })
    expect(spec.blocks[0]).toMatchObject({ value: 'count', format: 'number' })
  })

  it('keeps only the engine\'s own query keys', () => {
    const spec = parseViewSpec({ title: 'T', blocks: [{ type: 'table', label: 'X', source: positions({ columns: ['company'], sql: 'drop table funds' }) }] })
    expect((spec.blocks[0] as any).source.query).toEqual({ columns: ['company'] })
  })

  it('refuses unknown block types, params and formats', () => {
    fails({ ...valid, blocks: [{ type: 'html', label: 'X' }] }, /type must be one of: kpi, bar, column, line, area, pie, scatter, combo, waterfall, funnel, table, pivot, text/)
    fails({ ...valid, params: ['company'] }, /params must be one of: vehicle, as_of/)
    fails({ ...valid, blocks: [{ ...valid.blocks[0], format: 'emoji' }] }, /format must be one of/)
  })

  it('bounds the size of a view', () => {
    fails({ title: 'T', blocks: [] }, /at least one block/)
    fails({ title: 'T', blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => ({ type: 'text', text: 'x' })) }, /at most 24 blocks/)
    fails({ ...valid, title: 'x'.repeat(121) }, /at most 120/)
    fails({ ...valid, spec_version: 2 }, /not supported/)
  })

  it('makes duplicate block ids unique', () => {
    const spec = parseViewSpec({ title: 'T', blocks: [{ id: 'a', type: 'text', text: 'x' }, { id: 'a', type: 'text', text: 'y' }] })
    expect(new Set(spec.blocks.map(b => b.id)).size).toBe(2)
  })
})

describe('chart series', () => {
  const stacked = (extra: Record<string, unknown> = {}) => ({
    title: 'Stacked',
    blocks: [{
      type: 'bar', label: 'Fair value by stage and status',
      source: positions({ group_by: ['stage', 'status'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }),
      x: 'stage', y: 'fv', series: 'status', format: 'currency', ...extra,
    }],
  })

  it('keeps a series that is a result column', () => {
    expect(parseViewSpec(stacked()).blocks[0]).toMatchObject({ type: 'bar', x: 'stage', y: 'fv', series: 'status' })
  })

  it('leaves series off a chart that does not split', () => {
    expect(parseViewSpec(valid).blocks[1]).not.toHaveProperty('series')
    expect(parseViewSpec(stacked({ series: '' })).blocks[0]).not.toHaveProperty('series')
  })

  it('refuses a series outside the result, or the same as x or y', () => {
    fails(stacked({ series: 'industry' }), /series must be a column of the result: stage, status, fv/)
    fails(stacked({ series: 'stage' }), /series must be a different column from x and y/)
  })
})

describe('cleanParams', () => {
  const spec = parseViewSpec({ ...valid, params: ['vehicle', 'as_of'] })

  it('keeps only the params the view offers', () => {
    const noParams = parseViewSpec({ ...valid, params: [] })
    expect(cleanParams(noParams, { vehicle: 'Example Fund I' })).toEqual({})
    expect(cleanParams(spec, { vehicle: ' Example Fund I ', as_of: '2026-06-30', other: 'x' })).toEqual({ vehicle: 'Example Fund I', as_of: '2026-06-30' })
  })

  it('refuses a date that is not a real day', () => {
    expect(() => cleanParams(spec, { as_of: '2026-02-31' })).toThrow(/real date/)
  })
})

describe('chart types', () => {
  const chart = (block: Record<string, unknown>) => ({ title: 'Charts', blocks: [{ label: 'C', format: 'currency', ...block }] })
  const byStage = positions({ group_by: ['stage'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }, { fn: 'sum', column: 'cost', as: 'cost' }] })

  it('accepts every chart type with its own options', () => {
    const spec = parseViewSpec({
      title: 'Charts',
      blocks: [
        { type: 'column', label: 'A', source: positions({ group_by: ['stage', 'status'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }), x: 'stage', y: 'fv', series: 'status', stack: 'grouped' },
        { type: 'area', label: 'B', source: byStage, x: 'stage', y: 'fv' },
        { type: 'pie', label: 'C', source: byStage, x: 'stage', y: 'fv', donut: true },
        { type: 'scatter', label: 'D', source: positions({ columns: ['company', 'cost', 'moic'] }), x: 'cost', y: 'moic', point_label: 'company', x_format: 'currency', format: 'multiple' },
        { type: 'combo', label: 'E', source: byStage, x: 'stage', y: 'cost', y2: 'fv', format2: 'currency' },
        { type: 'waterfall', label: 'F', source: byStage, x: 'stage', y: 'fv', total: false },
        { type: 'funnel', label: 'G', source: byStage, x: 'stage', y: 'fv' },
      ],
    })
    expect(spec.blocks.map(b => b.type)).toEqual(['column', 'area', 'pie', 'scatter', 'combo', 'waterfall', 'funnel'])
    expect(spec.blocks[0]).toMatchObject({ series: 'status', stack: 'grouped' })
    expect(spec.blocks[2]).toMatchObject({ donut: true })
    expect(spec.blocks[3]).toMatchObject({ point_label: 'company', x_format: 'currency' })
    expect(spec.blocks[4]).toMatchObject({ y2: 'fv', format2: 'currency' })
    expect(spec.blocks[5]).toMatchObject({ total: false })
  })

  it('needs y2 on a combo, and series only where it means something', () => {
    fails(chart({ type: 'combo', source: byStage, x: 'stage', y: 'cost' }), /y2 must be a column of the result/)
    fails(chart({ type: 'pie', source: byStage, x: 'stage', y: 'fv', series: 'cost' }), /series works on bar, column, line and area/)
    fails(chart({ type: 'column', source: positions({ group_by: ['stage', 'status'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] }), x: 'stage', y: 'fv', series: 'status', stack: 'sideways' }), /stack must be one of: stacked, grouped/)
  })
})

describe('report features in the spec', () => {
  const src = (extra: object = {}) => ({ tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company', 'fair_value', 'cost'] }, ...extra })

  it('takes calculated columns as result columns, and refuses a bad formula with its reason', () => {
    const spec = parseViewSpec({ title: 'T', blocks: [{ type: 'bar', label: 'G', x: 'company', y: 'gain', source: src({ computed: [{ as: 'gain', formula: 'fair_value - cost' }] }) }] })
    expect(spec.blocks[0]).toMatchObject({ y: 'gain', source: { computed: [{ as: 'gain', formula: 'fair_value - cost' }] } })
    fails({ title: 'T', blocks: [{ type: 'table', label: 'G', source: src({ computed: [{ as: 'gain', formula: 'fair_value - nav' }] }) }] }, /computed "gain": "nav" is not a column/)
    fails({ title: 'T', blocks: [{ type: 'table', label: 'G', source: src({ computed: [{ as: 'cost', formula: '1' }] }) }] }, /already a column/)
  })

  it('checks a pivot\'s three columns and a kpi comparison', () => {
    const grouped = { tool: 'query_portfolio', dataset: 'positions', query: { group_by: ['status', 'stage'], aggregates: [{ fn: 'sum', column: 'fair_value', as: 'fv' }] } }
    expect(parseViewSpec({ title: 'P', blocks: [{ type: 'pivot', label: 'P', source: grouped, rows: 'status', columns: 'stage', value: 'fv' }] }).blocks[0])
      .toMatchObject({ type: 'pivot', rows: 'status', columns: 'stage', value: 'fv', format: 'number' })
    fails({ title: 'P', blocks: [{ type: 'pivot', label: 'P', source: grouped, rows: 'status', columns: 'status', value: 'fv' }] }, /three different columns/)
    fails({ title: 'K', blocks: [{ type: 'kpi', label: 'K', source: grouped, value: 'fv', compare: 'last_week' }] }, /compare must be one of/)
  })

  it('keeps filters on dataset columns, a range only on dates or numbers', () => {
    const spec = parseViewSpec({ title: 'F', filters: ['stage', { column: 'fair_value', kind: 'range', label: 'Fair value' }], blocks: [{ type: 'table', label: 'T', source: src() }] })
    expect(spec.filters).toEqual([{ column: 'stage', label: 'Stage', kind: 'pick' }, { column: 'fair_value', label: 'Fair value', kind: 'range' }])
    fails({ title: 'F', filters: ['nope'], blocks: [{ type: 'table', label: 'T', source: src() }] }, /Filter 1/)
    fails({ title: 'F', filters: [{ column: 'stage', kind: 'range' }], blocks: [{ type: 'table', label: 'T', source: src() }] }, /range needs a date or number/)
  })
})
