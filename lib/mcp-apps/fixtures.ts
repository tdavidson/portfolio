// Sample dashboards for a made-up fund: one payload per view, typed against the contract in
// payload.ts so a change to the contract that the samples do not follow fails the type check.
//
// Used by the view's tests and by scripts/mcp-app-check.mjs, which renders each of these inside
// the official MCP Apps host. No real fund's data is here.

import { VIEW_TOOL } from './payload'
import type {
  CompanyMetricSeries, CompanyPayload, DashboardBranding, DashboardPayload, LpPayload, LpRow,
  PartnerCapitalRow, PortfolioPayload, PortfolioPosition, StatementLine, StatementsPayload,
} from './payload'

const branding: DashboardBranding = { fundName: 'Northgate Ventures', currency: 'USD', cssVars: '' }
const now = '2026-10-09T18:14:00.000Z'
const co = (company: string, stage: string, industry: string, cost: number, fairValue: number, realized = 0, status = 'active'): PortfolioPosition => ({
  company, companyId: company.toLowerCase().replace(/[^a-z]+/g, '-'), status, stage, industry: [industry],
  cost, fairValue, unrealized: fairValue - cost, realized, moic: cost > 0 ? Math.round(((fairValue + realized) / cost) * 100) / 100 : null, pctOfPortfolio: 0,
})
const positions = [
  co('Meridian Robotics', 'Series B', 'Robotics', 2400000, 9800000),
  co('Halcyon Health', 'Series A', 'Healthcare', 1800000, 5200000),
  co('Tessellate', 'Series A', 'Developer tools', 1500000, 3900000),
  co('Brightwater Energy Storage Systems', 'Seed', 'Climate', 900000, 2700000),
  co('Loomwork', 'Seed', 'Fintech', 1200000, 1450000),
  co('Quillfeather', 'Seed', 'Media', 750000, 1100000, 300000),
  co('Paper Lantern', 'Pre-seed', 'Consumer', 500000, 620000),
  co('Ironbark Logistics', 'Series A', 'Logistics', 1400000, 600000),
  co('Sable & Finch', 'Seed', 'Marketplace', 800000, 540000),
  co('Driftwood Labs', 'Pre-seed', 'AI', 400000, 400000),
  co('Castellan', 'Seed', 'Security', 650000, 380000),
  co('Ostrander Bio', 'Seed', 'Biotech', 700000, 350000),
  co('Fennel', 'Pre-seed', 'Consumer', 300000, 150000),
  co('Greyfriar', 'Pre-seed', 'Fintech', 250000, 0, 0, 'written_off'),
]
const tf = positions.reduce((s, p) => s + p.fairValue, 0)
positions.forEach(p => { p.pctOfPortfolio = Math.round((p.fairValue / tf) * 10000) / 100 })
const tc = positions.reduce((s, p) => s + p.cost, 0)
const tr = positions.reduce((s, p) => s + p.realized, 0)

export const portfolio: PortfolioPayload = {
  view: 'portfolio', title: 'Portfolio overview', subtitle: 'All vehicles · as of 9 Oct 2026', args: {}, generatedAt: now, branding,
  data: {
    asOf: '2026-10-09', vehicle: 'all', positions,
    totals: { cost: tc, fairValue: tf, unrealized: tf - tc, realized: tr, grossMoic: Math.round(((tf + tr) / tc) * 100) / 100 },
    performance: [
      { vehicle: 'Fund I', committed: 20000000, called: 14500000, unfunded: 5500000, distributed: 2100000, nav: 22400000, dpi: 0.14, rvpi: 1.54, tvpi: 1.69 },
      { vehicle: 'Meridian SPV', committed: 3000000, called: 3000000, unfunded: 0, distributed: 0, nav: 5600000, dpi: 0, rvpi: 1.87, tvpi: 1.87 },
    ],
  },
}

