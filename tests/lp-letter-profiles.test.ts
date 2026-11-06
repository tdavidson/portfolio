import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Letter profiles and imported letters: a profile per entity over a firm-wide one, kept to the
 * caller's entities; and a letter as sent brought in as final, its file kept as sent, so it is the
 * entity's last letter for the next brief.
 */

const store = memoryAdmin()
let scope: { vehicleNames: string[] | null } | null = { vehicleNames: null }
const uploads: { bucket: string; path: string }[] = []
const admin = new Proxy(store.admin as any, {
  get(target, k) {
    if (k === 'storage') return { from: (bucket: string) => ({ upload: async (path: string) => { uploads.push({ bucket, path }); return { error: null } } }) }
    return target[k]
  },
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'fund-1', userId: 'u1', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => scope }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/parsing/extractAttachmentText', () => ({
  extractFromBuffer: async () => ({ extractedText: 'Dear partners.\n\nAcme Robotics\n\nAcme grew.\n\nMissing information\n- Nothing.' }),
}))

import { GET, PUT } from '@/app/api/lp-letters/profiles/route'
import { POST as importLetter } from '@/app/api/lp-letters/import/route'
import { lastFinalLetter } from '@/lib/lp-letters/profile-store'

const get = (vehicle?: string) => GET(new NextRequest(`http://localhost/api/lp-letters/profiles${vehicle ? `?vehicle=${encodeURIComponent(vehicle)}` : ''}`))
const put = (body: unknown, vehicle?: string) =>
  PUT(new NextRequest(`http://localhost/api/lp-letters/profiles${vehicle ? `?vehicle=${encodeURIComponent(vehicle)}` : ''}`, { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(() => {
  scope = { vehicleNames: null }
  uploads.length = 0
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'u1' }]
  store.tables.fund_vehicles = [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I' }, { id: 'v2', fund_id: 'fund-1', name: 'Fund II' }]
  store.tables.lp_letter_profiles = []
  store.tables.lp_letter_templates = []
  store.tables.lp_letters = []
  store.tables.companies = [{ id: 'c1', fund_id: 'fund-1', name: 'Acme Robotics', holding_type: 'company' }]
})

describe('letter profiles', () => {
  it("saves the firm-wide and an entity's profile, and reads the entity's over the firm's", async () => {
    expect((await put({ profile: { firm_name: 'Example Capital', signatories: [{ name: 'Jane Doe', title: 'Partner' }] } }))!.status).toBe(200)
    expect((await put({ profile: { legal_name: 'Example Fund I, L.P.' } }, 'Fund I'))!.status).toBe(200)
    const out = await (await get('Fund I')).json()
    expect(out.profile).toMatchObject({ firm_name: 'Example Capital', legal_name: 'Example Fund I, L.P.', signatories: [{ name: 'Jane Doe' }] })
    expect(out.own.firm_name).toBeNull()
    expect(store.tables.lp_letter_profiles.map((r: any) => r.vehicle_id).sort()).toEqual([null, 'v1'].sort())
    // Saving again replaces the row rather than adding one.
    await put({ profile: { legal_name: 'Example Fund I, LP' } }, 'Fund I')
    expect(store.tables.lp_letter_profiles).toHaveLength(2)
  })

  it("keeps a member limited to some entities to theirs, and off the firm-wide profile", async () => {
    scope = { vehicleNames: ['Fund I'] }
    expect((await get('Fund II')).status).toBe(404)
    expect((await put({ profile: { legal_name: 'x' } }, 'Fund II'))!.status).toBe(404)
    expect((await put({ profile: { firm_name: 'x' } }))!.status).toBe(403)
    expect((await put({ profile: { legal_name: 'Example Fund I, L.P.' } }, 'Fund I'))!.status).toBe(200)
  })

  it('refuses a template from outside the fund', async () => {
    expect((await put({ profile: { template_id: 'nope' } }, 'Fund I'))!.status).toBe(400)
  })
})

describe('importing a sent letter', () => {
  const send = (fields: Record<string, string>) => {
    const form = new FormData()
    form.append('file', new File(['%PDF'], 'Q2 letter.pdf', { type: 'application/pdf' }))
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    return importLetter(new NextRequest('http://localhost/api/lp-letters/import', { method: 'POST', body: form }))
  }

  it('saves it final and imported, split into sections, notes apart, and the file kept as sent', async () => {
    const res = await send({ vehicle: 'Fund I', year: '2026', quarter: '2' })
    expect(res.status).toBe(200)
    const l = store.tables.lp_letters[0]
    expect(l).toMatchObject({ status: 'final', source: 'imported', portfolio_group: 'Fund I', internal_notes: 'Missing information\n- Nothing.' })
    expect(l.content.sections.map((s: any) => s.id)).toEqual(['opening', 'company:c1'])
    expect(uploads).toEqual([{ bucket: 'lp-letter-originals', path: `fund-1/${l.id}/Q2 letter.pdf` }])
    expect(l.original_file).toMatchObject({ name: 'Q2 letter.pdf', type: 'application/pdf' })
    // It is now the entity's last letter for a later quarter, without the partners' notes.
    const last = await lastFinalLetter(store.admin as any, 'fund-1', 'Fund I', 2026, 3)
    expect(last).toMatchObject({ id: l.id, period: 'Q2 2026' })
    expect(last!.text).not.toMatch(/Missing information/)
    expect(await lastFinalLetter(store.admin as any, 'fund-1', 'Fund I', 2026, 2)).toBeNull()
  })

  it("refuses a bad period, and an entity outside the caller's", async () => {
    expect((await send({ vehicle: 'Fund I', year: '26', quarter: '2' })).status).toBe(400)
    scope = { vehicleNames: ['Fund II'] }
    expect((await send({ vehicle: 'Fund I', year: '2026', quarter: '2' })).status).toBe(403)
    expect(store.tables.lp_letters).toEqual([])
  })
})
