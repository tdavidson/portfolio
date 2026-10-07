import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every API route that reads entity-keyed data (a vehicle's books, a company's holdings, a deal, an
 * LP's position) scopes it to the caller's entities — through the vehicle resolver, an entity-scope
 * helper (lib/access/scope.ts, entity-scope.ts), or the API gate for one company or deal
 * (lib/access/entity-gate.ts) — or is listed below with why it does not yet.
 *
 * The list IS the remaining work: phase 2 (LPs) and phase 3 (email, notes, AI, import) of
 * plans/spec-entity-access-and-portfolio.md. Scoping a route means deleting its line. A NEW route
 * reading these tables fails this test until it scopes or is listed — so the surface cannot grow
 * behind the list's back. Restricted members must not be invited until no `phase` line remains.
 */
const PENDING: Record<string, string> = {
  'api/accounting/fof-extract': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/accounting/k1-deliveries': 'phase 2: LPs, K-1s and LP tax',
  'api/accounting/k1-packages/export': 'phase 2: LPs, K-1s and LP tax',
  'api/accounting/k1-packages/pdf': 'phase 2: LPs, K-1s and LP tax',
  'api/accounting/state-worklist': 'phase 2: LPs, K-1s and LP tax',
  'api/accounting/tax-forms': 'phase 2: LPs, K-1s and LP tax',
  'api/analyst/conversations': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/compliance': 'phase 2: LPs, K-1s and LP tax',
  'api/cron/deal-research': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/cron/deals-digest': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/dashboard/notes/[noteId]': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/diligence/[id]/email-intake': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/accept-to-diligence': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/attachment/[index]': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/attachments': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/reprocess': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/reroute': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/[id]/reviews': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/emails/save-to-drive': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/import': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/import/documents': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/inbound-email': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/inbound-email/mailgun': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/interactions': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/lps/onboarding': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/onboarding/facts': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/onboarding/request': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/onboarding/sort': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/onboarding/sort/confirm': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/preview': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/preview/document/[id]': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/preview/snapshot/[id]/pdf': 'phase 2: LPs, K-1s and LP tax',
  'api/lps/snapshots': 'phase 2: LPs, K-1s and LP tax',
  'api/metrics/[id]': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/notes': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/notes/mark-read': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/portal/access-history': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/documents': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/documents/[id]': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/letters/[id]': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/notices': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/notices/ack': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/onboarding': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/onboarding/consent': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/onboarding/upload-url': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/overview': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/portal/snapshots/[id]': 'exempt: the LP portal — an LP’s own documents, authenticated as that LP, not a fund member',
  'api/public/submit/[token]': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/requests': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/requests/responses': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/review': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/review/[id]/resolve': 'phase 3: email, review, notes, interactions, requests, import, metrics, AI',
  'api/settings/notifications': 'exempt: admin-only settings; admins see every entity',
}
/** The tables whose rows belong to an entity. RLS covers the first group (20261007100200). */
function entityTables(): string[] {
  const sql = readFileSync('supabase/migrations/20261007100200_entity_rls.sql', 'utf8')
  const start = sql.indexOf('tables text[] := array[')
  const rls = Array.from(sql.slice(start, sql.indexOf('];', start)).matchAll(/'([a-z_0-9]+)'/g)).map(m => m[1])
  const lp = ['lp_investments', 'lp_entities', 'lp_positions', 'lp_capital_events', 'commitment_events', 'capital_calls',
    'capital_call_lines', 'distributions', 'distribution_lines', 'lp_letters', 'lp_documents', 'lp_snapshots',
    'k1_packages', 'k1_lines', 'k1_partners', 'received_k1s']
  return [...rls, ...lp]
}

const SCOPED = /resolveGroupOr400|resolveMancoGroupOr400|loadEntityScope|loadEntityScopeForUser|entityScopeFor|visibleVehicleIds|visibleVehicleNames|canSeeVehicle|assertVehicleVisible|resolveHoldingVehicle|loadLpScope|lpVisible|scopeLiveReport|assertAdminAccess|role !== 'admin'/
/**
 * Routes the API gate already confines to one visible company or deal (lib/access/entity-gate.ts),
 * whose payload is about that company or deal as a whole — its notes, documents, metrics. A route
 * under these whose payload is PER ENTITY (a company's transactions, a fund holding's register)
 * must scope it in the handler; the fund-holding routes are therefore deliberately not here.
 */
const GATED = [/^api\/companies\/\[id\]/, /^api\/deals\/\[id\]/, /^api\/lp-letters\/\[id\]/]

/**
 * A file's handlers, separately: a GET that scopes says nothing about the POST beside it. A handler
 * is judged together with the file's local helper functions it calls (one level deep), wherever
 * they are defined — a write path that resolves its entity through a shared local helper is scoped.
 * Imports are not code: naming a helper in an import is not calling it.
 */
function handlers(src: string): string[] {
  const body = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  // Top-level declarations start at column 0.
  const chunks = body.split(/\n(?=(?:export )?(?:async )?function \w+|(?:export )?const \w+ = (?:async )?\()/)
  const named = chunks.map(c => ({ name: c.match(/function (\w+)|const (\w+) =/)?.slice(1).find(Boolean) ?? '', text: c }))
  const isHandler = (n: string) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(n)
  const helpers = named.filter(c => c.name && !isHandler(c.name))
  const hs = named.filter(c => isHandler(c.name))
  if (hs.length === 0) return [body]
  return hs.map(h => h.text + helpers.filter(x => new RegExp(`\\b${x.name}\\(`).test(h.text)).map(x => x.text).join('\n'))
}

function routes(dir = 'app/api', out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) routes(p, out)
    else if (e === 'route.ts') out.push(p)
  }
  return out
}

describe('entity scope on API routes', () => {
  const tables = entityTables()
  const unscoped = routes()
    .filter(f => handlers(readFileSync(f, 'utf8')).some(h =>
      tables.some(t => new RegExp(`from\\(\\s*['"]${t}['"]`).test(h)) && !SCOPED.test(h)))
    .map(f => f.replace(/^app\//, '').replace(/\/route\.ts$/, ''))
    .filter(key => !GATED.some(g => g.test(key)))

  it('scopes every route that reads entity data, or lists why not', () => {
    expect(unscoped.filter(k => !(k in PENDING)), 'scope these to the caller\'s entities (lib/access/scope.ts) or list them with a reason').toEqual([])
  })

  it('keeps the list honest — a scoped route comes off it', () => {
    expect(Object.keys(PENDING).filter(k => !unscoped.includes(k))).toEqual([])
  })
})
