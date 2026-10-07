/** The static subpage slugs under a fund — anything else in the `/funds/<x>` slot is a
 *  vehicle id (the detail page). Kept so the detail page can bounce an old bare link.
 *
 *  Lives in a plain (non-`'use client'`) module so both the server fund-detail page and the
 *  client sidebar can import it. Exporting a `Set` from a client module turns it into a
 *  client-reference proxy on the server, so calling `.has()` there throws
 *  "Attempted to call has() from the server but has is on the client". */
export const FUND_SUBPAGE_SLUGS = new Set([
  'status', 'bank', 'journal', 'ledger', 'text', 'tax', 'periods', 'statements', 'capital-accounts', 'construction',
  'schedule-of-investments', 'allocation-terms', 'opening-balances', 'lp-events',
  'migrate',
])
