import { describe, it, expect, vi, beforeEach } from 'vitest'

const runPipeline = vi.fn(async () => {})
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: (...a: unknown[]) => (runPipeline as any)(...a) }))
vi.mock('@/lib/parsing/extractAttachmentText', () => ({ hydrateAttachments: async (p: unknown) => p }))

import { runReprocess } from './reprocess'

/** An admin client whose inbound_emails row says whether intake verified the sender. */
function db(senderVerified: boolean | 'missing-column') {
  const rpc = vi.fn(async () => ({ data: [{ user_id: 'member-1' }], error: null }))
  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => senderVerified === 'missing-column'
            ? { data: null, error: { code: '42703', message: 'column inbound_emails.sender_verified does not exist' } }
            : { data: { sender_verified: senderVerified }, error: null },
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }
  return { client: client as any, rpc }
}

const email = {
  id: 'email-1',
  fund_id: 'fund-1',
  processing_status: 'failed',
  raw_payload: { From: 'gp@fund.example', FromFull: { Email: 'gp@fund.example' }, Subject: 'Q3 update' },
}

describe('runReprocess — a member treatment only for mail intake verified', () => {
  beforeEach(() => runPipeline.mockClear())

  it('reruns verified mail from a member as that member', async () => {
    const { client } = db(true)
    await runReprocess(client, email)
    expect(runPipeline).toHaveBeenCalledWith(client, 'email-1', 'fund-1', expect.anything(), { userId: 'member-1' })
  })

  it('reruns unverified mail claiming a member address as an outsider, without asking who the member is', async () => {
    const { client, rpc } = db(false)
    await runReprocess(client, email)
    expect(runPipeline).toHaveBeenCalledWith(client, 'email-1', 'fund-1', expect.anything(), null)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('treats mail as unverified before the column exists', async () => {
    const { client } = db('missing-column')
    await runReprocess(client, email)
    expect(runPipeline).toHaveBeenCalledWith(client, 'email-1', 'fund-1', expect.anything(), null)
  })
})
