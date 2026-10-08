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
