import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { adminOnlyRule } from '@/lib/access/admin-only'
import { ROUTE_DOMAINS } from '@/lib/access/route-domains'

// Who can see a capital call before it is issued: fund members with LP capital, through the gated
// route, and nobody else. Not an LP, and not a member from the browser console.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const allSql = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')

describe('proposed_capital_calls reach', () => {
  it('is granted to service_role alone, with RLS on and no policy', () => {
    const grants = [...allSql.matchAll(/grant\s+([^;]+?)\s+on\s+(?:table\s+)?public\.proposed_capital_calls\s+to\s+([^;]+);/gi)]
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) expect(g[2].split(',').map(r => r.trim().toLowerCase())).toEqual(['service_role'])
    expect(allSql).toMatch(/alter table public\.proposed_capital_calls enable row level security/i)
    expect(allSql).not.toMatch(/create policy[^;]+on public\.proposed_capital_calls/i)
  })

  it('is never read by the LP portal or the investor connector', () => {
    const hits = execSync(
      'grep -rl "proposed_capital_calls\\|proposed-calls" app/portal app/api/portal lib/portal || true',
      { encoding: 'utf8' },
    ).trim()
    expect(hits).toBe('')
  })

  it('is served through lp_capital routes, and only an admin proposes, revises, discards or approves', () => {
    expect(ROUTE_DOMAINS['api/accounting/proposed-calls']).toEqual({ domain: 'lp_capital' })
    expect(ROUTE_DOMAINS['api/accounting/proposed-calls/pdf']).toEqual({ domain: 'lp_capital' })
    expect(adminOnlyRule('api/accounting/proposed-calls', 'POST', { action: 'approve' })).toBeDefined()
    for (const a of ['propose', 'revise', 'discard']) expect(adminOnlyRule('api/accounting/proposed-calls', 'POST', { action: a }), a).toBeDefined()
    expect(adminOnlyRule('api/accounting/vehicle-settings', 'PATCH', { callNoticeDays: 10 })).toBeDefined()
    expect(adminOnlyRule('api/accounting/vehicle-settings', 'PATCH', { wireInstructions: 'x' })).toBeUndefined()
  })
})
