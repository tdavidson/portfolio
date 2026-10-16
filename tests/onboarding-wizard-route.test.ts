import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt } from '@/lib/crypto'
import { buildFeatureVisibility } from '@/lib/onboarding/wizard'

/**
 * The first-run wizard's API: /api/onboarding/fund (GET resume, POST step 1, PATCH later steps),
 * plus the consumer-mailbox rule in check-domain and join.
 *
 * Pinned here:
 * - a refresh mid-wizard gets the webhook token back (it is stored ONLY encrypted — the old GET read
 *   the plaintext column, got null, and the inbound step rendered nothing);
 * - the resume step follows the new order and remembers skips;
 * - the products step writes a COMPLETE feature_visibility map and creates the first entity;
 * - a fund never claims gmail.com, and gmail.com never matches a fund;
 * - nothing here serves or writes anything for a non-admin member.
 */

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
  rateLimit: vi.fn(async () => null),
  ensureVehicleAccounts: vi.fn(async () => undefined),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mocks.from }),
}))
vi.mock('@/lib/rate-limit', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  rateLimit: mocks.rateLimit,
}))
vi.mock('@/lib/accounting/provision-accounts', () => ({
  ensureVehicleAccounts: mocks.ensureVehicleAccounts,
}))

import { GET, PATCH, POST } from '@/app/api/onboarding/fund/route'
import { GET as checkDomain } from '@/app/api/onboarding/check-domain/route'
import { POST as join } from '@/app/api/onboarding/join/route'

const previousEncryptionKey = process.env.ENCRYPTION_KEY
const kek = '44'.repeat(32)
const dek = '55'.repeat(32)
const WEBHOOK = 'f'.repeat(64)

type Row = Record<string, any>
let membership: { fund_id: string; role: string } | null
let settings: Row | null
let senderCount: number
let headCounts: Record<string, number> = {}
let vehicles: Row[]
let writes: { table: string; op: 'insert' | 'update' | 'delete'; value: Row }[]
let fundsQueried: boolean
let updateError: ((value: Row) => { message: string; code?: string } | null) | null

function chain(table: string): any {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let value: Row = {}
  let head = false
  const filters: Row = {}
  const result = () => {
    if (op === 'update') {
      const error = updateError?.(value) ?? null
      if (!error) writes.push({ table, op, value })
      return { data: null, error }
    }
    if (op === 'delete') {
      writes.push({ table, op, value: filters })
      return { data: null, error: null }
    }
    if (table === 'authorized_senders' && head) return { data: null, count: senderCount, error: null }
    if (head && headCounts[table] != null) return { data: null, count: headCounts[table], error: null }
    return { data: null, error: null }
  }
  const c: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (opts?.head) head = true
      return c
    },
    insert: (v: Row) => {
      op = 'insert'
      value = v
      writes.push({ table, op, value: v })
      return c
    },
    update: (v: Row) => {
      op = 'update'
      value = v
      return c
    },
    delete: () => {
      op = 'delete'
      return c
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return c
    },
    contains: () => c,
    limit: () => c,
    order: () => c,
    maybeSingle: async () => {
      if (table === 'fund_members') return { data: membership, error: null }
      if (table === 'fund_settings') return { data: settings, error: null }
      if (table === 'funds') {
        fundsQueried = true
        return { data: { id: 'fund-1', name: 'Acme Ventures' }, error: null }
      }
      if (table === 'fund_vehicles') {
        return { data: vehicles.find(v => !filters.name || v.name === filters.name) ?? null, error: null }
      }
      return { data: null, error: null }
    },
    single: async () => {
      if (table === 'funds' && op === 'insert') return { data: { id: 'fund-new' }, error: null }
      if (table === 'funds') return { data: { id: 'target-fund', name: 'Strangers', email_domain: 'gmail.com' }, error: null }
      if (table === 'fund_vehicles' && op === 'insert') return { data: { id: 'veh-1' }, error: null }
      return { data: null, error: null }
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  }
  return c
}

function newFundSettings(extra: Row = {}): Row {
  return {
    fund_id: 'fund-1',
    encryption_key_encrypted: encrypt(dek, kek),
    postmark_webhook_token_encrypted: encrypt(WEBHOOK, dek),
    postmark_webhook_token: null,
    inbound_email_provider: null,
    postmark_inbound_address: null,
    resend_inbound_domain: null,
    feature_visibility: buildFeatureVisibility(['portfolio_reporting']),
    onboarding: {},
    ...extra,
  }
}

const req = (body: unknown) => ({
  headers: new Headers({ 'x-real-ip': '203.0.113.9' }),
  json: async () => body,
}) as any

