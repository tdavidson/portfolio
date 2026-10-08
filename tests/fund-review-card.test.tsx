// tests/fund-review-card.test.tsx
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FundReviewCard, resolveSummary } from '@/components/fund-review-card'

const base = { id: 'r1', context_snippet: 'Ending capital 9,445,000', company: { id: 'h1', name: 'Meridian Growth Partners IV' } }
const render = (item: any, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(FundReviewCard, {
  item, entities: [{ id: 'v1', name: 'Fund I' }, { id: 'v2', name: 'Fund II' }], busy: false, onResolve: () => {}, ...extra,
}))

describe('a manager-email proposal', () => {
  it('shows a NAV with its date and amount, the entity, and approve and dismiss', () => {
    const html = render({ ...base, issue_type: 'fund_nav', vehicle: { id: 'v1', name: 'Fund I' },
      payload: { kind: 'nav', asOfDate: '2025-09-30', reportedNav: 9_445_000, fundName: 'Meridian', confidence: 'high', sourceText: null } })
    expect(html).toContain('Manager NAV')
    expect(html).toContain('2025-09-30')
    expect(html).toContain('Fund I')
    expect(html).toContain('tabular-nums')
    expect(html).not.toContain('font-mono')
    expect(html).toContain('>Approve<')
    expect(html).toContain('>Dismiss<')
    expect(html).not.toContain('Which entity holds this fund?')
  })

  it('asks for the entity when the review names none, and flags an assumed date', () => {
    const html = render({ ...base, issue_type: 'fund_capital_call', vehicle: null,
      payload: { kind: 'call', eventDate: '2025-09-30', dueDate: null, noticeNumber: 'Drawdown No. 7', purpose: null, amount: 1_250_000, dateAssumed: true, fundName: 'Meridian', confidence: 'low', sourceText: null } })
    expect(html).toContain('Which entity holds this fund?')
    expect(html).toContain('Fund II')
    expect(html).toContain('Drawdown No. 7')
    expect(html).toMatch(/date shown is assumed/)
    expect(html).toContain('Low confidence')
  })

  it('hides approve and dismiss from a read-only member', () => {
    const html = render({ ...base, issue_type: 'fund_nav', vehicle: null,
      payload: { kind: 'nav', asOfDate: '2025-09-30', reportedNav: 1, fundName: 'M', confidence: 'high', sourceText: null } }, { readOnly: true })
    expect(html).toContain('2025-09-30')
    expect(html).not.toContain('>Approve<')
    expect(html).not.toContain('>Dismiss<')
    expect(html).not.toContain('Which entity holds this fund?')
  })
})

describe('resolveSummary', () => {
  it('says the booking, every later NAV, and the warning', () => {
    expect(resolveSummary({
      message: 'NAV saved.', later: [{ message: 'A re-booked.' }, { message: 'B refused.' }], warning: 'Check the register.',
    })).toBe('NAV saved. Newer statement: A re-booked. Newer statement: B refused. Check the register.')
    expect(resolveSummary({})).toBeNull()
  })
})
