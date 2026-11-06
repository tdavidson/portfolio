import { describe, expect, it } from 'vitest'
import { memoryAdmin } from './helpers/memory-admin'
import {
  cleanReportedFigure, formatReportedFigure, latestReportedFigures, recordReportedFigures, reportedFiguresAsOf,
} from '@/lib/accounting/reported-figures'

const FUND = 'f1'
const seed = () => ({
  fund_vehicles: [{ id: 'v1', fund_id: FUND, name: 'Fund I', aliases: [] }, { id: 'v2', fund_id: FUND, name: 'Fund II', aliases: [] }],
  vehicle_reported_figures: [] as any[],
})
const ctx = { fundId: FUND, userId: 'u1', vehicleNames: null }

describe('a reported figure, as given', () => {
  it('reads multiples and IRRs the way a source states them', () => {
    expect(cleanReportedFigure({ metric: 'tvpi', value: '1.16x' })).toMatchObject({ metric: 'tvpi', basis: 'net', value: 1.16 })
    expect(cleanReportedFigure({ metric: 'irr', value: '4.73%' })).toMatchObject({ value: 0.0473 })
    expect(cleanReportedFigure({ metric: 'irr', value: 4.73 })).toMatchObject({ value: 0.0473 })
    expect(cleanReportedFigure({ metric: 'irr', value: 0.0473 })).toMatchObject({ value: 0.0473 })
    expect(cleanReportedFigure({ metric: 'irr', value: '-2.5%' })).toMatchObject({ value: -0.025 })
    expect(cleanReportedFigure({ metric: 'dpi', value: '0x' })).toMatchObject({ value: 0 })
  })

  it('refuses what it cannot read', () => {
    expect(cleanReportedFigure({ metric: 'nav', value: '1' })).toMatch(/metric must be/)
    expect(cleanReportedFigure({ metric: 'tvpi', value: 'n/a' })).toMatch(/must be a number/)
    expect(cleanReportedFigure({ metric: 'tvpi', value: '-1x' })).toMatch(/negative/)
    expect(cleanReportedFigure({ metric: 'tvpi', basis: 'pro forma', value: '1x' })).toMatch(/net or gross/)
  })

  it('states them as a letter does', () => {
    expect(formatReportedFigure({ metric: 'tvpi', value: 1.16 })).toBe('1.16x')
    expect(formatReportedFigure({ metric: 'dpi', value: 0 })).toBe('0.00x')
    expect(formatReportedFigure({ metric: 'irr', value: 0.0473 })).toBe('4.73%')
  })
})

describe('recording and reading reported figures', () => {
  it('records them for a vehicle and date, with the source, and reads back exactly that date', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const out = await recordReportedFigures(admin, ctx, {
      vehicle: 'Fund I', as_of: '2026-09-30', source: 'Example Administrator',
      figures: [{ metric: 'tvpi', value: '1.16x' }, { metric: 'dpi', value: '0x' }, { metric: 'irr', value: '4.73%' }],
    })
    expect(out.ok).toBe(true)
    expect(tables.vehicle_reported_figures).toHaveLength(3)
    expect(tables.vehicle_reported_figures[0]).toMatchObject({ fund_id: FUND, vehicle_id: 'v1', as_of: '2026-09-30', source: 'Example Administrator', recorded_by: 'u1' })

    const q3 = await reportedFiguresAsOf(admin, FUND, 'Fund I', '2026-09-30')
    expect(q3.map(f => [f.metric, f.value])).toEqual([['tvpi', 1.16], ['dpi', 0], ['irr', 0.0473]])
    // Another date is not the quarter's, however close.
    expect(await reportedFiguresAsOf(admin, FUND, 'Fund I', '2026-10-01')).toEqual([])
    expect(await reportedFiguresAsOf(admin, FUND, 'Fund II', '2026-09-30')).toEqual([])
  })

  it('gives each vehicle its latest date on or before the as-of', async () => {
    const { admin } = memoryAdmin(seed())
    await recordReportedFigures(admin, ctx, { vehicle: 'Fund I', as_of: '2026-06-30', source: 'Example Administrator', figures: [{ metric: 'tvpi', value: '1.1x' }] })
    await recordReportedFigures(admin, ctx, { vehicle: 'Fund I', as_of: '2026-09-30', source: 'Example Administrator', figures: [{ metric: 'tvpi', value: '1.2x' }] })
    expect((await latestReportedFigures(admin, FUND)).get('Fund I')?.map(f => f.value)).toEqual([1.2])
    expect((await latestReportedFigures(admin, FUND, '2026-08-01')).get('Fund I')?.map(f => f.value)).toEqual([1.1])
  })

  it('refuses a vehicle the member cannot see, an unknown vehicle, no source and a figure given twice', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const base = { vehicle: 'Fund I', as_of: '2026-09-30', source: 'Example Administrator', figures: [{ metric: 'tvpi', value: '1x' }] }
    expect(await recordReportedFigures(admin, { ...ctx, vehicleNames: ['Fund II'] }, base)).toMatchObject({ ok: false, status: 403 })
    expect(await recordReportedFigures(admin, ctx, { ...base, vehicle: 'Fund IX' })).toMatchObject({ ok: false, status: 404 })
    expect(await recordReportedFigures(admin, ctx, { ...base, source: ' ' })).toMatchObject({ ok: false, status: 400 })
    expect(await recordReportedFigures(admin, ctx, { ...base, as_of: 'Q3' })).toMatchObject({ ok: false, status: 400 })
    expect(await recordReportedFigures(admin, ctx, { ...base, figures: [{ metric: 'tvpi', value: '1x' }, { metric: 'tvpi', value: '1.1x' }] })).toMatchObject({ ok: false, status: 400 })
    expect(tables.vehicle_reported_figures).toHaveLength(0)
  })

  it('reads nothing, rather than failing, before the table exists', async () => {
    const { admin, failNext } = memoryAdmin(seed())
    failNext('vehicle_reported_figures', 'select', 'relation "vehicle_reported_figures" does not exist')
    expect(await reportedFiguresAsOf(admin, FUND, 'Fund I', '2026-09-30')).toEqual([])
  })
})
