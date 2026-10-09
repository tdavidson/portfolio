import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { DASHBOARD_VIEWS } from '@/lib/mcp-apps/payload'

// saved_dashboards is read and written only by the MCP endpoint, with the service-role key, scoped
// to the credential's fund and member. A Data API grant to authenticated would let any member read
// a colleague's saved recipes (which name companies and vehicles) from a browser with the anon
// key, including ones the application refuses to list for them. Same shape as
// reminder-deliveries-grants.test.ts.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const sql = readdirSync(MIGRATIONS)
  .filter(f => f.endsWith('.sql'))
  .map(f => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')

describe('saved_dashboards is service-role only', () => {
  it('is created, scoped to a fund and owned by a member', () => {
    expect(sql).toMatch(/create table public\.saved_dashboards/i)
    expect(sql).toMatch(/fund_id uuid not null references funds\(id\) on delete cascade/i)
    expect(sql).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/i)
  })

  it('revokes the default grants from anon and authenticated', () => {
    expect(sql).toMatch(/revoke all on public\.saved_dashboards from anon, authenticated;/i)
  })

  it('grants only service_role', () => {
    const grants = [...sql.matchAll(/\bgrant\s+[^;]*?\bon\s+(?:table\s+)?public\.saved_dashboards\s+to\s+([^;]+);/gi)]
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) expect(g[1].trim().toLowerCase()).toBe('service_role')
  })

  it('has RLS on and no policy for authenticated or anon', () => {
    expect(sql).toMatch(/alter table public\.saved_dashboards enable row level security/i)
    expect(sql).not.toMatch(/create policy[^;]*on public\.saved_dashboards/i)
  })

  it('only accepts the views the application can draw', () => {
    // The check constraint and DASHBOARD_VIEWS must name the same four.
    const views = /view in \(([^)]+)\)/i.exec(sql.slice(sql.indexOf('create table public.saved_dashboards')))
    expect(views![1].replace(/['\s]/g, '').split(',').sort()).toEqual([...DASHBOARD_VIEWS].sort())
  })
})
