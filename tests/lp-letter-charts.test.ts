import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Charts in a letter: images stored under their hash and never replaced, placed after a section,
 * changed only on a draft, and served only while the file is still the image the letter points at.
 * And the export route: every format leaves the partners' notes out.
 */

const store = memoryAdmin()
let scope: { vehicleNames: string[] | null } | null = { vehicleNames: null }
const objects = new Map<string, Uint8Array>()
const admin = new Proxy(store.admin as any, {
  get(target, k) {
    if (k === 'storage') {
      return {
        from: (bucket: string) => ({
          upload: async (path: string, bytes: Uint8Array, opts: any) => {
            const key = `${bucket}/${path}`
            if (objects.has(key) && !opts?.upsert) return { error: { message: 'The resource already exists' } }
            objects.set(key, bytes)
            return { error: null }
          },
          download: async (path: string) => {
            const b = objects.get(`${bucket}/${path}`)
            return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: 'not found' } }
          },
        }),
      }
    }
    return target[k]
  },
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'fund-1', userId: 'u1', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => scope }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/lp-letters/service', async orig => ({
  ...(await orig<any>()),
  letterData: async () => ({
    asOf: '2026-09-30', fundName: 'Example Fund', fundCurrency: 'USD', periodLabel: 'Q3 2026', portfolioGroup: 'Fund I', fundMetrics: null,
    companies: [{ investment: { companyId: 'c1', companyName: 'Acme', status: 'active', totalInvested: 100_000, totalRealized: 0, unrealizedValue: 300_000, fmv: 300_000, moic: 3 } }],
    totals: { totalInvested: 100_000, totalFmv: 300_000, totalRealized: 0, portfolioMoic: 3, activeCount: 1, exitedCount: 0, writtenOffCount: 0 },
  }),
}))
vi.mock('@/lib/lp-report-pdf', async orig => ({
  ...(await orig<any>()),
  renderSvgToPng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 208, 0, 0, 0, 80, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
}))
vi.mock('@/lib/vehicle-letterhead', async orig => ({
  ...(await orig<any>()),
  documentLetterhead: async () => ({ name: 'Example Fund', logo: null, address: null, email: null }),
}))

import { POST as post, PATCH as patchRoute, DELETE as del } from '@/app/api/lp-letters/[id]/charts/route'
import { GET as image } from '@/app/api/lp-letters/[id]/charts/[chartId]/route'
import { POST as exportRoute } from '@/app/api/lp-letters/[id]/export/route'
import { POST as generateChart } from '@/app/api/lp-letters/[id]/charts/generate/route'
import { POST as pullWord } from '@/app/api/lp-letters/[id]/pull-word/route'
import { buildLetterDocx } from '@/lib/lp-letters/docx-letter'
import { letterDocument } from '@/lib/lp-letters/document'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0])
const POST = async (...a: Parameters<typeof post>) => (await post(...a))!
const PATCH = async (...a: Parameters<typeof patchRoute>) => (await patchRoute(...a))!
const DELETE = async (...a: Parameters<typeof del>) => (await del(...a))!
const params = (id = 'l1') => ({ params: Promise.resolve({ id }) })

function upload(bytes: Uint8Array, fields: Record<string, string> = {}, id = 'l1') {
  const form = new FormData()
  form.append('file', new File([bytes as BlobPart], 'chart.png', { type: 'image/png' }))
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return POST(new NextRequest(`http://localhost/api/lp-letters/${id}/charts`, { method: 'POST', body: form }), params(id))
}

beforeEach(() => {
  scope = { vehicleNames: null }
  objects.clear()
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'u1' }]
  store.tables.funds = [{ id: 'fund-1', name: 'Example Fund' }]
  store.tables.fund_vehicles = []
  store.tables.lp_letters = [{
    id: 'l1', fund_id: 'fund-1', portfolio_group: 'Fund I', status: 'draft', period_label: 'Q3 2026', charts: [],
    content: { version: 1, sections: [
      { id: 'opening', kind: 'text', heading: null, body: 'Dear partners.' },
      { id: 'company:c1', kind: 'company', heading: 'Acme', company_id: 'c1', body: 'Acme grew.' },
    ] },
    full_draft: 'Dear partners.\n\nAcme\n\nAcme grew.\n\nMissing information\n- Birch marks',
  }]
})

