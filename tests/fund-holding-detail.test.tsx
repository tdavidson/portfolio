import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { FundHoldingDetail } from '@/components/fund-holding-detail'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import type { FeatureVisibilityMap } from '@/lib/types/features'

const access = (role: 'admin' | 'member'): ClientAccess => ({
  role, features: DEFAULT_FEATURE_VISIBILITY as FeatureVisibilityMap, grants: {}, defaults: {},
})

const render = (role: 'admin' | 'member', props: Record<string, unknown> = {}) => renderToStaticMarkup(
  <AccessProvider value={access(role)}><FundHoldingDetail companyId="c1" {...props} /></AccessProvider>,
)

/**
 * The register records notices and NAV statements in dialogs behind one Add menu, not in forms that
 * sit open on the page. (Server render: the first paint, before the register has loaded.)
 */
describe('a fund holding\'s register', () => {
  it('offers one Add menu to someone who can write, and no always-open form', () => {
    const html = render('admin')
    expect(html).toContain('aria-label="Fund register"')
    expect(html).not.toContain('>Fund register</h2>')
    expect(html).toMatch(/aria-haspopup="menu"[^>]*>.*Add/)
    expect(html).not.toContain('id="ev-date"')
    expect(html).not.toContain('id="nav-date"')
    expect(html).not.toContain('>Record<')
  })

  it('offers no Add to a read-only member', () => {
    const html = render('member')
    expect(html).toContain('aria-label="Fund register"')
    expect(html).not.toContain('aria-haspopup="menu"')
  })
})

describe('the register\'s dialogs', () => {
  const src = readFileSync('components/fund-holding-detail.tsx', 'utf8')

  it('records a call, a distribution and a NAV statement, plus the generic form when the page offers it', () => {
    for (const label of ['Capital call', 'Distribution', 'NAV statement', 'Other transaction']) expect(src).toContain(`label: '${label}'`)
    expect(src).toMatch(/onAddTransaction \? \[/)
    expect(src).toContain("label: 'Transfer cost'")
  })

  it('puts the Add menu in the Position over time heading once there is a chart', () => {
    expect(src).toMatch(/Position over time<\/h3>\s*\{addMenu\}/)
    expect(src).toContain('{!hasChart && addMenu && ')
  })

  it('keeps the entity choice inside each dialog for a holding with no entity yet', () => {
    expect(src.match(/\{dialogEntity\}/g)).toHaveLength(2)
    expect(src).toContain('Which entity holds this fund?')
  })

  it('charts the position from the register it loaded', () => {
    expect(src).toContain('fundPositionSeries(events, navs)')
    expect(src).toContain('<FundPositionChart points={positionPoints} />')
  })

  it('keeps the NAV explanation in the NAV dialog', () => {
    expect(src).toMatch(/Record a NAV statement<\/DialogTitle>[\s\S]*?The valuation date is the manager/)
  })
})

describe('the holding page', () => {
  const src = readFileSync('app/(app)/companies/[id]/page-view.tsx', 'utf8')

  it('hides the investments section\'s own Add for a fund holding, routing it through the register\'s menu', () => {
    expect(src).toContain('hideAddButton={panels.register}')
    expect(src).toContain('onAddTransaction={() => setTxnAddRequest(n => n + 1)}')
  })

  it('shows the AI summary and the KPI charts by their own flags, not the company profile\'s', () => {
    expect(src).toMatch(/sections\.analyst && active && \(\s*<CompanySummary/)
    expect(src).toMatch(/sections\.metrics && active && \(\s*<CompanyCharts/)
    // One empty state for metrics on every kind of holding: the company page's.
    expect(src).not.toContain('compactEmpty')
  })

  it('offers Transfer cost from the register\'s Add menu, not a button of its own', () => {
    expect(src).toContain('transferRequest={transferRequest}')
    expect(src).toMatch(/onTransferCost=\{/)
  })
})

describe('the position chart', () => {
  it('says when it will start, with nothing to draw', async () => {
    const { FundPositionChart } = await import('@/components/fund-position-chart')
    const html = renderToStaticMarkup(createElement(FundPositionChart, { points: [] }))
    expect(html).toContain('first confirmed notice or NAV statement')
  })

  it('draws from category tokens, never raw palette colours, and has no second y-axis', () => {
    const src = readFileSync('components/fund-position-chart.tsx', 'utf8')
    expect(src).toMatch(/hsl\(var\(--cat-\d\)\)/)
    expect(src).not.toMatch(/#[0-9a-f]{6}/i)
    expect(src.match(/<YAxis/g)).toHaveLength(1)
  })
})
