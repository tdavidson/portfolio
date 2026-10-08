import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn(), get: vi.fn() }))
vi.mock('./index', async orig => ({
  ...(await orig<typeof import('./index')>()),
  listDocuments: m.list, searchDocuments: m.search, getDocument: m.get,
}))

import { runEntityDocumentsTool } from './analyst'

const member = { fundId: 'f1', vehicles: { all: false, ids: ['v1', 'v3'] } } as any
const vehicles = [{ id: 'v1', name: 'Fund I', aliases: [] }, { id: 'v2', name: 'Fund II', aliases: [] }, { id: 'v3', name: 'GP LLC', aliases: ['The GP'] }]
const admin = { from: () => { const c: any = { select: () => c, eq: () => c, then: (r: any) => r({ data: vehicles, error: null }) }; return c } } as any
const deps = (defaultEntity: string | null = null) => ({ admin, fundId: 'f1', access: member, defaultEntity })

describe('entity_documents tool — the caller\'s entities only', () => {
  beforeEach(() => { m.list.mockReset().mockResolvedValue([]); m.search.mockReset().mockResolvedValue([]); m.get.mockReset() })

  it('lists and searches across the caller\'s entities when none is named', async () => {
    await runEntityDocumentsTool(deps(), { action: 'list' })
    expect(m.list).toHaveBeenCalledWith(expect.anything(), 'f1', ['v1', 'v3'])
    await runEntityDocumentsTool(deps(), { action: 'search', query: 'management fee' })
    expect(m.search).toHaveBeenCalledWith(expect.anything(), 'f1', ['v1', 'v3'], 'management fee', 8)
  })
  it('narrows to the entity in view, and refuses one the caller cannot see', async () => {
    await runEntityDocumentsTool(deps('Fund I'), { action: 'list' })
    expect(m.list).toHaveBeenCalledWith(expect.anything(), 'f1', ['v1'])
    await expect(runEntityDocumentsTool(deps(), { action: 'list', entity: 'Fund II' })).rejects.toThrow(/Unknown entity "Fund II"\. Yours: Fund I, GP LLC$/)
    await runEntityDocumentsTool(deps(), { action: 'list', entity: 'the gp' })
    expect(m.list).toHaveBeenLastCalledWith(expect.anything(), 'f1', ['v3'])
  })
  it('reads only a document of the caller\'s entities', async () => {
    m.get.mockResolvedValue(null)
    expect(await runEntityDocumentsTool(deps('Fund I'), { action: 'read', document_id: 'd9' })).toEqual({ error: 'No such document among your entities.' })
    expect(m.get).toHaveBeenCalledWith(expect.anything(), 'f1', 'd9', ['v1', 'v3'])
  })
  it('says when a scan is still being read', async () => {
    m.get.mockResolvedValue({ id: 'd1', title: 'LPA', kind: 'lpa', extracted_text: null, ocr_status: 'pending' })
    expect(await runEntityDocumentsTool(deps(), { action: 'read', document_id: 'd1' })).toEqual({ error: expect.stringMatching(/still being read/) })
  })
  it('returns a window of text with the document named', async () => {
    m.get.mockResolvedValue({ id: 'd1', title: 'Fund I LPA', kind: 'lpa', effective_date: '2024-01-01', extracted_text: '[Page 1]\nThe Management Fee…', ocr_status: 'none' })
    expect(await runEntityDocumentsTool(deps(), { action: 'read', document_id: 'd1' })).toMatchObject({
      document: { title: 'Fund I LPA', kind: 'LPA' }, text: expect.stringContaining('Management Fee'), next_offset: null,
    })
  })
})