const writesTo = (table: string, op: string) => writes.filter(w => w.table === table && w.op === op).map(w => w.value)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ENCRYPTION_KEY = kek
  headCounts = {}
  membership = { fund_id: 'fund-1', role: 'admin' }
  settings = newFundSettings()
  senderCount = 0
  vehicles = []
  writes = []
  fundsQueried = false
  updateError = null
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'gp@acme.vc' } } })
  mocks.rateLimit.mockResolvedValue(null)
  mocks.from.mockImplementation(chain)
})

afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousEncryptionKey
})

describe('GET /api/onboarding/fund — resume', () => {
  it('returns the decrypted webhook token to the admin of a fund that only stores it encrypted', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.webhookToken).toBe(WEBHOOK)
    expect(body.step).toBe('products')
    expect(body.products).toEqual(['portfolio_reporting'])
  })

  it('falls back to a legacy plaintext token', async () => {
    settings = newFundSettings({ postmark_webhook_token_encrypted: null, postmark_webhook_token: 'legacy-token' })
    expect((await (await GET()).json()).webhookToken).toBe('legacy-token')
  })

  it('never sends the token to a non-admin member', async () => {
    membership = { fund_id: 'fund-1', role: 'member' }
    expect(await (await GET()).json()).toEqual({ step: 'complete', fundId: 'fund-1', webhookToken: null })
  })

  it('resumes at inbound, then senders after inbound is skipped, then drive', async () => {
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'] } })
    expect((await (await GET()).json()).step).toBe('inbound')
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'], skipped: ['inbound'] } })
    expect((await (await GET()).json()).step).toBe('senders')
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'], skipped: ['inbound'] } })
    senderCount = 1
    expect((await (await GET()).json()).step).toBe('drive')
  })

  it('is complete once Finish was pressed', async () => {
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'], completed_at: '2026-10-11T10:00:00Z' } })
    expect((await (await GET()).json()).step).toBe('complete')
  })

  it('treats a fund from the old wizard (no onboarding column, inbound + senders) as complete', async () => {
    const legacy = newFundSettings({ inbound_email_provider: 'postmark', postmark_inbound_address: 'x@inbound.postmarkapp.com' })
    delete legacy.onboarding
    settings = legacy
    senderCount = 3
    expect((await (await GET()).json()).step).toBe('complete')
  })
})

describe('POST /api/onboarding/fund — step 1', () => {
  beforeEach(() => {
    membership = null
  })

  it('creates the fund without claiming a consumer mailbox domain', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'someone@gmail.com' } } })
    const res = await POST(req({ fundName: 'Solo Fund' }))
    expect(res.status).toBe(200)
    expect(writesTo('funds', 'insert')[0]).toMatchObject({ name: 'Solo Fund', email_domain: null })
  })

  it('claims an organisation’s domain', async () => {
    await POST(req({ fundName: 'Acme Ventures' }))
    expect(writesTo('funds', 'insert')[0].email_domain).toBe('acme.vc')
  })

  it('stores the chosen provider’s key encrypted, sets it as default, and writes a full feature map', async () => {
    const res = await POST(req({ fundName: 'Acme Ventures', aiProvider: 'openai', apiKey: 'sk-openai' }))
    const body = await res.json()
    const row = writesTo('fund_settings', 'insert')[0]
    const fundDek = decrypt(row.encryption_key_encrypted, kek)
    expect(decrypt(row.openai_api_key_encrypted, fundDek)).toBe('sk-openai')
    expect(row.claude_api_key_encrypted).toBeUndefined()
    expect(row.default_ai_provider).toBe('openai')
    expect(row.feature_visibility).toEqual(buildFeatureVisibility(['portfolio_reporting']))
    // The token handed back is the one stored — encrypted only.
    expect(decrypt(row.postmark_webhook_token_encrypted, fundDek)).toBe(body.webhookToken)
    expect(row.postmark_webhook_token).toBeUndefined()
  })

  it('lets the key be skipped', async () => {
    const res = await POST(req({ fundName: 'Acme Ventures' }))
    expect(res.status).toBe(200)
    const row = writesTo('fund_settings', 'insert')[0]
    expect(row.claude_api_key_encrypted).toBeUndefined()
    expect(row.default_ai_provider).toBeUndefined()
  })

  it('rejects an unknown provider', async () => {
    const res = await POST(req({ fundName: 'Acme Ventures', aiProvider: 'gemini', apiKey: 'k' }))
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('returns the decrypted token when an admin re-submits step 1 for an existing fund', async () => {
    membership = { fund_id: 'fund-1', role: 'admin' }
    const body = await (await POST(req({ fundName: 'Renamed' }))).json()
    expect(body.webhookToken).toBe(WEBHOOK)
    // No key in the body: rename only, no settings write.
    expect(writesTo('fund_settings', 'update')).toHaveLength(0)
  })
})

