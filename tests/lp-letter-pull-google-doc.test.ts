import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Bringing a draft back from the Google Doc the partners edited: compared first, replaced only on
 * request, internal notes kept, and never on a final letter or a letter outside the caller's entities.
 */

const store = memoryAdmin()
let scope: { vehicleNames: string[] | null } | null = { vehicleNames: null }
const docText = vi.fn(async () => Buffer.from('﻿Dear Investors,\r\n\r\n\r\nAcme grew fast.\r\nClosing\r\n'))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'fund-1', userId: 'u1', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => scope }))
vi.mock('@/lib/google/fund-drive', () => ({ fundDriveToken: async () => ({ ok: true, value: { accessToken: 'tok', folderId: 'root' } }) }))
vi.mock('@/lib/google/drive', () => ({ exportFile: (...a: unknown[]) => (docText as any)(...a) }))

import { POST } from '@/app/api/lp-letters/[id]/pull-google-doc/route'

const DOC = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'
const pull = (body: unknown, id = 'l1') =>
  POST(new NextRequest(`http://localhost/api/lp-letters/${id}/pull-google-doc`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  docText.mockClear()
  scope = { vehicleNames: null }
  store.tables.lp_letters = [
    { id: 'l1', fund_id: 'fund-1', portfolio_group: 'Fund I', status: 'draft', full_draft: 'Dear Investors,\n\nAcme grew.\nClosing', internal_notes: '- Birch update.' },
    { id: 'l2', fund_id: 'fund-1', portfolio_group: 'Fund I', status: 'final', full_draft: 'Sent.' },
    { id: 'l3', fund_id: 'fund-1', portfolio_group: 'Fund II', status: 'draft', full_draft: 'Other.' },
  ]
})

describe('pulling a draft back from a Google Doc', () => {
  it('compares without saving, then replaces the text and keeps the internal notes', async () => {
    const res = await pull({ url: DOC })
    expect(res.status).toBe(200)
    const preview = await res.json()
    expect(docText).toHaveBeenCalledWith('tok', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'text/plain')
    expect(preview.diff).toMatchObject({ added: 1, removed: 1, unchanged: 2 })
    expect(preview.text).toBe('Dear Investors,\n\nAcme grew fast.\nClosing')
    expect(store.tables.lp_letters[0].full_draft).toBe('Dear Investors,\n\nAcme grew.\nClosing')

    const applied = await pull({ url: DOC, apply: true })
    expect(applied.status).toBe(200)
    expect(store.tables.lp_letters[0]).toMatchObject({ full_draft: 'Dear Investors,\n\nAcme grew fast.\nClosing', internal_notes: '- Birch update.' })
  })

  it('refuses a link that is not a Google Doc, a final letter, and a letter outside the caller\'s entities', async () => {
    expect((await pull({ url: 'https://example.com/x' })).status).toBe(400)
    expect((await pull({ url: DOC, apply: true }, 'l2')).status).toBe(409)
    expect(store.tables.lp_letters[1].full_draft).toBe('Sent.')
    scope = { vehicleNames: ['Fund I'] }
    expect((await pull({ url: DOC, apply: true }, 'l3')).status).toBe(404)
    expect(store.tables.lp_letters[2].full_draft).toBe('Other.')
  })

  it("says so when the doc can't be read", async () => {
    docText.mockRejectedValueOnce(new Error('404'))
    const res = await pull({ url: DOC })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Couldn't read that Google Doc/)
  })
})
