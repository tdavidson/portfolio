import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt } from '@/lib/crypto'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
  rateLimit: vi.fn(async () => null),
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

import { GET, POST } from '@/app/api/onboarding/fund/route'

const previousEncryptionKey = process.env.ENCRYPTION_KEY
const kek = '22'.repeat(32)
const originalDek = '33'.repeat(32)
let role: 'admin' | 'member' | 'viewer' = 'admin'
let fundUpdates: Record<string, unknown>[] = []
let settingsUpdates: Record<string, unknown>[] = []
let storedEncryptedDek = ''

function tableQuery(table: string): any {
  let operation: 'select' | 'update' | null = null
  const chain: any = {
    select: () => {
      operation = 'select'
      return chain
    },
    update: (value: Record<string, unknown>) => {
      operation = 'update'
      if (table === 'funds') fundUpdates.push(value)
      if (table === 'fund_settings') settingsUpdates.push(value)
      return chain
    },
    eq: () => chain,
    maybeSingle: async () => {
      if (table === 'fund_members') return { data: { fund_id: 'fund-1', role }, error: null }
      if (table === 'fund_settings') return {
        data: {
          encryption_key_encrypted: storedEncryptedDek,
          postmark_webhook_token: 'webhook-secret',
          postmark_inbound_address: 'inbound@example.com',
          inbound_email_provider: 'postmark',
          resend_inbound_domain: null,
        },
        error: null,
      }
      return { data: null, error: null }
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ENCRYPTION_KEY = kek
  role = 'admin'
  fundUpdates = []
  settingsUpdates = []
  storedEncryptedDek = encrypt(originalDek, kek)
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'admin@example.com' } } })
  mocks.rateLimit.mockResolvedValue(null)
  mocks.from.mockImplementation(tableQuery)
})

afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousEncryptionKey
})

const request = () => ({
  headers: new Headers({ 'x-real-ip': '203.0.113.7' }),
  json: async () => ({ fundName: 'Renamed Fund', claudeApiKey: 'new-api-key' }),
}) as any

describe('onboarding fund security', () => {
  it('does not expose setup credentials to a non-admin member', async () => {
    role = 'member'
    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      step: 'complete',
      fundId: 'fund-1',
      webhookToken: null,
    })
  })

  it('refuses existing-fund changes from a non-admin member', async () => {
    role = 'member'
    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(fundUpdates).toHaveLength(0)
    expect(settingsUpdates).toHaveLength(0)
  })

  it('reuses the existing DEK when an admin replaces the Claude key', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(fundUpdates).toEqual([{ name: 'Renamed Fund' }])
    expect(settingsUpdates).toHaveLength(1)
    expect(settingsUpdates[0].encryption_key_encrypted).toBe(storedEncryptedDek)
    expect(decrypt(String(settingsUpdates[0].claude_api_key_encrypted), originalDek)).toBe('new-api-key')
  })
})
