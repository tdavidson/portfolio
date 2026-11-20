// Many live report cards from one build of the fund's report (lib/lp-report-cards).
// Every name and figure here is invented.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ live: vi.fn(), current: vi.fn(), linked: vi.fn() }))
vi.mock('@/lib/accounting/live-report', () => ({ generateLiveReport: m.live }))
vi.mock('@/lib/accounting/live-report-cache', () => ({ currentLiveReport: m.current }))
vi.mock('@/lib/fund-connections', () => ({ linkedLiveRows: m.linked }))

import { buildLiveReportCards, groupIntoCards } from '@/lib/lp-report-cards'
import { cardInvestmentRows, uniqueFileNames } from '@/lib/lp-report-cards-zip'

const entities = [
  { id: 'e1', entity_name: 'Acme Trust', investor_id: 'i1', lp_investors: { id: 'i1', name: 'Acme' } },
  { id: 'e2', entity_name: 'Acme Holdings', investor_id: 'i1', lp_investors: { id: 'i1', name: 'Acme' } },
  { id: 'e3', entity_name: 'Northwind LLC', investor_id: 'i2', lp_investors: { id: 'i2', name: 'Northwind' } },
]
let investors: { id: string; name: string; parent_id: string | null }[] = []
const admin = {
  from: (table: string) => {
    const data = table === 'lp_investors' ? investors : entities
    const chain: any = { select: () => chain, eq: () => chain, then: (res: any) => res({ data, error: null }) }
    return chain
  },
} as any

const row = (entity_id: string, portfolio_group: string, asOf: string | null, extra: Record<string, unknown> = {}) => ({
  entity_id, portfolio_group, source: 'ledger', commitment: 100_000, paid_in_capital: 50_000, called_capital: 50_000,
  distributions: 10_000, nav: 60_000, total_value: 70_000, receivable: 0, dpi: 0.2, rvpi: 1.2, tvpi: 1.4, irr: 0.1,
  evidence: asOf ? { asOf } : null, ...extra,
}) as any

const report = (asOf: string | null = '2026-09-30') => ({
  asOf,
  computedAt: '2026-10-01T00:00:00Z',
  rows: [
    row('e1', 'Example Fund I', '2026-06-30'),
    row('e2', 'Example Fund II', '2026-09-30', { lookThroughVia: 'Example GP Vehicle' }),
    row('e3', 'Example Fund I', null),
  ],
  vehicles: [],
  entityNames: new Map([['e1', 'Acme Trust'], ['e2', 'Acme Holdings'], ['e3', 'Northwind LLC']]),
})

beforeEach(() => {
  vi.clearAllMocks()
  m.current.mockResolvedValue(report())
  m.live.mockResolvedValue({ ...report('2025-12-31'), computedAt: undefined })
  m.linked.mockResolvedValue({ rows: [] })
  investors = [{ id: 'i1', name: 'Acme', parent_id: null }, { id: 'i2', name: 'Northwind', parent_id: null }]
})

describe('buildLiveReportCards', () => {
  it('builds the fund once and cuts every investor\'s card from it, each with its own As of', async () => {
    const out = await buildLiveReportCards(admin, 'f1', { includeConnected: true })
    expect(m.current).toHaveBeenCalledTimes(1)
    expect(m.live).not.toHaveBeenCalled()
    expect(out.refreshedAt).toBe('2026-10-01T00:00:00Z')
    expect(out.cards.map(c => [c.investorName, c.rows.length, c.asOf])).toEqual([
      ['Acme', 2, '2026-09-30'],
      // No evidence date: the report's own.
      ['Northwind', 1, '2026-09-30'],
    ])
    expect(m.linked).toHaveBeenCalledTimes(1)
    expect(m.linked).toHaveBeenCalledWith(admin, expect.objectContaining({ fundId: 'f1', investorIds: ['i1', 'i2'] }))
  })

  it('a past date for one investor builds only the vehicles their entities hold', async () => {
    const out = await buildLiveReportCards(admin, 'f1', { asOf: '2025-12-31', investorIds: ['i1'] })
    expect(m.live).toHaveBeenCalledWith(admin, 'f1', '2025-12-31', { entityIds: ['e1', 'e2'] })
    expect(out.refreshedAt).toBeNull()
    expect(out.cards.map(c => c.investorId)).toEqual(['i1'])
    expect(m.linked).not.toHaveBeenCalled()
  })

  it('applies the caller\'s row scope and omits carry recipients before grouping', async () => {
    const out = await buildLiveReportCards(admin, 'f1', {
      selectRows: rows => rows.filter(r => r.portfolio_group === 'Example Fund I'),
      omit: new Map([['Example Fund I', new Set(['e3'])]]),
    })
    expect(out.cards.map(c => [c.investorId, c.rows.map(r => r.row.entity_id)])).toEqual([['i1', ['e1']]])
  })
})

