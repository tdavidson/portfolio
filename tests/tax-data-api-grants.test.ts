import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// The guardrail on who may reach partner tax data, and how.
//
// Every table below is served exclusively through a route gated on the `lp_capital` domain and
// the `tax_reporting` feature (lib/access/route-domains.ts), and read there with
// createAdminClient(). That is the whole access story — which means a stray Data API grant is
// not a second, weaker door: it is a door with no lock, because the grants know nothing about
// domains or features. `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to the browser, so
// `grant select ... to authenticated` on k1_lines hands every partner's K-1 figures to a fund
// member the middleware refuses, from the console, with no route involved.
//
// The repo's own table template (CLAUDE.md) grants `authenticated` full CRUD, which is right for
// an ordinary table and wrong for these — so the mistake is one step away at all times, and a
// convention nothing enforces is a convention that decays. Same shape as books.test.ts and
// route-domains.test.ts: read the migrations, fail on anything that widened.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Tables whose only access path is a gated route holding the service-role key. */
const SERVICE_ROLE_ONLY = [
  'lp_tax_forms',
  'k1_packages',
  'k1_partners',
  'k1_lines',
  'tax_year_closes',
  'received_k1s',
  'k1_delivery_consents',
  'k1_deliveries',
  'tax_year_close_events',
]

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .map(name => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }))
}

interface GrantSite {
  file: string
  table: string
  roles: string[]
}

function scan(re: RegExp): GrantSite[] {
  const out: GrantSite[] = []
  for (const { name, sql } of migrationFiles()) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) {
      out.push({
        file: name,
        table: m[1].toLowerCase(),
        roles: m[2].split(',').map((r: string) => r.trim().toLowerCase()),
      })
    }
  }
  return out
}

/** Every `grant ... on public.<table> to <roles>;` across the migration history. */
function grantSites(): GrantSite[] {
  return scan(/\bgrant\s+[^;]*?\bon\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+to\s+([^;]+);/gi)
}

/** Every `create policy ... on public.<table> ... to <roles>` across the migration history. */
function policySites(): GrantSite[] {
  return scan(
    /\bcreate\s+policy\s+[^;]*?\bon\s+(?:public\.)?([a-z_][a-z0-9_]*)\b[^;]*?\bto\s+([a-z_, ]+?)\b\s*(?:using|with|;)/gi,
  )
}

describe('partner tax tables are not on the Data API', () => {
  it.each(SERVICE_ROLE_ONLY)('%s is granted to service_role and nobody else', table => {
    const sites = grantSites().filter(g => g.table === table)
    // A table with no grant at all is invisible to the app on a fresh post-2026-05-30 Supabase
    // project, so "nobody has it" is not a passing answer either.
    expect(sites.length, `${table} has no grant statement in any migration`).toBeGreaterThan(0)
    for (const site of sites) {
      expect(
        site.roles,
        `${site.file} grants ${table} to ${site.roles.join(', ')} — these tables are service-role only`,
      ).toEqual(['service_role'])
    }
  })

  it.each(SERVICE_ROLE_ONLY)('%s has no policy for a browser-reachable role', table => {
    // Policies without grants are dead weight, but a live one is a standing invitation to
    // "re-add the grant, there's already a policy". The deny is stated once, in the grants.
    for (const site of policySites().filter(p => p.table === table)) {
      for (const role of site.roles) {
        expect(
          ['anon', 'authenticated'].includes(role),
          `${site.file} has a policy on ${table} for ${role}`,
        ).toBe(false)
      }
    }
  })
})

describe('electronic K-1 consent', () => {
  const sql = readFileSync(join(MIGRATIONS, '20260827000007_k1_delivery.sql'), 'utf8')

  it('binds a delivery to its own partner’s consent, in its own fund', () => {
    // Checking only that *a* granted consent exists at that id is not a check: consent is
    // personal, so one partner's consent cannot furnish another's K-1, and a consent belonging
    // to another fund cannot furnish anything here.
    const fn = sql.slice(sql.indexOf('assert_k1_delivery_consented'))
    const lookup = fn.slice(fn.indexOf('from public.k1_delivery_consents'), fn.indexOf('if not found'))
    expect(lookup).toContain('id = new.consent_id')
    expect(lookup).toContain('lp_entity_id = new.lp_entity_id')
    expect(lookup).toContain('fund_id = new.fund_id')
  })

  it('refuses to store a request trail against a consent the GP recorded', () => {
    // `consent_ip` on a GP-recorded row would be the MANAGER's address, written into a column
    // that reads as proof the partner clicked something. An empty trail is a worse record than a
    // full one; a fabricated trail is worse than either.
    expect(sql).toContain('k1_delivery_consents_trail_matches_source')
    expect(sql).toMatch(/source\s*=\s*'lp_portal'\s+or\s+\(consent_ip is null and consent_user_agent is null\)/)
  })

  it('does not let the GP-side route write a consent trail at all', () => {
    const route = readFileSync(
      join(process.cwd(), 'app', 'api', 'accounting', 'k1-deliveries', 'route.ts'),
      'utf8',
    )
    // The constraint above would reject it, but the fix belongs where the mistake was made.
    expect(route).not.toMatch(/consent_ip\s*:/)
    expect(route).not.toMatch(/consent_user_agent\s*:/)
    expect(route).toContain("source: 'gp_recorded'")
  })
})