const q = ['Q1 24', 'Q2 24', 'Q3 24', 'Q4 24', 'Q1 25', 'Q2 25', 'Q3 25', 'Q4 25', 'Q1 26', 'Q2 26', 'Q3 26']
const series = (name: string, unit: string | null, vals: number[]): CompanyMetricSeries => ({ name, unit, values: vals.map((value, i) => ({ period: q[q.length - vals.length + i], value })) })
export const company: CompanyPayload = {
  view: 'company', title: 'Meridian Robotics', subtitle: 'Series B · Robotics', args: { company: 'meridian-robotics' }, generatedAt: now, branding,
  data: {
    id: 'meridian-robotics', name: 'Meridian Robotics', status: 'active', stage: 'Series B', industry: ['Robotics'], vehicles: ['Fund I', 'Meridian SPV'],
    overview: 'Warehouse picking robots sold as a service to mid-market third-party logistics operators. Led the seed; followed on in the A and B.',
    summary: { invested: 2400000, fairValue: 9800000, realized: 0, moic: 4.08, grossIrr: 0.612 },
    rounds: [
      { roundName: 'Seed', date: '2022-03-14', invested: 400000, shares: 800000, sharePrice: 0.5, currentValue: 3360000, realized: 0 },
      { roundName: 'Series A', date: '2023-06-02', invested: 1000000, shares: 588235, sharePrice: 1.7, currentValue: 2470587, realized: 0 },
      { roundName: 'Series B', date: '2025-02-20', invested: 1000000, shares: 238095, sharePrice: 4.2, currentValue: 1000000, realized: 0 },
    ],
    metrics: [
      series('ARR', '$', [1200000, 1500000, 1900000, 2600000, 3100000, 3900000, 4800000, 5600000, 6900000, 8100000, 9400000]),
      series('Headcount', 'people', [24, 27, 31, 38, 44, 52, 58, 63, 71, 78, 84]),
      series('Gross margin', '%', [41, 43, 44, 48, 51, 53, 55, 54, 57, 59, 61]),
      series('Runway', 'months', [18, 15, 12, 26, 23, 20, 17, 14, 30, 27, 24]),
      series('Robots deployed', null, [110, 160, 240, 330, 420, 560, 700, 880, 1090, 1310, 1560]),
    ],
  },
}

const sec = (label: string, rows: StatementLine[]) => ({ label, rows, total: rows.reduce((s, r) => s + r.amount, 0) })
const assets = sec('Assets', [
  { code: '1000', name: 'Cash', amount: 1840000 }, { code: '1100', name: 'Investments at cost', amount: 11650000 },
  { code: '1200', name: 'Unrealized appreciation', amount: 15540000 }, { code: '1300', name: 'Due from LPs', amount: 250000 },
])
const liabilities = sec('Liabilities', [{ code: '2000', name: 'Accrued expenses', amount: 85000 }, { code: '2100', name: 'Management fee payable', amount: 100000 }])
const income = sec('Income', [{ code: '4200', name: 'Net unrealized gain', amount: 3120000 }, { code: '4100', name: 'Realized gain', amount: 300000 }, { code: '4000', name: 'Interest income', amount: 21000 }])
const expenses = sec('Expenses', [{ code: '5000', name: 'Management fees', amount: 300000 }, { code: '5100', name: 'Professional fees', amount: 64000 }, { code: '5200', name: 'Fund administration', amount: 36000 }])
const act = (c: number, d: number, f: number, e: number, g: number) => [
  { label: 'Contributions', amount: c }, { label: 'Distributions', amount: d }, { label: 'Management fees', amount: f },
  { label: 'Partnership expenses', amount: e }, { label: 'Net unrealized gain / (loss)', amount: g },
]
const partners: PartnerCapitalRow[] = [
  { name: 'Alder Family Office', beginning: 6100000, activity: act(500000, -420000, -75000, -25000, 780000), ending: 6860000 },
  { name: 'Harborline Endowment', beginning: 9150000, activity: act(750000, -630000, -112500, -37500, 1170000), ending: 10290000 },
  { name: 'Kestrel Pension Trust', beginning: 7320000, activity: act(600000, -504000, -90000, -30000, 936000), ending: 8232000 },
  { name: 'M. Okafor', beginning: 1830000, activity: act(150000, -126000, -22500, -7500, 234000), ending: 2058000 },
]
const tot = (k: 'beginning' | 'ending') => partners.reduce((s, p) => s + p[k], 0)
export const statements: StatementsPayload = {
  view: 'statements', title: 'Financial statements', subtitle: 'Fund I · YTD 2026', args: { vehicle: 'Fund I', period: 'ytd' }, generatedAt: now, branding,
  data: {
    vehicle: 'Fund I', period: { preset: 'ytd', label: 'YTD 2026', start: '2026-01-01', end: '2026-10-09' },
    balanceSheet: { assets, liabilities, equityLabel: "Partners' capital", equityTotal: assets.total - liabilities.total, check: 0, unallocatedEarnings: 1021000 },
    incomeStatement: { income, expenses, netIncome: income.total - expenses.total },
    cashFlows: {
      operating: { label: 'Operating activities', rows: [{ name: 'Purchase of investments', amount: -2400000 }, { name: 'Proceeds from realizations', amount: 300000 }, { name: 'Management fees paid', amount: -200000 }, { name: 'Expenses paid', amount: -79000 }], total: -2379000 },
      financing: { label: 'Financing activities', rows: [{ name: 'Capital contributions', amount: 2000000 }, { name: 'Distributions', amount: -1680000 }], total: 320000 },
      netChange: -2059000, openingCash: 3899000, endingCash: 1840000,
    },
    partnersCapital: {
      partners,
      totals: { name: 'Total', beginning: tot('beginning'), activity: act(0, 0, 0, 0, 0).map((a, i) => ({ label: a.label, amount: partners.reduce((s, p) => s + p.activity[i].amount, 0) })), ending: tot('ending') },
      carryWithheld: false,
    },
  },
}

