// tests/email-review-modal-fund.test.tsx
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReviewCard } from '@/components/email-review-modal'

const card = (issue_type: string) => renderToStaticMarkup(createElement(ReviewCard, {
  item: { id: 'r1', issue_type, extracted_value: '9445000', context_snippet: null, company: { id: 'h1', name: 'Meridian IV' }, metric: null } as any,
  resolving: false, editing: false, editValue: '', onEditValueChange: () => {},
  onAccept: () => {}, onReject: () => {}, onStartEdit: () => {}, onCancelEdit: () => {}, onSubmitEdit: () => {},
}))

describe('a fund review in the email review modal', () => {
  it('names the proposal in plain words and offers no free-text "Edit & Accept"', () => {
    for (const [type, label] of [['fund_nav', 'Fund NAV'], ['fund_capital_call', 'Capital call'], ['fund_distribution', 'Distribution']]) {
      const html = card(type)
      expect(html).toContain(label)
      expect(html).not.toContain(type)
      expect(html).not.toContain('Edit &amp; Accept')
    }
  })

  it('a metric review keeps "Edit & Accept"', () => {
    expect(card('low_confidence')).toContain('Edit &amp; Accept')
  })
})
