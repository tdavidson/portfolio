import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryAdmin } from './helpers/memory-admin'
import { resolveLpRecipients } from '@/lib/lp-recipients'

describe('an LP disabled in one fund keeps their other funds', () => {
  it('gets none of that fund\'s emails, and still gets the other fund\'s', async () => {
    const { admin } = memoryAdmin({
      lp_account_links: [
        { id: 'l1', lp_account_id: 'acct', fund_id: 'f1', lp_investor_id: 'i1', disabled_at: '2026-11-01T00:00:00Z' },
        { id: 'l2', lp_account_id: 'acct', fund_id: 'f2', lp_investor_id: 'i2', disabled_at: null },
      ],
      lp_accounts: [{ id: 'acct', email: 'lp@investor.example', display_name: null, status: 'active' }],
      lp_authorized_users: [],
    })
    expect(await resolveLpRecipients(admin, 'f1', ['i1'])).toEqual([])
    expect((await resolveLpRecipients(admin, 'f2', ['i2'])).map(g => g.primaryEmail)).toEqual(['lp@investor.example'])
  })

  it('loses that fund\'s investors in the database too, and so do the people they authorized', () => {
    const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/20261101220000_lp_portal_status_per_fund.sql'), 'utf8')
    expect(sql).toContain('and l.disabled_at is null')
    expect(sql).toMatch(/not exists \(\s*select 1 from lp_account_links pl[\s\S]*pl\.disabled_at is not null/)
    const helpers = readFileSync(join(__dirname, '..', 'lib/api-helpers.ts'), 'utf8')
    expect(helpers).toContain('.filter(l => !l.disabled_at)')
  })
})
