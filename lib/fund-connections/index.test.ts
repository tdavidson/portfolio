import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import {
  approvePairs, approvedCounterparts, connectionPairs, endConnection, listConnections, removePair,
  requestConnection, respondToConnection,
} from './index'

const A = 'fund-a'
const B = 'fund-b'
const C = 'fund-c'

function setup() {
  const { admin, tables } = memoryAdmin({
    funds: [{ id: A, name: 'Alpha Fund' }, { id: B, name: 'Beta Fund' }, { id: C, name: 'Gamma Fund' }],
    lp_investors: [
      { id: 'a-jane', fund_id: A, name: 'Jane Doe', contact_email: 'jane@x.com' },
      { id: 'a-smith', fund_id: A, name: 'Smith Family Trust', contact_email: null },
      { id: 'a-solo', fund_id: A, name: 'Only In Alpha', contact_email: null },
      { id: 'b-jane', fund_id: B, name: 'J. Doe', contact_email: 'JANE@x.com' },
      { id: 'b-smith', fund_id: B, name: 'Smith Family Trust', contact_email: null },
      { id: 'b-private', fund_id: B, name: 'Private Beta LP', contact_email: 'private@y.com' },
    ],
  }, {
    unique: [{
      table: 'fund_connections',
      key: r => (['pending', 'active'].includes(r.status ?? 'pending') ? [r.requester_fund_id, r.recipient_fund_id].sort().join('|') : null),
    }],
  })
  const admins: Record<string, string> = { 'beta-admin@b.com': B, 'gamma-admin@c.com': C, 'alpha-admin@a.com': A }
  admin.rpc = async (_name: string, args: { p_email: string }) => {
    const fund = admins[args.p_email.toLowerCase()]
    return { data: fund ? [{ fund_id: fund, fund_name: tables.funds.find((f: any) => f.id === fund)!.name }] : [], error: null }
  }
  // memoryAdmin has no defaults: fill the ones the table has.
  const from = admin.from
  admin.from = (t: string) => {
    const q = from(t)
    if (t !== 'fund_connections') return q
    const insert = q.insert
    q.insert = (row: any) => insert({ status: 'pending', requested_at: new Date().toISOString(), responded_at: null, ...row })
    return q
  }
  return { admin, tables }
}

async function connected() {
  const s = setup()
  const { id } = await requestConnection(s.admin, { fundId: A, userId: 'ua', email: 'Beta-Admin@b.com' })
  await respondToConnection(s.admin, { fundId: B, userId: 'ub', connectionId: id, accept: true })
  return { ...s, id }
}

