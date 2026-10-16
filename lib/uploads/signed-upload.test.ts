import { describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ manual: [] as any[] }))
vi.mock('@/lib/deals/service', async orig => ({
  ...(await orig<typeof import('@/lib/deals/service')>()),
  createManualDeal: async (_admin: unknown, _ctx: unknown, input: any) => {
    m.manual.push(input)
    return { ok: true, value: { emailId: 'em-1', dealId: null, analysed: false } }
  },
}))

import {
  checkDeclaredSize, contentTypeFor, mintSignedUpload, readStagedUploads, stagingPath, STAGING_BUCKET, uploadFileName,
} from './signed-upload'
import { UPLOAD_HANDLERS } from '@/lib/agent/upload-tools'
import { DEALS_HANDLERS } from '@/lib/agent/deals-tools'
import { submitCompanyUpdate } from '@/lib/company-updates/submit'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { withMemoryStorage } from '../../tests/helpers/memory-storage'

const everyone = { fundId: 'f1', userId: 'u1', role: 'admin', vehicles: { all: true, ids: [] }, features: {}, grants: {}, defaults: {} } as any

function seed() {
  const { admin, tables } = memoryAdmin({})
  admin.auth = { admin: { getUserById: async () => ({ data: { user: { email: 'gp@fund.test' } } }) } }
  return { admin, tables, storage: withMemoryStorage(admin) }
}

describe('signed uploads', () => {
  it('name the file safely, type it from its extension, and check its size before minting', () => {
    expect(uploadFileName('/Users/jo/Data room/Acme deck.pdf')).toBe('Acme deck.pdf')
    expect(uploadFileName('..\\x\\..\\y.pdf')).toBe('y.pdf')
    expect(() => uploadFileName('')).toThrow(/fileName is required/)
    expect(contentTypeFor('a.PPTX')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(contentTypeFor('a.weird')).toBe('application/octet-stream')
    expect(() => checkDeclaredSize(11 * 1024 * 1024, 10 * 1024 * 1024)).toThrow('That file is 11 MB; the limit here is 10 MB.')
    expect(() => checkDeclaredSize(undefined, 10)).not.toThrow()
  })

  it('return the URL with the exact PUT form, headers, limit and a two-hour expiry', async () => {
    const { admin, storage } = seed()
    const out = await mintSignedUpload(admin, { bucket: 'b', storagePath: 'f1/x.pdf', fileName: 'x.pdf', maxBytes: 5, next: 'then register' })
    expect(storage.signed).toEqual([{ bucket: 'b', path: 'f1/x.pdf' }])
    expect(out.headers).toEqual({ 'Content-Type': 'application/pdf', 'x-upsert': 'false' })
    expect(out.curl).toBe(`curl -sS -X PUT -H "Content-Type: application/pdf" -H "x-upsert: false" --data-binary @"<path to x.pdf>" "${out.uploadUrl}"`)
    expect(out.expiresInSeconds).toBe(7200)
    expect(Math.abs(Date.parse(out.expiresAt) - (Date.now() + 7_200_000))).toBeLessThan(5_000)
    expect(out).toMatchObject({ method: 'PUT', maxBytes: 5, next: 'then register', storagePath: 'f1/x.pdf' })
  })
})

describe('staged uploads (files the app takes in as bytes)', () => {
  it("read back only this fund's uploads for this purpose, and only ones that arrived", async () => {
    const { admin, storage } = seed()
    const path = stagingPath('f1', 'deal', 'deck.pdf')
    storage.put(STAGING_BUCKET, path, '%PDF deck')
    const files = await readStagedUploads(admin, 'f1', 'deal', [{ storage_path: path }], { maxFiles: 2, maxBytes: 100 })
    expect(files).toEqual([{ name: 'deck.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF deck'), storagePath: path }])

    const other = stagingPath('f2', 'deal', 'deck.pdf')
    storage.put(STAGING_BUCKET, other, 'x')
    await expect(readStagedUploads(admin, 'f1', 'deal', [{ storage_path: other }], { maxFiles: 2, maxBytes: 100 })).rejects.toThrow(/not one of this fund's uploads/)
    await expect(readStagedUploads(admin, 'f1', 'update', [{ storage_path: path }], { maxFiles: 2, maxBytes: 100 })).rejects.toThrow(/not one of this fund's uploads/)
    await expect(readStagedUploads(admin, 'f1', 'deal', [{ storage_path: stagingPath('f1', 'deal', 'never.pdf') }], { maxFiles: 2, maxBytes: 100 })).rejects.toThrow(/Nothing has been uploaded/)
    await expect(readStagedUploads(admin, 'f1', 'deal', [{ storage_path: path }], { maxFiles: 2, maxBytes: 3 })).rejects.toThrow(/is over/)
    expect(storage.has(STAGING_BUCKET, path)).toBe(false)
  })

  it('give a new inbound deal its uploaded deck as the New deal form would, then drop the staged copy', async () => {
    const { admin, storage } = seed()
    m.manual = []
    const url = await UPLOAD_HANDLERS.deals_deck_upload_url({ admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyone }, { fileName: 'Zeta deck.pdf' }) as any
    expect(url.storagePath.startsWith('agent-staging/f1/deal/')).toBe(true)
    expect(url.maxBytes).toBe(10 * 1024 * 1024)
    storage.put(STAGING_BUCKET, url.storagePath, '%PDF-1.4 zeta')
    await DEALS_HANDLERS.deals_create_inbound({ admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyone }, {
      company_name: 'Zeta', founder_name: 'Z', founder_email: 'z@zeta.test', pitch: 'Robots.',
      uploaded_files: [{ storage_path: url.storagePath, filename: 'Zeta deck.pdf' }],
    })
    expect(m.manual[0].files).toEqual([{ name: 'Zeta deck.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 zeta') }])
    expect(storage.has(STAGING_BUCKET, url.storagePath)).toBe(false)
  })

  it('refuse an update file the pipeline cannot read, before anything is written', async () => {
    const { admin, tables, storage } = seed()
    const path = stagingPath('f1', 'update', 'tool.exe')
    storage.put(STAGING_BUCKET, path, 'MZ')
    await expect(submitCompanyUpdate(
      { admin, fundId: 'f1', userId: 'u1', access: everyone, resolveCompany: async () => ({ id: 'c1', name: 'Acme' }) },
      { company: 'Acme', uploaded_files: [{ storage_path: path }] },
    )).rejects.toThrow(/send a PDF, Word, Excel/)
    expect(tables.inbound_emails ?? []).toEqual([])
  })
})