const lp = (investor: string, entity: string, vehicle: string, commitment: number, calledPct: number, distributions: number, nav: number, irr: number | null): LpRow => {
  const paidIn = Math.round(commitment * calledPct)
  return { investor, entity, vehicle, commitment, paidIn, distributions, nav, dpi: paidIn ? Math.round((distributions / paidIn) * 100) / 100 : null, rvpi: paidIn ? Math.round((nav / paidIn) * 100) / 100 : null, tvpi: paidIn ? Math.round(((distributions + nav) / paidIn) * 100) / 100 : null, irr }
}
const rows = [
  lp('Harborline Endowment', 'Harborline Endowment', 'Fund I', 6000000, 0.725, 630000, 6720000, 0.214),
  lp('Kestrel Pension Trust', 'Kestrel Pension Trust', 'Fund I', 5000000, 0.725, 504000, 5600000, 0.214),
  lp('Alder Family Office', 'Alder Holdings LP', 'Fund I', 3000000, 0.725, 315000, 3360000, 0.214),
  lp('Alder Family Office', 'Alder Trust II', 'Meridian SPV', 1500000, 1, 0, 2800000, 0.39),
  lp('M. Okafor', 'M. Okafor', 'Fund I', 1500000, 0.725, 126000, 1680000, 0.214),
  lp('Pinecrest Foundation', 'Pinecrest Foundation', 'Fund I', 2000000, 0.725, 210000, 2240000, 0.214),
  lp('Rowan & Vale Partners', 'Rowan & Vale Partners', 'Fund I', 1500000, 0.5, 105000, 1120000, 0.18),
  lp('S. Lindqvist', 'S. Lindqvist', 'Meridian SPV', 1500000, 1, 0, 2800000, 0.39),
  lp('General Partner', 'Northgate GP LLC', 'Fund I', 1000000, 0.725, 105000, 1120000, null),
]
const t = (k: 'commitment' | 'paidIn' | 'distributions' | 'nav') => rows.reduce((s, r) => s + r[k], 0)
export const lps: LpPayload = {
  view: 'lps', title: 'LP capital', subtitle: 'All vehicles · as of 9 Oct 2026', args: {}, generatedAt: now, branding,
  data: { asOf: '2026-10-09', vehicle: 'all', rows, totals: { commitment: t('commitment'), paidIn: t('paidIn'), distributions: t('distributions'), nav: t('nav'), dpi: Math.round((t('distributions') / t('paidIn')) * 100) / 100, rvpi: Math.round((t('nav') / t('paidIn')) * 100) / 100, tvpi: Math.round(((t('distributions') + t('nav')) / t('paidIn')) * 100) / 100 } },
}
export const SAMPLE_DASHBOARDS = { portfolio, company, statements, lps }

/** The sample each `show_*` tool returns, for a host standing in for the MCP server. */
export const SAMPLE_BY_TOOL: Record<string, DashboardPayload> = {
  [VIEW_TOOL.portfolio]: portfolio,
  [VIEW_TOOL.company]: company,
  [VIEW_TOOL.statements]: statements,
  [VIEW_TOOL.lps]: lps,
}
