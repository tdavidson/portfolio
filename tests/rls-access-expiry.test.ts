import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/20261101230000_rls_helpers_honour_access_expiry.sql'), 'utf8')
const PREDICATE = 'access_expires_at is null or'

/** The body of `create or replace function public.<name>(` up to the next `$$;` that closes it. */
function body(name: string): string {
  const at = sql.indexOf(`create or replace function public.${name}(`)
  expect(at, `${name} is recreated`).toBeGreaterThan(-1)
  return sql.slice(at, sql.indexOf('$$', sql.indexOf('$$', at) + 2))
}

describe('the RLS helpers drop a member whose access has expired', () => {
  for (const name of ['get_my_fund_ids', 'member_fund_ids', 'is_fund_member', 'is_fund_writer', 'unscoped_fund_ids',
    'vehicle_ids_readable', 'vehicle_ids_writable', 'count_unread_notes', 'master_admin_pool', 'domain_access']) {
    it(`${name} checks access_expires_at, letting admins through`, () => {
      const b = body(name)
      expect(b).toContain(PREDICATE)
      expect(b).toMatch(/role = 'admin' or (m\.)?access_expires_at is null or (m\.)?access_expires_at > now\(\)/)
      expect(b).toMatch(/security definer set search_path = public/)
    })
  }

  it('is_fund_admin needs no expiry check: an admin\'s access never expires', () => {
    expect(body('is_fund_admin')).toContain("m.role = 'admin'")
  })
})

describe('grant hygiene', () => {
  const hygiene = readFileSync(join(__dirname, '..', 'supabase/migrations/20261101240000_grant_and_function_hygiene.sql'), 'utf8')
  it('takes TRUNCATE from anon and authenticated on every public table, and anon writes on the membership tables', () => {
    expect(hygiene).toContain("revoke truncate, trigger, references on public.%I from anon, authenticated")
    expect(hygiene).toContain('revoke insert, update, delete on public.fund_members, public.fund_member_access, public.fund_member_vehicles from anon;')
  })
  it('makes the membership helpers uncallable by anon, and scopes the policies that call them to authenticated', () => {
    for (const f of ['get_my_fund_ids()', 'is_fund_admin(uuid)', 'is_fund_writer(uuid)']) {
      expect(hygiene).toContain(`revoke execute on function public.${f} from public, anon;`)
    }
    expect(hygiene).toContain("alter policy %I on public.%I to authenticated")
  })
})
