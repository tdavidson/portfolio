import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// Fund connections cross tenants by design, so their tables must never be on the Data API: the
// only readers and writers are the admin-only settings routes and the report generators, holding
// the service role (lib/fund-connections). A grant to `authenticated` would let a member of either
// fund read the other fund's investor pairs from the browser console. Same check as
// tax-data-api-grants.test.ts.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const TABLES = ['fund_connections', 'lp_investor_links', 'fund_connection_events']
const sqls = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => ({ f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') }))

function sites(re: RegExp) {
  const out: { file: string; table: string; roles: string[] }[] = []
  for (const { f, sql } of sqls) {
    for (const m of sql.matchAll(re)) out.push({ file: f, table: m[1].toLowerCase(), roles: m[2].split(',').map(r => r.trim().toLowerCase()) })
  }
  return out
}
const grants = sites(/\bgrant\s+[^;]*?\bon\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+to\s+([^;]+);/gi)
const policies = sites(/\bcreate\s+policy\s+[^;]*?\bon\s+(?:public\.)?([a-z_][a-z0-9_]*)\b[^;]*?\bto\s+([a-z_, ]+?)\b\s*(?:using|with|;)/gi)

describe('fund connection tables are service-role only', () => {
  it.each(TABLES)('%s is granted to service_role and nobody else', table => {
    const mine = grants.filter(g => g.table === table)
    expect(mine.length).toBeGreaterThan(0)
    for (const g of mine) expect(g.roles, `${g.file} grants ${table} to ${g.roles.join(', ')}`).toEqual(['service_role'])
  })

  it.each(TABLES)('%s has no policy for a browser-reachable role', table => {
    for (const p of policies.filter(x => x.table === table)) {
      expect(p.roles.some(r => r === 'anon' || r === 'authenticated'), `${p.file} has a policy on ${table}`).toBe(false)
    }
  })

  it('keeps the admin-email lookup away from members', () => {
    const sql = sqls.find(s => s.sql.includes('function public.fund_for_admin_email'))!.sql
    expect(sql).toMatch(/revoke execute on function public\.fund_for_admin_email\(text\) from public, anon, authenticated/)
  })
})
