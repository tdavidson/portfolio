import { describe, expect, it } from 'vitest'
import { ACCOUNTING_SECTIONS } from '@/lib/accounting/nav'
import { FUND_SUBPAGE_SLUGS } from '@/components/fund-subpages'

// /funds/<x> is either an entity id or a section's firm-wide landing, decided by FUND_SUBPAGE_SLUGS
// (app/(app)/funds/[id]/page.tsx). A section in the nav without a slug there is looked up as an
// entity named after it — /funds/forecast answered "no forecast vehicle".
describe('firm-wide section landings', () => {
  it('every section in the nav has one', () => {
    const missing = ACCOUNTING_SECTIONS
      .map(s => s.href.replace(/^\/funds\//, ''))
      .filter(slug => slug && !slug.includes('/') && !FUND_SUBPAGE_SLUGS.has(slug))
    expect(missing).toEqual([])
  })
})
