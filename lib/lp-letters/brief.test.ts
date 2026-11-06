import { describe, expect, it } from 'vitest'
import { buildLetterBrief, checkLetterDraft, redactor, MISSING_HEADING, type StoredUpdate } from './brief'
import type { CompanyLetterData, PortfolioPreview } from './aggregate'
import { letterVoice } from './skill'
import type { ReportedFigure } from '@/lib/accounting/reported-figures-shared'

const company = (over: Partial<CompanyLetterData['investment']> & { companyId: string; companyName: string }, extra: Partial<CompanyLetterData> = {}): CompanyLetterData => ({
  investment: {
    status: 'active', stage: 'Seed', industry: null, overview: null, whyInvested: null, currentUpdate: null,
    totalInvested: 1_000_000, totalRealized: 0, unrealizedValue: 2_000_000, fmv: 2_000_000, moic: 2, priceEvents: [],
    ...over,
  },
  metrics: [],
  recentNotes: [],
  latestSummary: 'An AI summary that must not be a source.',
  latestUpdate: null,
  ...extra,
})

const STYLE = 'Open with the three most important themes. Close with next quarter\'s priorities.'
const VOICE = letterVoice({ name: 'House style', styleGuide: STYLE })

const preview = (companies: CompanyLetterData[], fundMetrics: PortfolioPreview['fundMetrics'] = null): PortfolioPreview => ({
  asOf: '2026-09-30', fundName: 'Hemlock Ventures', fundCurrency: 'USD', periodLabel: 'Q3 2026', portfolioGroup: 'Hemlock Fund I',
  companies, fundMetrics,
  totals: { totalInvested: 3_000_000, totalFmv: 2_000_000, totalRealized: 0, portfolioMoic: 0.67, activeCount: 2, exitedCount: 0, writtenOffCount: 1 },
})

const acme = company({ companyId: 'c1', companyName: 'Acme' }, {
  metrics: [
    { metricName: 'ARR', unit: '$', unitPosition: 'prefix', valueType: 'number', currency: 'USD', currentValue: 1_200_000, currentLabel: 'Q3 2026', previousValue: 900_000, previousLabel: 'Q2 2026' },
    { metricName: 'Headcount', unit: null, unitPosition: 'suffix', valueType: 'number', currency: null, currentValue: null, currentLabel: 'Q3 2026', previousValue: 20, previousLabel: 'Q2 2026' },
  ],
  recentNotes: ['Board call: Pat Investor LP asked about hiring.'],
})
const birch = company({
  companyId: 'c2', companyName: 'Birch', fmv: 400_000, unrealizedValue: 400_000, moic: 0.4,
  priceEvents: [
    { date: '2024-01-10', kind: 'round', round: 'Seed', sharePrice: 1.5, valueChange: null },
    { date: '2026-08-01', kind: 'round', round: 'Series A', sharePrice: 0.9, valueChange: null },
  ],
})
const cedar = company({ companyId: 'c3', companyName: 'Cedar', status: 'written-off', fmv: 0, unrealizedValue: 0, moic: 0 })

const updates = new Map<string, StoredUpdate[]>([
  ['c1', [{ receivedAt: '2026-10-05T12:00:00Z', subject: 'Q3 update', periodLabel: 'Q3 2026', text: 'Acme ARR reached $1.2M. Contact ceo@acme.com. Pat Investor LP joined the call. Next quarter we launch in Europe.' }]],
])

const fundMetrics = { committedCapital: 10_000_000, paidInCapital: 6_000_000, distributions: 1_000_000, fmv: 7_000_000, dpi: 0.17, rvpi: 1.17, tvpi: 1.33, irr: 0.124 }
const fig = (metric: ReportedFigure['metric'], value: number, as_of = '2026-09-30'): ReportedFigure =>
  ({ metric, basis: 'net', value, source: 'Example Administrator', as_of, note: null, recorded_at: null })
const reportedFigures = [fig('tvpi', 1.25), fig('dpi', 0.1), fig('irr', 0.0612)]
const grossPerformance = { irr: 0.183, moic: 1.45 }