describe('letter charts', () => {
  it('stores an image under its hash and places it after a section', async () => {
    const res = await upload(PNG, { caption: 'Revenue', section_id: 'company:c1' })
    expect(res.status).toBe(200)
    const [c] = (await res.json()).charts
    const sha = createHash('sha256').update(PNG).digest('hex')
    expect(c).toMatchObject({ section_id: 'company:c1', caption: 'Revenue', sha256: sha, path: `fund-1/l1/${sha}.png`, width: 4, height: 2 })
    expect(objects.has(`lp-letter-charts/fund-1/l1/${sha}.png`)).toBe(true)
    // The same image again reuses the stored file rather than failing.
    expect((await upload(PNG)).status).toBe(200)
    expect(store.tables.lp_letters[0].charts).toHaveLength(2)
  })

  it('refuses anything but a PNG or JPEG, by its bytes', async () => {
    const res = await upload(new TextEncoder().encode('<svg onload="x"></svg>'))
    expect(res.status).toBe(400)
  })

  it('changes a caption, takes a chart off, and leaves a final letter alone', async () => {
    const [c] = (await (await upload(PNG)).json()).charts
    const patched = await PATCH(new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ chart_id: c.id, caption: 'New' }) }), params())
    expect((await patched.json()).charts[0].caption).toBe('New')
    store.tables.lp_letters[0].status = 'final'
    expect((await upload(PNG)).status).toBe(409)
    expect((await DELETE(new NextRequest(`http://localhost/x?chart=${c.id}`, { method: 'DELETE' }), params())).status).toBe(409)
    store.tables.lp_letters[0].status = 'draft'
    expect((await DELETE(new NextRequest(`http://localhost/x?chart=${c.id}`, { method: 'DELETE' }), params())).status).toBe(200)
    // The image itself is kept.
    expect(objects.size).toBe(1)
  })

  it('serves the image only while it is the one the letter points at, and only to members who see the entity', async () => {
    const [c] = (await (await upload(PNG)).json()).charts
    const get = () => image(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: 'l1', chartId: c.id }) })
    const ok = await get()
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    objects.set(`lp-letter-charts/${c.path}`, new Uint8Array([1, 2, 3]))
    expect((await get()).status).toBe(404)
    objects.set(`lp-letter-charts/${c.path}`, PNG)
    scope = { vehicleNames: ['Fund II'] }
    expect((await get()).status).toBe(404)
  })

  it('reads no file outside the letter, whatever the stored list says', async () => {
    objects.set('lp-letter-charts/fund-2/l9/x.png', PNG)
    const sha = createHash('sha256').update(PNG).digest('hex')
    store.tables.lp_letters[0].charts = [{ id: 'c-x', section_id: null, caption: null, path: 'fund-2/l9/x.png', content_type: 'image/png', sha256: sha, width: 4, height: 2, uploaded_at: '', uploaded_by: null }]
    expect((await image(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: 'l1', chartId: 'c-x' }) })).status).toBe(404)
  })
})

describe('letter export', () => {
  const exp = (format: string) => exportRoute(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ format }) }), params())

  it('gives Markdown and JSON without the partners\' notes', async () => {
    const md = await (await exp('markdown')).text()
    expect(md).toContain('## Acme')
    expect(md).not.toContain('Birch')
    const json = await (await exp('json')).json()
    expect(json.letter_id).toBe('l1')
    expect(json.sections.map((s: any) => s.heading)).toEqual([null, 'Acme'])
  })

  it('gives a Word file', async () => {
    const res = await exp('docx')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('wordprocessingml')
  })

  it('refuses an unknown format, and a letter on an entity the member does not see', async () => {
    expect((await exp('rtf')).status).toBe(400)
    scope = { vehicleNames: ['Fund II'] }
    expect((await exp('markdown')).status).toBe(404)
  })
})

describe('bringing a draft back from Word', () => {
  const send = async (buf: Buffer, apply = false) => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(buf) as BlobPart], 'letter.docx'))
    if (apply) form.append('apply', 'true')
    return (await pullWord(new NextRequest('http://localhost/x', { method: 'POST', body: form }), params()))!
  }

  it("compares the export's own Word file with the draft and finds nothing changed", async () => {
    const edited = { ...store.tables.lp_letters[0], content: { version: 1, sections: [
      { id: 'opening', kind: 'text', heading: null, body: 'Dear partners.' },
      { id: 'company:c1', kind: 'company', heading: 'Acme', company_id: 'c1', body: 'Acme grew fast.' },
    ] } }
    const buf = await buildLetterDocx(letterDocument(edited), { fundName: 'Example Fund', logo: null, address: null, chartBytes: new Map() })
    const res = await send(buf)
    expect(res.status).toBe(200)
    const { comparison } = await res.json()
    expect(comparison.sections).toEqual([{ section_id: 'company:c1', heading: 'Acme', change: 'changed' }])
    // Not applied yet.
    expect(store.tables.lp_letters[0].content.sections[1].body).toBe('Acme grew.')
    const applied = await send(buf, true)
    expect(applied.status).toBe(200)
    expect(store.tables.lp_letters[0].content.sections[1].body).toBe('Acme grew fast.')
  })

  it('never changes a final letter', async () => {
    store.tables.lp_letters[0].status = 'final'
    const buf = await buildLetterDocx(letterDocument(store.tables.lp_letters[0]), { fundName: 'F', logo: null, address: null, chartBytes: new Map() })
    expect((await send(buf, true)).status).toBe(409)
  })
})

describe('charts drawn from the letter\'s figures', () => {
  const gen = async (body: unknown) => (await generateChart(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), params()))!

  it('previews without saving, then adds the image with its caption and what drew it', async () => {
    const preview = await gen({ kind: 'value_by_company' })
    expect(preview.status).toBe(200)
    const p = await preview.json()
    expect(p.svg).toContain('<svg')
    expect(p.caption).toMatch(/gross/)
    expect(store.tables.lp_letters[0].charts).toHaveLength(0)
    const saved = await gen({ kind: 'value_by_company', save: true, section_id: 'company:c1', options: { color: 'ink', limit: 5 } })
    expect(saved.status).toBe(200)
    const [c] = store.tables.lp_letters[0].charts
    expect(c).toMatchObject({ section_id: 'company:c1', caption: p.caption, generated: { kind: 'value_by_company', as_of: '2026-09-30', options: { color: 'ink', limit: 5 } } })
    expect(objects.has(`lp-letter-charts/${c.path}`)).toBe(true)
  })

  it('refuses an unknown chart, one with nothing to draw, and a final letter', async () => {
    expect((await gen({ kind: 'pie' })).status).toBe(400)
    expect((await gen({ kind: 'capital_net' })).status).toBe(400)
    store.tables.lp_letters[0].status = 'final'
    expect((await gen({ kind: 'value_by_company', save: true })).status).toBe(409)
  })
})