describe('PATCH /api/onboarding/fund — later steps', () => {
  it('products: writes the full feature map, records the answer, and creates the first entity', async () => {
    const res = await PATCH(req({
      action: 'products',
      products: ['portfolio_reporting', 'fund_operations'],
      entity: { name: 'Acme Ventures Fund I', kind: 'fund', vintageYear: '2026' },
    }))
    expect(res.status).toBe(200)

    const update = writesTo('fund_settings', 'update')[0]
    expect(update.feature_visibility).toEqual(buildFeatureVisibility(['portfolio_reporting', 'fund_operations']))
    expect(update.feature_visibility.accounting).toBe('admin')
    expect(update.feature_visibility.management_company).toBe('off')
    expect(update.onboarding).toEqual({ products: ['portfolio_reporting', 'fund_operations'] })

    expect(writesTo('fund_vehicles', 'insert')).toEqual([{
      fund_id: 'fund-1', name: 'Acme Ventures Fund I', kind: 'fund', aliases: [], active: true, vintage_year: 2026,
    }])
    expect(mocks.ensureVehicleAccounts).toHaveBeenCalledWith(expect.anything(), 'fund-1', 'Acme Ventures Fund I')
    expect((await res.json()).entityId).toBe('veh-1')
  })

  it('products: does not create a second entity of the same name on a resubmit', async () => {
    vehicles = [{ id: 'veh-existing', name: 'Acme Ventures Fund I' }]
    const res = await PATCH(req({
      action: 'products', products: ['fund_operations'], entity: { name: 'Acme Ventures Fund I', kind: 'fund' },
    }))
    expect((await res.json()).entityId).toBe('veh-existing')
    expect(writesTo('fund_vehicles', 'insert')).toHaveLength(0)
  })

  it('products: ignores the entity when no chosen product keeps per-entity data', async () => {
    await PATCH(req({ action: 'products', products: ['portfolio_reporting'], entity: { name: 'X' } }))
    expect(writesTo('fund_vehicles', 'insert')).toHaveLength(0)
  })

  it('products: rejects a bad entity before writing anything', async () => {
    const res = await PATCH(req({
      action: 'products', products: ['fund_operations'], entity: { name: 'Fund I', kind: 'fund', vintageYear: 'soon' },
    }))
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('products: still saves when the onboarding column has not been migrated yet', async () => {
    const legacy = newFundSettings()
    delete legacy.onboarding
    settings = legacy
    const res = await PATCH(req({ action: 'products', products: ['portfolio_reporting'] }))
    expect(res.status).toBe(200)
    const update = writesTo('fund_settings', 'update')[0]
    expect(update.onboarding).toBeUndefined()
    expect(update.feature_visibility).toEqual(buildFeatureVisibility(['portfolio_reporting']))
  })

  it('products: refuses a fund that finished the wizard — Settings changes products there', async () => {
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'], completed_at: '2026-10-11T10:00:00Z' } })
    const res = await PATCH(req({ action: 'products', products: ['portfolio_reporting'] }))
    expect(res.status).toBe(409)
    expect(writes).toHaveLength(0)
  })

  it('products: refuses an older fund that already holds data and never answered products', async () => {
    headCounts = { fund_vehicles: 2 }
    const res = await PATCH(req({ action: 'products', products: ['portfolio_reporting'] }))
    expect(res.status).toBe(409)
    expect(writes).toHaveLength(0)
  })

  it('skip and finish are remembered', async () => {
    settings = newFundSettings({ onboarding: { products: ['portfolio_reporting'] } })
    await PATCH(req({ action: 'skip', step: 'inbound' }))
    expect(writesTo('fund_settings', 'update')[0].onboarding).toEqual({ products: ['portfolio_reporting'], skipped: ['inbound'] })

    await PATCH(req({ action: 'finish' }))
    expect(typeof writesTo('fund_settings', 'update')[1].onboarding.completed_at).toBe('string')
  })

  it('refuses a non-admin member outright', async () => {
    membership = { fund_id: 'fund-1', role: 'member' }
    for (const body of [
      { action: 'products', products: ['fund_operations'], entity: { name: 'Fund I' } },
      { action: 'skip', step: 'inbound' },
      { action: 'finish' },
    ]) {
      const res = await PATCH(req(body))
      expect(res.status).toBe(403)
    }
    expect(writes).toHaveLength(0)
  })

  it('refuses a caller with no fund', async () => {
    membership = null
    expect((await PATCH(req({ action: 'finish' }))).status).toBe(403)
    expect(writes).toHaveLength(0)
  })
})

describe('consumer mailbox domains never match a fund', () => {
  beforeEach(() => {
    membership = null
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-2', email: 'another@gmail.com' } } })
  })

  it('check-domain offers nothing to a gmail.com user, without even looking', async () => {
    expect(await (await checkDomain()).json()).toEqual({ fund: null })
    expect(fundsQueried).toBe(false)
  })

  it('join refuses a gmail.com user even against a fund that claimed gmail.com before the fix', async () => {
    const res = await join(req({ fundId: 'target-fund' }))
    expect(res.status).toBe(403)
    expect(writes).toHaveLength(0)
  })
})
