import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FundHoldingNavs } from '@/components/fund-holding-navs'

const render = (navs: any[]) => renderToStaticMarkup(createElement(FundHoldingNavs, { navs, busy: false, onEdit: () => {}, onDelete: () => {} }))

describe('a holding\'s NAV statements', () => {
  it('lists each statement with whether its mark is on the ledger, and edit and delete actions', () => {
    const html = render([
      { id: 'n2', as_of_date: '2026-06-30', reported_nav: 1500, basis: 'preliminary', investment_transaction_id: 't2' },
      { id: 'n1', as_of_date: '2026-03-31', reported_nav: 1000, basis: 'final', investment_transaction_id: null },
    ])
    expect(html).toContain('2026-06-30')
    expect(html).toContain('Mark booked')
    expect(html).toContain('No mark')
    expect(html.match(/>Edit</g)).toHaveLength(2)
    expect(html.match(/>Delete</g)).toHaveLength(2)
    expect(html).toContain('tabular-nums')
    expect(html).not.toContain('font-mono')
  })

  it('says the position carries at cost when there are none', () => {
    expect(render([])).toContain('carries at cost')
  })
})

describe('a read-only member', () => {
  it('sees the statements without edit or delete', () => {
    const html = renderToStaticMarkup(createElement(FundHoldingNavs, {
      navs: [{ id: 'n1', as_of_date: '2026-03-31', reported_nav: 1000, basis: 'final', investment_transaction_id: null }],
      busy: false, readOnly: true, onEdit: () => {}, onDelete: () => {},
    }))
    expect(html).toContain('2026-03-31')
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('>Delete<')
  })
})

describe('the ledger column and re-booking', () => {
  const rows = [
    { id: 'n2', as_of_date: '2026-06-30', reported_nav: 1500, basis: 'final', investment_transaction_id: 't2', vehicle_id: 'v1' },
    { id: 'n1', as_of_date: '2026-03-31', reported_nav: 1000, basis: 'final', investment_transaction_id: null, vehicle_id: 'v1' },
    { id: 'n0', as_of_date: '2025-12-31', reported_nav: 900, basis: 'final', investment_transaction_id: null, vehicle_id: null },
  ]
  const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(FundHoldingNavs, {
    navs: rows as any, busy: false, onEdit: () => {}, onDelete: () => {}, onRebook: () => {}, ...over,
  }))

  it('a statement naming no entity reads "Not booked"; one with no mark says why it might have none', () => {
    const out = html()
    expect(out).toContain('Not booked')
    expect(out).toContain('No mark')
    expect(out).toMatch(/title="Either the ledger already carried this value, or the mark was refused/)
  })

  it('offers "Re-book mark" once, on the newest statement, to someone who can write', () => {
    expect(html().match(/>Re-book mark</g)).toHaveLength(1)
    expect(html({ readOnly: true })).not.toContain('Re-book mark')
    expect(html({ onRebook: undefined })).not.toContain('Re-book mark')
  })
})