describe('investor groupings', () => {
  beforeEach(() => {
    // Northwind rolls up under Acme, as the LPs page shows it.
    investors = [{ id: 'i1', name: 'Acme', parent_id: null }, { id: 'i2', name: 'Northwind', parent_id: 'i1' }]
  })

  it('puts an investor grouped under a parent on the parent\'s card, under the parent\'s name', async () => {
    const out = await buildLiveReportCards(admin, 'f1', { includeConnected: true })
    expect(out.cards.map(c => [c.investorId, c.investorName, c.rows.map(r => [r.entityName, r.row.entity_id])])).toEqual([
      ['i1', 'Acme', [['Acme Trust', 'e1'], ['Acme Holdings', 'e2'], ['Northwind LLC', 'e3']]],
    ])
    // Connections are per investor: every member of the group is asked for.
    expect(m.linked).toHaveBeenCalledWith(admin, expect.objectContaining({ investorIds: ['i1', 'i2'] }))
  })

  it('asking for the child gives the group\'s card, built from every member\'s vehicles', async () => {
    const out = await buildLiveReportCards(admin, 'f1', { asOf: '2025-12-31', investorIds: ['i2'] })
    expect(m.live).toHaveBeenCalledWith(admin, 'f1', '2025-12-31', { entityIds: ['e1', 'e2', 'e3'] })
    expect(out.cards.map(c => [c.investorId, c.rows.length])).toEqual([['i1', 3]])
  })

  it('puts a member\'s connected-fund rows on the group\'s card', async () => {
    m.linked.mockResolvedValue({ rows: [{ investorId: 'i2', fundId: 'f2', entityName: 'Northwind LLC', row: row('x1', 'Example Opportunity Fund', null) }] })
    const out = await buildLiveReportCards(admin, 'f1', { includeConnected: true })
    expect(out.cards[0].rows.map(r => r.key)).toContain('f2-x1-Example Opportunity Fund')
  })

  it('a parent loop stops where it repeats', async () => {
    investors = [{ id: 'i1', name: 'Acme', parent_id: 'i2' }, { id: 'i2', name: 'Northwind', parent_id: 'i1' }]
    const out = await buildLiveReportCards(admin, 'f1')
    expect(out.cards).toHaveLength(2)
  })
})

describe('groupIntoCards', () => {
  it('adds connected-fund rows only to a card the caller already gets', () => {
    const linked = [
      { investorId: 'i1', fundId: 'f2', entityName: 'Acme Trust (connected)', row: row('x1', 'Example Opportunity Fund', '2026-12-31') },
      { investorId: 'i9', fundId: 'f2', entityName: 'Someone else', row: row('x9', 'Example Opportunity Fund', '2026-12-31') },
    ]
    const cards = groupIntoCards([row('e1', 'Example Fund I', '2026-06-30')], new Map([['e1', { entityName: 'Acme Trust', investorId: 'i1', investorName: 'Acme' }]]), new Map(), linked, null)
    expect(cards).toHaveLength(1)
    expect(cards[0].rows.map(r => r.key)).toEqual(['e1-Example Fund I', 'f2-x1-Example Opportunity Fund'])
    expect(cards[0].asOf).toBe('2026-12-31')
  })
})

describe('the PDF side', () => {
  it('turns a card into the template\'s rows, keeping look-through', () => {
    const [card] = groupIntoCards([row('e2', 'Example Fund II', null, { lookThroughVia: 'Example GP Vehicle' })], new Map([['e2', { entityName: 'Acme Holdings', investorId: 'i1', investorName: 'Acme' }]]), new Map(), [], null)
    expect(cardInvestmentRows(card)[0]).toMatchObject({
      portfolio_group: 'Example Fund II', paid_in_capital: 50_000, lookThroughVia: 'Example GP Vehicle',
      lp_entities: { entity_name: 'Acme Holdings', investor_id: 'i1', lp_investors: { id: 'i1', name: 'Acme' } },
    })
  })

  it('names each file safely and never twice', () => {
    expect(uniqueFileNames(['Acme', 'Acme', 'Jane / Doe', ''], 'LP Report — 2026')).toEqual([
      'Acme - LP Report  2026.pdf', 'Acme - LP Report  2026 (2).pdf', 'Jane  Doe - LP Report  2026.pdf', 'Investor - LP Report  2026.pdf',
    ])
  })
})
