import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ ingested: [] as any[], uploaded: [] as any[], signed: [] as string[] }))

vi.mock('./index', async orig => ({
  ...(await orig<typeof import('./index')>()),
  ingestDocument: async (_admin: unknown, input: any) => {
    m.ingested.push(input)
    return { document: { id: 'doc-1', title: input.title, kind: input.kind } }
  },
}))

import { addEntityDocument, entityDocumentUploadUrl, MAX_INLINE_BYTES } from './agent'

const admin = {
  storage: {
    from: () => ({
      upload: async (path: string, body: Buffer) => { m.uploaded.push({ path, size: body.length }); return { error: null } },
      createSignedUploadUrl: async (path: string) => { m.signed.push(path); return { data: { signedUrl: `https://store/${path}`, token: 't' }, error: null } },
    }),
  },
} as any
const scope = { admin, fundId: 'fund-1', vehicleId: 'veh-1', userId: null }

beforeEach(() => { m.ingested = []; m.uploaded = []; m.signed = [] })

describe('entity documents over MCP', () => {
  it('issues an upload URL inside this fund and entity, and refuses files over 25 MB', async () => {
    const out = await entityDocumentUploadUrl(scope, { fileName: 'Northwind LPA.pdf', sizeBytes: 300_000 })
    expect(out.storagePath.startsWith('fund-1/veh-1/')).toBe(true)
    expect(out.signedUrl).toContain(out.storagePath)
    await expect(entityDocumentUploadUrl(scope, { fileName: 'x.pdf', sizeBytes: 30 * 1024 * 1024 })).rejects.toThrow(/25 MB/)
  })

  it('ingests an uploaded file as the requested kind, title and date', async () => {
    const doc = await addEntityDocument(scope, {
      storagePath: 'fund-1/veh-1/1_lpa.pdf', fileName: 'lpa.pdf', contentType: 'application/pdf',
      kind: 'lpa', title: 'LPA', effectiveDate: '2021-07-02',
    })
    expect(doc.id).toBe('doc-1')
    expect(m.ingested[0]).toMatchObject({
      fundId: 'fund-1', vehicleId: 'veh-1', storagePath: 'fund-1/veh-1/1_lpa.pdf', kind: 'lpa', title: 'LPA',
      effectiveDate: '2021-07-02', uploadedBy: null,
    })
  })

  it('refuses a storage path that belongs to another fund or entity', async () => {
    await expect(addEntityDocument(scope, { storagePath: 'fund-2/veh-1/1_lpa.pdf', fileName: 'lpa.pdf' })).rejects.toThrow(/does not belong/)
    await expect(addEntityDocument(scope, { storagePath: 'fund-1/veh-2/1_lpa.pdf', fileName: 'lpa.pdf' })).rejects.toThrow(/does not belong/)
    await expect(addEntityDocument(scope, { storagePath: 'fund-1/veh-1/../veh-2/x', fileName: 'x' })).rejects.toThrow(/does not belong/)
    expect(m.ingested).toEqual([])
  })

  it('stores a small inline file in this entity before ingesting it', async () => {
    await addEntityDocument(scope, { contentBase64: Buffer.from('%PDF-1.4 hello').toString('base64'), fileName: 'a.pdf', kind: 'nonsense' })
    expect(m.uploaded[0].path.startsWith('fund-1/veh-1/')).toBe(true)
    expect(m.ingested[0]).toMatchObject({ storagePath: m.uploaded[0].path, kind: 'other', title: 'a.pdf' })
  })

  it('sends large inline files to the upload URL instead, and needs exactly one source', async () => {
    const big = Buffer.alloc(MAX_INLINE_BYTES + 1).toString('base64')
    await expect(addEntityDocument(scope, { contentBase64: big, fileName: 'big.pdf' })).rejects.toThrow(/entity_document_upload_url/)
    await expect(addEntityDocument(scope, { fileName: 'none.pdf' })).rejects.toThrow(/storagePath .* or contentBase64/)
    await expect(addEntityDocument(scope, { storagePath: 'fund-1/veh-1/a', contentBase64: 'aGk=', fileName: 'a' })).rejects.toThrow(/not both/)
    expect(m.uploaded).toEqual([])
  })
})