describe('the letter brief', () => {
  const brief = buildLetterBrief({ preview: preview([acme, birch, cedar], fundMetrics), year: 2026, quarter: 3, updates, investorNames: ['Pat Investor LP', 'Acme'], voice: VOICE, grossPerformance, reportedFigures })

  it("takes structure from the fund's template and keeps the rules every letter follows", () => {
    expect(brief.fund).toBe('Hemlock Fund I')
    expect(brief.instructions).toContain('drafting the Q3 2026 LP letter for Hemlock Fund I')
    expect(brief.instructions).toContain(STYLE)
    expect(brief.instructions).toContain('gross or net')
    expect(brief.instructions).toContain(`"${MISSING_HEADING}"`)
    expect(brief.instructions).not.toContain('GUIDANCE FOR THIS LETTER')
    const guided = buildLetterBrief({ preview: preview([acme]), year: 2026, quarter: 3, updates, voice: VOICE, guidance: 'Lead with the Birch news.' })
    expect(guided.instructions).toContain('GUIDANCE FOR THIS LETTER:\nLead with the Birch news.')
  })

  it('says what date the figures are as of', () => {
    expect(brief.as_of).toBe('2026-09-30')
    expect(brief.basis_notes.join(' ')).toContain('Figures are as of 2026-09-30')
  })

  it('labels every performance figure gross or net, and amounts as cost or cash', () => {
    const acmeFigures = brief.companies[0].figures
    expect(acmeFigures).toContainEqual({ label: 'MOIC, gross', value: '2.00x', basis: 'gross' })
    expect(acmeFigures).toContainEqual({ label: 'Fair value, gross', value: '$2.0M', basis: 'gross' })
    expect(acmeFigures).toContainEqual({ label: 'Invested (cost)', value: '$1.0M', basis: 'cost' })
    // Net figures as the administrator reports them, never the ledger's 1.33x / 12.4%.
    expect(brief.fund_figures).toContainEqual({ label: 'TVPI, net', value: '1.25x', basis: 'net', source: 'Example Administrator', as_of: '2026-09-30' })
    expect(brief.fund_figures).toContainEqual({ label: 'IRR, net', value: '6.12%', basis: 'net', source: 'Example Administrator', as_of: '2026-09-30' })
    expect(brief.fund_figures).toContainEqual({ label: 'IRR, gross', value: '18.30%', basis: 'gross', source: 'Performance report (total portfolio)', as_of: '2026-09-30' })
    expect(brief.fund_figures).toContainEqual({ label: 'MOIC, gross', value: '1.45x', basis: 'gross', source: 'Performance report (total portfolio)', as_of: '2026-09-30' })
    expect(brief.fund_figures.map(f => f.value)).not.toContain('1.33x')
    expect(brief.fund_figures.map(f => f.label)).not.toEqual(expect.arrayContaining(['Capital called']))
    for (const f of [...brief.fund_figures, ...brief.companies.flatMap(c => c.figures)]) {
      if (/MOIC|TVPI|DPI|RVPI|IRR|fair value|proceeds/i.test(f.label)) expect(['gross', 'net'], f.label).toContain(f.basis)
    }
  })

  it('names write-offs, down rounds and below-cost positions from the books', () => {
    expect(brief.companies[1].events.join(' ')).toMatch(/^Down round this quarter: Series A on 2026-08-01 at \$0\.9\/share, below the prior round's \$1\.5\/share/)
    expect(brief.companies[1].events).toContain('Held below cost: gross MOIC 0.40x.')
    expect(brief.companies[2].events[0]).toMatch(/^Written off/)
  })

  it('keeps investors and email addresses out of the sources, and leaves AI summaries out', () => {
    const json = JSON.stringify(brief)
    expect(json).not.toContain('Pat Investor LP')
    expect(json).not.toContain('ceo@acme.com')
    expect(json).toContain('[investor]')
    expect(json).not.toContain('AI summary')
    // An investor that shares a company's name doesn't erase the company.
    expect(brief.companies[0].company).toBe('Acme')
    expect(brief.companies[0].updates_this_quarter[0].text).toContain('Acme')
  })

  it('lists what is missing', () => {
    expect(brief.missing_information).toContain('Acme: no Q3 2026 values for Headcount.')
    expect(brief.missing_information).toContain('Birch: no company update or KPI values are stored for Q3 2026.')
    // A write-off needs no update.
    expect(brief.missing_information.join(' ')).not.toContain('Cedar')
    const none = buildLetterBrief({ preview: preview([acme], fundMetrics), year: 2026, quarter: 3, updates, voice: VOICE })
    // No recorded net figure: each is missing, and none is worked out from the ledger instead.
    for (const m of ['TVPI, net', 'DPI, net', 'IRR, net']) {
      expect(none.missing_information.some(x => x.startsWith(m) && x.includes('record_fund_figures'))).toBe(true)
      expect(none.fund_figures.map(f => f.label)).not.toContain(m)
    }
    // A figure as of another date is not the quarter's.
    const stale = buildLetterBrief({ preview: preview([acme]), year: 2026, quarter: 3, updates, voice: VOICE, reportedFigures: [fig('tvpi', 1.2, '2026-06-30')] })
    expect(stale.fund_figures.map(f => f.label)).not.toContain('TVPI, net')
  })
})

describe('reviewing a draft', () => {
  const brief = buildLetterBrief({ preview: preview([acme, birch, cedar], fundMetrics), year: 2026, quarter: 3, updates, voice: VOICE, grossPerformance, reportedFigures })
  const good = [
    'Three themes shaped Q3 2026.',
    'Acme grew ARR to $1.2M, up from $900,000, and holds at a gross MOIC of 2.00x.',
    'Birch closed a down round: its Series A priced at $0.9/share, below the Seed. It is held below cost at a gross MOIC of 0.40x.',
    'Cedar was written off.',
    'The fund stands at a net TVPI of 1.25x and a net IRR of 6.12%.',
    '',
    'Missing information',
    '- Headcount for Acme.',
  ].join('\n')

  it('passes a draft that sticks to the sources', () => {
    expect(checkLetterDraft(good, brief, [])).toEqual([])
  })

  it('flags invented numbers, unlabeled performance, unstated events, a missing list and investor names', () => {
    const bad = [
      'Acme grew ARR 85% to $1.2M.',
      'The fund TVPI is 1.25x.',
      'We thank Pat Investor LP for their support.',
    ].join('\n')
    const flags = checkLetterDraft(bad, brief, ['Pat Investor LP'])
    expect(flags).toContain(`No "${MISSING_HEADING}" section at the end.`)
    expect(flags).toContain('"85%" does not appear in the sources.')
    expect(flags.some(f => f.startsWith('Performance figure without "gross" or "net": "The fund TVPI is 1.25x."'))).toBe(true)
    expect(flags).toContain('Does not say plainly that Birch had a down round.')
    expect(flags).toContain('Does not say plainly that Cedar was written off.')
    expect(flags).toContain('Names an investor in the fund (Pat Investor LP).')
  })

  it('accepts rounding the sources support, and ignores years, quarters and small counts', () => {
    expect(checkLetterDraft(`${good}\nIn 2026 Acme's ARR passed $1.20 million across 3 markets.`, brief, [])).toEqual([])
  })

  it('takes a number inside a name for part of the name, and still checks counts and figures', () => {
    expect(checkLetterDraft(`${good}\nAcme now sells to a Fortune 500 retailer and made the Inc. 5000 list.`, brief, [])).toEqual([])
    const flags = checkLetterDraft(`${good}\nAcme hired 40 engineers.\nHeadcount: 45.\nRevenue 700 came in.`, brief, [])
    for (const n of ['40', '45', '700']) expect(flags.some(f => f.startsWith(`"${n}"`)), n).toBe(true)
  })
})

describe('redactor', () => {
  it('replaces whole names only', () => {
    const clean = redactor(['Ann'])
    expect(clean('Ann and Annual plan')).toBe('[investor] and Annual plan')
  })
})

describe('the brief: dates, confidentiality, subsequent events and partner sources', () => {
  const dated = company({ companyId: 'c4', companyName: 'Delta' }, {
    latestUpdate: 'Delta signed its first two enterprise customers and is hiring a sales lead.',
    latestUpdateAt: '2026-03-02T10:00:00Z',
    afterQuarterEnd: [
      { date: '2026-10-20', kind: 'investment', round: 'Series A', amount: 500_000, sharePrice: 2 },
      { date: '2026-10-25', kind: 'mark', round: null, amount: -100_000, sharePrice: null },
    ],
  })
  const secret = new Map<string, StoredUpdate[]>([
    ['c4', [{ receivedAt: '2026-10-02T00:00:00Z', subject: 'Confidential: board pack', periodLabel: 'Q3 2026', text: 'Term sheet signed at a higher price.' }]],
  ])
  const p = preview([dated])
  const b = buildLetterBrief({
    preview: p, year: 2026, quarter: 3, updates: secret, voice: VOICE, grossPerformance: { irr: 0.183, moic: null },
    partnerNotes: 'Lead with the Delta round.', sources: [{ name: 'market.pdf', text: 'Seed valuations fell 10% in the quarter.' }],
  })
  const c = b.companies[0]

  it('dates the stored update and marks it stale when it predates the quarter', () => {
    expect(c).toMatchObject({ stored_business_update_at: '2026-03-02', stored_business_update_stale: true, letter_status: 'Active' })
  })

  it('marks an update its sender called confidential, and says how to treat it', () => {
    expect(c.updates_this_quarter[0].confidential).toBe(true)
    expect(b.instructions).toMatch(/marked confidential is background only/)
  })

  it('lists events after quarter end as dated subsequent events', () => {
    expect(c.after_quarter_end).toEqual(['2026-10-20: the fund invested $500K (Series A).', '2026-10-25: marked down by $100K.'])
  })

  it('carries gross IRR as a gross figure, and the partners\' notes and documents as sources', () => {
    expect(b.fund_figures).toContainEqual(expect.objectContaining({ label: 'IRR, gross', value: '18.30%', basis: 'gross' }))
    expect(b.partner_notes).toBe('Lead with the Delta round.')
    expect(b.sources).toEqual([{ name: 'market.pdf', text: 'Seed valuations fell 10% in the quarter.' }])
  })

  it('names exits and write-offs the way a letter does, and lists a missing gross IRR', () => {
    const q = buildLetterBrief({ preview: preview([company({ companyId: 'x', companyName: 'Exa', status: 'exited' }), cedar]), year: 2026, quarter: 3, updates: new Map(), voice: VOICE })
    expect(q.companies.map(x => x.letter_status)).toEqual(['Acquired', 'Written Off'])
    expect(q.missing_information.some(m => /^IRR, gross/.test(m))).toBe(true)
  })
})

describe('the brief: new investments and their round terms', () => {
  const withTerms = company({ companyId: 'c5', companyName: 'Echo' }, {
    investmentsThisQuarter: [
      {
        date: '2026-08-12', amount: 500_000, round: 'Series A', security: 'Preferred', postMoney: null,
        terms: { round_size: 10_000_000, valuation: 40_000_000, valuation_basis: 'post_money', currency: null, lead: 'Example Ventures', security: null, discount_pct: null, rights: 'pro rata, board observer', notes: null },
      },
      { date: '2026-09-01', amount: 100_000, round: 'Seed extension', security: null, postMoney: 12_000_000, terms: null },
    ],
  })
  const b = buildLetterBrief({ preview: preview([withTerms]), year: 2026, quarter: 3, updates: new Map(), voice: VOICE })

  it('states each investment with its stored terms, and the books\' post-money where no terms are stored', () => {
    expect(b.companies[0].new_investments).toEqual([
      '2026-08-12: the fund invested $500K (Series A, Preferred). Round terms: round size $10.0M; post-money valuation $40.0M; led by Example Ventures; rights: pro rata, board observer.',
      '2026-09-01: the fund invested $100K (Seed extension). Post-money valuation in the books: $12.0M.',
    ])
  })

  it('lists an investment without terms as missing', () => {
    expect(b.missing_information.filter(m => /no round terms/.test(m))).toEqual([
      expect.stringContaining('Echo: no round terms are stored for the Seed extension on 2026-09-01'),
    ])
  })
})
