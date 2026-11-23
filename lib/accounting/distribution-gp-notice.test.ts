import { describe, it, expect } from 'vitest'
import { checkLineBreakdown } from './distributions'
import { distributionNoticeFigures, groupDistributionLines } from './notice-register'
import { buildNoticeHtml, type NoticeData } from './notice-pdf'

/**
 * The GP's own commitment and its carry on one distribution: two register lines (two entries, two
 * roll-forward buckets) and ONE notice that states the distribution on its capital investment and
 * the carried interest as separate amounts.
 */

const GP = 'gp-entity'
const raw = [
  { id: 'l-a', lp_entity_id: 'lp-a', amount: 900, role: 'lp', notice_document_id: null },
  { id: 'l-gp-carry', lp_entity_id: GP, amount: 250, role: 'carry', notice_document_id: 'doc-1' },
  { id: 'l-gp', lp_entity_id: GP, amount: 100, role: 'lp', notice_document_id: 'doc-1' },
]

describe('groupDistributionLines', () => {
  const lines = groupDistributionLines(raw, new Map([
    ['l-gp', { returnOfCapital: 60, preferred: 0, profit: 40 }],
    ['l-a', { returnOfCapital: 800, preferred: 50, profit: 50 }],
  ]))
  const gp = lines.find(l => l.lpEntityId === GP)!

  it('gives each partner one notice line, the GP\'s two register lines joined', () => {
    expect(lines).toHaveLength(2)
    expect(gp.amount).toBe(350)
    expect(gp.lineIds).toEqual(['l-gp', 'l-gp-carry'])
  })

  it('hangs the notice off the LP line, so it keeps the line it always had', () => {
    expect(gp.id).toBe('l-gp')
    expect(gp.role).toBe('lp')
    expect(gp.noticeDocumentId).toBe('doc-1')
  })

  it('marks a partner holding only carry as carry', () => {
    const [only] = groupDistributionLines([{ id: 'c', lp_entity_id: GP, amount: 10, role: 'carry' }])
    expect(only.role).toBe('carry')
  })
})

describe('distributionNoticeFigures', () => {
  const lines = groupDistributionLines(raw, new Map([
    ['l-gp', { returnOfCapital: 60, preferred: 0, profit: 40 }],
    ['l-a', { returnOfCapital: 800, preferred: 50, profit: 50 }],
  ]))

  it('splits the GP\'s figure into its capital investment and the carried interest', () => {
    const { components, ofWhich } = distributionNoticeFigures(lines.find(l => l.lpEntityId === GP)!, null)
    expect(ofWhich).toEqual([])
    expect(components).toEqual([
      {
        label: 'Distribution on your capital investment',
        amount: 100,
        detail: [{ label: 'Return of capital', value: 60 }, { label: 'Profit on capital', value: 40 }],
      },
      { label: 'Carried interest', amount: 250, detail: [] },
    ])
  })

  it('still separates the two without a stored breakdown, just without the detail', () => {
    const { components } = distributionNoticeFigures(groupDistributionLines(raw).find(l => l.lpEntityId === GP)!, null)
    expect(components!.map(c => [c.label, c.amount, c.detail])).toEqual([
      ['Distribution on your capital investment', 100, []],
      ['Carried interest', 250, []],
    ])
  })

  it('states an LP\'s own breakdown when the declaration stored one', () => {
    const { components, ofWhich } = distributionNoticeFigures(lines.find(l => l.lpEntityId === 'lp-a')!, { returnOfCapital: 1, preferred: 1, lpTotal: 1000 })
    expect(components).toBeNull()
    expect(ofWhich).toEqual([
      { label: 'Of which return of capital', value: 800 },
      { label: 'Of which preferred return', value: 50 },
      { label: 'Of which profit', value: 50 },
    ])
  })

  it('falls back to the fund-wide tiers for a distribution declared before breakdowns', () => {
    const [lp] = groupDistributionLines([{ id: 'x', lp_entity_id: 'lp-a', amount: 500, role: 'lp' }])
    const { ofWhich } = distributionNoticeFigures(lp, { returnOfCapital: 800, preferred: 0, lpTotal: 1000 })
    expect(ofWhich).toEqual([{ label: 'Of which return of capital', value: 400 }])
  })
})

describe('buildNoticeHtml — the GP notice', () => {
  const data: NoticeData = {
    kind: 'distribution',
    fundName: 'Example Fund',
    fundLogo: null,
    fundAddress: null,
    currency: 'USD',
    vehicle: 'Example Fund I',
    partnerName: 'Example GP LLC',
    noticeDate: '2026-12-15',
    amount: 350,
    components: [
      { label: 'Distribution on your capital investment', amount: 100, detail: [{ label: 'Return of capital', value: 60 }] },
      { label: 'Carried interest', amount: 250, detail: [] },
    ],
  }

  it('prints each part as its own figure, with the total', () => {
    const html = buildNoticeHtml(data)
    expect(html).toContain('Distribution on your capital investment')
    expect(html).toContain('Carried interest')
    expect(html).toContain('$100.00')
    expect(html).toContain('$250.00')
    expect(html).toContain('Total payable to you')
    expect(html).toContain('$350.00')
  })

  it('prints no breakdown table on a capital call, whatever it is given', () => {
    expect(buildNoticeHtml({ ...data, kind: 'capital_call' })).not.toContain('Total payable to you')
  })
})

describe('checkLineBreakdown', () => {
  const perLp = new Map([['lp-a', 900], [GP, 100]])

  it('accepts parts that add to each LP line', () => {
    const out = checkLineBreakdown(perLp, [{ lpEntityId: GP, returnOfCapital: 60, preferred: 0, profit: 40 }])
    expect(out).toBeInstanceOf(Map)
    expect((out as Map<string, unknown>).get(GP)).toEqual({ lpEntityId: GP, returnOfCapital: 60, preferred: 0, profit: 40 })
  })

  it('refuses parts that disagree with the line', () => {
    expect(checkLineBreakdown(perLp, [{ lpEntityId: GP, returnOfCapital: 60, preferred: 0, profit: 39 }])).toHaveProperty('error')
  })

  it('refuses a partner with no LP line, a repeat, or a negative part', () => {
    expect(checkLineBreakdown(perLp, [{ lpEntityId: 'nobody', returnOfCapital: 1, preferred: 0, profit: 0 }])).toHaveProperty('error')
    expect(checkLineBreakdown(perLp, [
      { lpEntityId: GP, returnOfCapital: 100, preferred: 0, profit: 0 },
      { lpEntityId: GP, returnOfCapital: 100, preferred: 0, profit: 0 },
    ])).toHaveProperty('error')
    expect(checkLineBreakdown(perLp, [{ lpEntityId: GP, returnOfCapital: 110, preferred: 0, profit: -10 }])).toHaveProperty('error')
  })
})
