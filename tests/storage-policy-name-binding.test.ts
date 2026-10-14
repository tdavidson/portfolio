import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// Inside `exists (select 1 from public.<table> … (storage.foldername(name)) …)`, a bare `name` binds to
// the subquery's table first when that table has a `name` column (diligence_deals does), and the
// policy then checks the deal's name instead of the object's path. Qualify it: objects.name.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

/** The last `create policy "<name>" on storage.objects …;` across all migrations, by policy name. */
function finalStoragePolicies(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    for (const m of sql.matchAll(/create policy\s+"([^"]+)"\s+on\s+storage\.objects\b[\s\S]*?;/gi)) out.set(m[1], m[0])
  }
  return out
}

// Tables a storage policy joins through that have a `name` column of their own.
const NAMED_TABLES = ['diligence_deals', 'companies', 'fund_vehicles', 'funds', 'lp_investors', 'lp_entities']

describe('storage.objects policies', () => {
  it('qualify objects.name whenever they look up the path inside a subquery on a table with a name column', () => {
    const offenders: string[] = []
    for (const [name, sql] of finalStoragePolicies()) {
      // Only what follows the FROM is inside the subquery's scope; an `x in (select …)` left operand
      // before it still binds to storage.objects.
      for (const t of NAMED_TABLES) {
        const at = sql.search(new RegExp(`from\\s+public\\.${t}\\b`, 'i'))
        if (at >= 0 && /foldername\(\s*name\s*\)/i.test(sql.slice(at))) { offenders.push(name); break }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the diligence buckets check the object path', () => {
    const policies = finalStoragePolicies()
    const diligence = [...policies].filter(([n]) => n.startsWith('diligence-documents') || n.startsWith('diligence-recordings'))
    expect(diligence.length).toBe(7)
    for (const [, sql] of diligence) expect(sql).toMatch(/foldername\(objects\.name\)/)
  })
})

describe('public.funds from the browser', () => {
  it('has insert/update/delete revoked from authenticated after its original write policies', () => {
    const idx = (re: RegExp) => files.reduce((at, f, i) => (re.test(readFileSync(join(MIGRATIONS, f), 'utf8')) ? i : at), -1)
    const policies = idx(/create policy[^;]+on\s+(?:public\.)?funds\s+for\s+(insert|update|delete)/i)
    const revoked = idx(/revoke\s+insert,\s*update,\s*delete\s+on\s+public\.funds\s+from\s+anon,\s*authenticated/i)
    expect(revoked).toBeGreaterThan(policies)
  })
})
