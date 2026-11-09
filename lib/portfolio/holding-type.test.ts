import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * A fund-of-funds holding lives in `companies` behind a `holding_type` discriminator, so
 * every COMPANY-SHAPED surface has to exclude funds or it silently starts showing them:
 * founder-email routing, sector/stage charts, default-metric seeding, LP letter aggregation.
 *
 * This exists for the same reason lib/design-tokens.test.ts and lib/access/route-domains.test.ts
 * do: the failure is invisible in review and obvious in production. A new `.from('companies')`
 * list query must either filter holding_type or be allowlisted WITH a reason.
 */

// Call sites that legitimately do NOT filter, each with the reason it does not.
const ALLOWLIST = new Map<string, string>([
  ['lib/accounting/portfolio-fees.ts', 'by-id check that a fee\'s company is one of the fund\'s; any holding can pay a fee'],
  ['lib/accounting/recycling.ts', 'Checks only that a recycled exit\'s company id is in the fund; a direct company and a fund holding can both exit.'],
  ['lib/onboarding/wizard-server.ts', 'a head-only count: does the fund hold any data yet (any holding kind)'],
  ['lib/onboarding/progress.ts', 'a head-only count for the setup checklist — any holding kind means investments are loaded'],
  ['lib/accounting/ownership.ts', 'names for the companies of transactions already identified by id — any holding kind'],
  ['lib/portfolio/sheet-load.ts', 'metadata for every holding kind on the portfolio sheet, by ids the schedule already produced'],
  ['lib/accounting/investment-backfill.ts', 'names for every holding type — funds and crypto backfill alongside companies'],
  // By-id lookups: the id already identifies one holding, and the detail routes serve both kinds.
  ['app/api/companies/[id]/route.ts', 'single holding by id — serves company and fund detail alike'],
  ['app/api/companies/[id]/documents/route.ts', 'scoped to one holding by id'],
  ['app/api/companies/[id]/interactions/route.ts', 'scoped to one holding by id'],
  ['app/api/companies/[id]/investments/route.ts', 'scoped to one holding by id; fund calls post here too'],
  ['app/api/companies/[id]/metrics/route.ts', 'scoped to one holding by id'],
  ['app/api/companies/[id]/notes/route.ts', 'scoped to one holding by id'],
  ['lib/notes/create.ts', 'the @mention list for a note: names any holding the writer may tag, as the notes route always did'],
  ['app/api/companies/[id]/summary/route.ts', 'scoped to one holding by id'],
  ['app/api/companies/[id]/default-metrics/route.ts', 'scoped to one holding by id'],
  ['app/api/companies/[id]/default-metrics/[defaultId]/route.ts', 'scoped to one holding by id'],
  ['app/(app)/companies/[id]/page.tsx', 'scoped to one holding by id (the title)'],
  ['app/(app)/companies/[id]/load.ts', 'scoped to one holding by id'],
  ['app/(app)/emails/[id]/load.ts', 'resolves one holding by the email\'s company_id'],
  ['app/api/analyst/conversations/route.ts', 'resolves fund_id from one holding id'],
  ['app/api/emails/[id]/route.ts', 'resolves one holding by the email\'s company_id'],
  ['lib/access/company-delete.ts', 'single holding by id — the delete guard serves company and fund-holding delete alike'],
  // Name resolution for a set of ids already gathered elsewhere. The ids came from rows that
  // reference a holding, so re-filtering by type would blank the name rather than exclude it.
  ['app/(app)/interactions/load.ts', 'resolves names for an id set already gathered from interactions'],
  ['app/api/interactions/route.ts', 'resolves names for an id set already gathered from interactions'],
  ['app/api/notes/route.ts', 'resolves names for an id set already gathered from notes'],
  ['app/api/review/route.ts', 'resolves names for an id set already gathered from emails'],
  ['lib/review/resolve.ts', "the agent's review queue: resolves names for an id set already gathered from emails"],
  ['app/api/emails/save-to-drive/route.ts', 'resolves drive folders for an explicit id set'],
  ['app/api/settings/notifications/route.ts', 'validates an explicit subscribed-company id set'],
  ['lib/portfolio/fof-register.ts', 'resolves one fund holding\'s name by id for the entry memo'],
  ['lib/portfolio/transaction-edit.ts', 'resolves one holding name by id for the memo'],
  // LEDGER paths. A fund holding is a real position with 1100/1200 balances, exactly like a
  // company — so anything reconciling the ledger, pricing positions, or computing carry must
  // see BOTH kinds. Filtering these to companies would break the tie-outs, not tidy them.
  ['app/api/accounting/investments/route.ts', 'ledger-vs-tracker tie-out covers every position, funds included'],
  ['app/api/accounting/deal-carry/route.ts', 'deal-by-deal carry is computed over every position, funds included'],
  ['lib/accounting/realized-capital.ts', 'the deal-by-deal capital base is every position the vehicle realized, funds included'],
  ['lib/accounting/fee-schedule.ts', 'a fee on invested capital is charged on every position the vehicle holds, funds included, as the deal-by-deal base reads them'],
  ['lib/accounting/fund-timeseries.ts', 'cost and value over time cover every position, funds included'],
  ['lib/lp-templates/performance-load.ts', "the ILPA portfolio table's gross returns cover every position the vehicle holds, funds included"],
  ['lib/accounting/import-review.ts', 'compares imported books to every investment position, including fund holdings'],
  ['lib/accounting/status.ts', 'the schedule-of-investments tie-out must cover every ledger position'],
  ['lib/accounting/statement-package.ts', 'the SOI needs both kinds to tie to the ledger; it splits them for display by holdingType'],
  ['lib/accounting/close.ts', 'the pre-close quoted-position check values every ledger position; a feed is what selects them, not holding_type'],
  // Intentionally all holdings.
  ['lib/accounting/retract-adopted.ts', "by-id lookup of an adopted entry's owners; fund and crypto holdings carry transactions too"],
  ['lib/portfolio/cost-transfer.ts', 'by-id name lookup of the two holdings in a cost transfer; cost moves between holdings of any kind'],
  ['lib/accounting/escrow-exit-review.ts', 'by-id name lookup for exits with escrow; an exit from a fund or crypto holding is reviewed the same way'],
  ['lib/vehicles.ts', 'vehicle rollups cover every holding a vehicle owns, funds included'],
  ['lib/accounting/holdings-firm.ts', 'the firm-wide schedule of investments reports every holding an entity owns, fund and crypto holdings included, sectioned by type'],
  ['app/api/settings/route.ts', 'fund deletion must remove every holding, fund holdings included'],
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const ROOTS = ['app', 'lib', 'components']
const ALL = ROOTS.flatMap(r => sourceFiles(r))

// Matches `.from('companies')` AND `.from('companies' as any)` — the cast form is used
// wherever the generated types lag the schema, and an anchored regex silently missed it.
const COMPANIES_QUERY = /\.from\(\s*['"]companies['"]/
const queriesCompanies = (src: string) => COMPANIES_QUERY.test(src)

describe('holding_type discriminator', () => {
  it('filters holding_type on every company-shaped query', () => {
    const offenders: string[] = []
    for (const f of ALL) {
      const rel = f.replace(/\\/g, '/')
      if (ALLOWLIST.has(rel)) continue
      const src = readFileSync(f, 'utf8')
      if (!queriesCompanies(src)) continue
      if (!/holding_type/.test(src)) offenders.push(rel)
    }
    expect(offenders, `these query companies without filtering holding_type:\n${offenders.join('\n')}`).toEqual([])
  })

  it('keeps the allowlist honest', () => {
    const stale = Array.from(ALLOWLIST.keys()).filter(f => {
      if (!ALL.includes(f)) return true                       // file moved or deleted
      return !queriesCompanies(readFileSync(f, 'utf8'))        // no longer queries companies
    })
    expect(stale, `allowlist entries that no longer apply:\n${stale.join('\n')}`).toEqual([])
  })

  it('requires a reason for every allowlist entry', () => {
    for (const [f, reason] of Array.from(ALLOWLIST)) expect(reason.length, f).toBeGreaterThan(20)
  })
})