describe('fund connections', () => {
  it('asks the fund an admin email belongs to, and refuses a second live request either way', async () => {
    const { admin } = setup()
    const r = await requestConnection(admin, { fundId: A, userId: 'ua', email: 'beta-admin@b.com' })
    expect(r.otherFundName).toBe('Beta Fund')
    await expect(requestConnection(admin, { fundId: B, userId: 'ub', email: 'alpha-admin@a.com' })).rejects.toMatchObject({ status: 409 })
    await expect(requestConnection(admin, { fundId: A, userId: 'ua', email: 'nobody@z.com' })).rejects.toMatchObject({ status: 404 })
    await expect(requestConnection(admin, { fundId: A, userId: 'ua', email: 'alpha-admin@a.com' })).rejects.toThrow(/this fund/)
    expect((await listConnections(admin, B))[0]).toMatchObject({ direction: 'incoming', status: 'pending', otherFundName: 'Alpha Fund' })
  })

  it('only the fund that was asked can accept, and a fund outside the connection sees nothing', async () => {
    const { admin } = setup()
    const { id } = await requestConnection(admin, { fundId: A, userId: 'ua', email: 'beta-admin@b.com' })
    await expect(respondToConnection(admin, { fundId: A, userId: 'ua', connectionId: id, accept: true })).rejects.toMatchObject({ status: 403 })
    await expect(respondToConnection(admin, { fundId: C, userId: 'uc', connectionId: id, accept: true })).rejects.toMatchObject({ status: 404 })
    await expect(connectionPairs(admin, { fundId: A, connectionId: id })).rejects.toMatchObject({ status: 409 })
    expect(await listConnections(admin, C)).toEqual([])
  })

  it('suggests only matching LPs, never the rest of the other fund', async () => {
    const { admin, id } = await connected()
    const { suggestions, unpaired } = await connectionPairs(admin, { fundId: A, connectionId: id })
    expect(suggestions.map(s => [s.ours.id, s.theirs.id, s.reason])).toEqual([
      ['a-jane', 'b-jane', 'email'],
      ['a-smith', 'b-smith', 'name'],
    ])
    expect(JSON.stringify(suggestions)).not.toContain('b-private')
    expect(JSON.stringify(suggestions)).not.toContain('jane@x.com')
    expect(unpaired.map(i => i.id)).toEqual(['a-jane', 'a-solo', 'a-smith'])
  })

  it('links a pair only once both funds approve it', async () => {
    const { admin, id } = await connected()
    const proposed = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-jane', theirInvestorId: 'b-jane' }] })
    expect(proposed.changed).toBe(1)
    expect(await approvedCounterparts(admin, A)).toEqual([])
    expect(await approvedCounterparts(admin, B)).toEqual([])

    const theirView = await connectionPairs(admin, { fundId: B, connectionId: id })
    expect(theirView.pairs).toEqual([expect.objectContaining({ ours: { id: 'b-jane', name: 'J. Doe' }, ourApproval: false, theirApproval: true, approved: false })])

    await approvePairs(admin, { fundId: B, userId: 'ub', connectionId: id, requests: [{ ourInvestorId: 'b-jane', theirInvestorId: 'a-jane' }] })
    expect(await approvedCounterparts(admin, A)).toEqual([{ investorId: 'a-jane', linkedFundId: B, linkedInvestorId: 'b-jane' }])
    expect(await approvedCounterparts(admin, B)).toEqual([{ investorId: 'b-jane', linkedFundId: A, linkedInvestorId: 'a-jane' }])
    expect((await listConnections(admin, A))[0].pairs).toEqual({ approved: 1, awaitingUs: 0, awaitingThem: 0 })
  })

  it('refuses an investor of theirs that was never suggested or named exactly', async () => {
    const { admin, id } = await connected()
    const r = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-solo', theirInvestorId: 'b-private' }] })
    expect(r.changed).toBe(0)
    expect(r.skipped[0].reason).toMatch(/not one suggested/)
    const notOurs = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'b-smith', theirInvestorId: 'a-smith' }] })
    expect(notOurs.skipped[0].reason).toMatch(/Not an investor of this fund/)
  })

  it('pairs by hand on an exact name or email', async () => {
    const { admin, id } = await connected()
    const miss = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-solo', theirMatch: 'Private' }] })
    expect(miss.changed).toBe(0)
    const hit = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-solo', theirMatch: 'private@y.com' }] })
    expect(hit.changed).toBe(1)
    const again = await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-smith', theirMatch: 'Private Beta LP' }] })
    expect(again.skipped[0].reason).toMatch(/already paired/)
  })

  it('either side can remove a pair, and disconnecting removes them all', async () => {
    const { admin, id, tables } = await connected()
    await approvePairs(admin, { fundId: A, userId: 'ua', connectionId: id, requests: [{ ourInvestorId: 'a-jane', theirInvestorId: 'b-jane' }, { ourInvestorId: 'a-smith', theirInvestorId: 'b-smith' }] })
    await approvePairs(admin, { fundId: B, userId: 'ub', connectionId: id, requests: [{ ourInvestorId: 'b-jane' }, { ourInvestorId: 'b-smith' }] })
    expect(await approvedCounterparts(admin, A)).toHaveLength(2)

    const jane = (await connectionPairs(admin, { fundId: B, connectionId: id })).pairs.find(p => p.ours.id === 'b-jane')!
    await removePair(admin, { fundId: B, userId: 'ub', connectionId: id, linkId: jane.id })
    expect(await approvedCounterparts(admin, A)).toEqual([{ investorId: 'a-smith', linkedFundId: B, linkedInvestorId: 'b-smith' }])

    await endConnection(admin, { fundId: A, userId: 'ua', connectionId: id })
    expect(tables.lp_investor_links).toEqual([])
    expect(await approvedCounterparts(admin, B)).toEqual([])
    expect(await listConnections(admin, A)).toEqual([])
    expect(tables.fund_connection_events.map((e: any) => e.action)).toEqual([
      'requested', 'accepted', 'pair_proposed', 'pair_proposed', 'pair_approved', 'pair_approved', 'pair_removed', 'disconnected',
    ])
    // A new request may follow a disconnect.
    await expect(requestConnection(admin, { fundId: B, userId: 'ub', email: 'alpha-admin@a.com' })).resolves.toMatchObject({ otherFundName: 'Alpha Fund' })
  })
})
