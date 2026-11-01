import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LP change requests (lib/lps/change-requests.ts): an investor asks, the fund approves. Pins what an
 * LP may ask to change, that nothing is written on asking, who may ask and who may approve, and that
 * every door (portal web, investor connector, staff web, staff MCP and API) reaches the same code.
 */

import { authorizedUserPayload, decideChangeRequest, LP_EDITABLE_ENTITY_FIELDS, profileChangePayload } from './change-requests'
import { getPortalTool } from '@/lib/portal/mcp-tools'
import { getTool } from '@/lib/accounting/agent-tools'

const current = {
  entity: { address_line1: '1 Example Way', city: 'Springfield', country: 'US', notice_email: 'lp@investor.example', signatories: [] },
  investor: { contact_name: 'Jane Doe', contact_email: 'jane@investor.example', contact_phone: null },
}

describe('what an LP may ask to change', () => {
  it('keeps only the fields that differ from the record', () => {
    const out = profileChangePayload({ entity: { address_line1: '2 Example Way', city: 'Springfield' }, contact: { contact_name: 'Jane Doe' } }, current)
    expect(out).toEqual({ payload: { entity: { address_line1: '2 Example Way' } } })
  })

  it('refuses a request that changes nothing', () => {
    expect(profileChangePayload({ entity: { city: 'Springfield' } }, current)).toHaveProperty('error')
  })

  it('drops the fund\'s own fields: its notes and the onboarding checklist', () => {
    const out = profileChangePayload({ entity: { profile_notes: 'VIP', onboarding_excluded: true, country: 'CA' } }, current)
    expect(out).toEqual({ payload: { entity: { country: 'CA' } } })
    expect(LP_EDITABLE_ENTITY_FIELDS).not.toContain('profile_notes')
    expect(LP_EDITABLE_ENTITY_FIELDS).not.toContain('onboarding_excluded')
  })

  it('validates with the parsers a staff edit uses', () => {
    expect(profileChangePayload({ entity: { notice_email: 'not an email' } }, current)).toHaveProperty('error')
    expect(profileChangePayload({ entity: { entity_type: 'spaceship' } }, current)).toHaveProperty('error')
    expect(profileChangePayload({ contact: { contact_email: 'NEW@Investor.Example' } }, current))
      .toEqual({ payload: { investor: { contact_email: 'new@investor.example' } } })
  })

  it('takes an authorized user\'s email and name, not the LP\'s own address', () => {
    expect(authorizedUserPayload({ email: ' Advisor@Firm.Example ', name: 'Pat Advisor' }, 'lp@investor.example'))
      .toEqual({ payload: { email: 'advisor@firm.example', display_name: 'Pat Advisor' } })
    expect(authorizedUserPayload({ email: 'nope' }, null)).toHaveProperty('error')
    expect(authorizedUserPayload({ email: 'LP@investor.example' }, 'lp@investor.example')).toHaveProperty('error')
  })
})

describe('deciding', () => {
  /** A fake client that returns one request and records every write. */
  function fake(req: Record<string, unknown> | null) {
    const writes: string[] = []
    const chain: any = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: req, error: null }),
      update: () => { writes.push('update'); return chain },
      insert: () => { writes.push('insert'); return chain },
      then: (r: any) => r({ data: null, error: null }),
    }
    return { admin: { from: () => chain } as any, writes }
  }
  const actor = { fundId: 'f1', userId: 'u1', role: 'member', investorIds: null, entityIds: null, canWrite: true }
  const pending = { id: 'r1', fund_id: 'f1', lp_investor_id: 'i1', lp_entity_id: 'e1', kind: 'authorized_user', status: 'pending', payload: { email: 'a@firm.example' } }

  it('leaves portal access to an admin, as a direct grant is', async () => {
    const { admin, writes } = fake(pending)
    const out = await decideChangeRequest(admin, actor, { id: 'r1', decision: 'approve' })
    expect(out).toMatchObject({ ok: false, status: 403 })
    expect(writes).toEqual([])
  })

  it('needs write on LP capital to decide anything', async () => {
    const { admin, writes } = fake({ ...pending, kind: 'profile' })
    const out = await decideChangeRequest(admin, { ...actor, canWrite: false }, { id: 'r1', decision: 'reject' })
    expect(out).toMatchObject({ ok: false, status: 403 })
    expect(writes).toEqual([])
  })

  it('refuses a request outside the caller\'s LPs, or one already decided', async () => {
    expect(await decideChangeRequest(fake(pending).admin, { ...actor, investorIds: ['other'] }, { id: 'r1', decision: 'reject' })).toMatchObject({ ok: false, status: 404 })
    expect(await decideChangeRequest(fake({ ...pending, status: 'approved' }).admin, actor, { id: 'r1', decision: 'reject' })).toMatchObject({ ok: false, status: 409 })
    expect(await decideChangeRequest(fake(pending).admin, actor, { id: 'r1', decision: 'maybe' })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('every door', () => {
  const root = join(__dirname, '..', '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  it('offers the investor connector the record, the requests and withdrawals, asking only with write', () => {
    for (const name of ['my_record', 'my_change_requests']) expect(getPortalTool(name)?.scope, name).toBe('read')
    for (const name of ['request_record_change', 'request_authorized_user', 'withdraw_change_request']) expect(getPortalTool(name)?.scope, name).toBe('write')
  })

  it('offers staff the queue and the decision over MCP and the API, on LP capital', () => {
    expect(getTool('lp_change_requests')).toMatchObject({ scope: 'read', accessDomain: 'lp_capital' })
    expect(getTool('lp_change_request_decide')).toMatchObject({ scope: 'write', accessDomain: 'lp_capital' })
  })

  it('approves through the same functions a direct edit uses', () => {
    const src = read('lib/lps/change-requests.ts')
    expect(src).toContain('await updateEntityProfile(admin, { fundId: actor.fundId, userId: actor.userId, visibleEntityIds: actor.entityIds }')
    expect(src).toContain('await addAuthorizedUser(admin, { fundId: actor.fundId, userId: actor.userId }')
  })

  it('lets only the investor\'s primary account ask', () => {
    const src = read('lib/lps/change-requests.ts')
    expect(src).toContain(".from('lp_account_links')")
    expect(src.match(/throw NOT_PRIMARY/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the table to the service role', () => {
    const sql = read('supabase/migrations/20261101120000_lp_change_requests.sql')
    expect(sql).toContain('revoke all on public.lp_change_requests from anon, authenticated;')
    expect(sql).toContain('alter table public.lp_change_requests enable row level security;')
  })
})
