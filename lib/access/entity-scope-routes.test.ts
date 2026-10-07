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
  'api/cron/affinity-sync': 'exempt: a job acting for the fund, not a member request',
  'api/cron/memo-agent-worker': 'exempt: a job acting for the fund, not a member request',
  'api/webhooks/transcription/[token]': 'exempt: a provider webhook, authenticated by its token',
  'api/portal/analyst': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/contact': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/letters/[id]/pdf': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/letters': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/messages': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/snapshots/[id]/pdf': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/snapshots': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/portal/statement/pdf': 'exempt: the LP portal — an LP’s own data, authenticated as that LP, not a fund member',
  'api/cron/deal-research': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/cron/deals-digest': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/inbound-email': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/inbound-email/mailgun': 'exempt: a job or webhook acting for the fund, not a member request',
  'api/lps/snapshots': 'exempt: GET lists fund-wide snapshot headers (name, date); their rows are lp_investments, scoped where read; writes are admin-only',
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
  'api/requests': 'exempt: asks are fund-wide (email_requests has no company or entity); sending is admin-only',
  'api/settings/notifications': 'exempt: admin-only settings; admins see every entity',
}
/**
 * The tables whose rows belong to an entity: every table the entity-RLS migrations name (read from
 * them, so a table added there is watched here too), plus the service-role-only LP and tax tables
 * RLS cannot cover and the compliance tables keyed by entity name.
 */
function entityTables(): string[] {
  const fromMigration = (file: string) => {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
    const start = sql.indexOf('tables text[] := array[')
    return Array.from(sql.slice(start, sql.indexOf('];', start)).matchAll(/'([a-z_0-9]+)'/g)).map(m => m[1])
  }
  return [
    ...fromMigration('20261007100200_entity_rls.sql'),
    ...fromMigration('20261007100300_entity_rls_lp.sql'),
    ...fromMigration('20261007100400_diligence_entity.sql'),
    'lp_snapshots', 'k1_packages', 'k1_lines', 'k1_partners', 'received_k1s', 'lp_tax_forms', 'k1_deliveries',
    'k1_delivery_consents', 'lp_onboarding_item_documents',
    'compliance_fund_settings', 'compliance_deadlines',
  ]
}

const SCOPED = /resolveGroupOr400|resolveMancoGroupOr400|loadEntityScope|loadEntityScopeForUser|entityScopeFor|visibleVehicleIds|visibleVehicleNames|canSeeVehicle|assertVehicleVisible|resolveHoldingVehicle|loadLpScope|lpVisible|scopeLiveReport|assertK1PackageVisible|lpDocumentVisible|loadLpScopeForUser|filterByCompany|entityIdentityChangeDenial|assertAdminAccess|role !== 'admin'\)\s*(?:\{\s*)?return/
/**
 * Routes the API gate already confines to one visible company or deal (lib/access/entity-gate.ts),
 * whose payload is about that company or deal as a whole — its notes, documents, metrics. A route
 * under these whose payload is PER ENTITY (a company's transactions, a fund holding's register)
 * must scope it in the handler; the fund-holding routes are therefore deliberately not here.
 */
const GATED = [/^api\/companies\/\[id\]/, /^api\/deals\/\[id\]/, /^api\/lp-letters\/\[id\]/,
  /^api\/diligence\/\[id\]/, /^api\/emails\/\[id\]/, /^api\/metrics\/\[id\]/, /^api\/review\/\[id\]/, /^api\/dashboard\/notes\/\[noteId\]/]

/**
 * A file's handlers, separately: a GET that scopes says nothing about the POST beside it. A handler
 * is judged together with the file's local helper functions it calls (one level deep), wherever
 * they are defined — a write path that resolves its entity through a shared local helper is scoped.
 * Imports are not code: naming a helper in an import is not calling it.
 */
function handlers(src: string): string[] {
  const body = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    // Comments are not code: a helper named in a comment is not a call.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
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
