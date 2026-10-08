import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { documentStoragePath, pathBelongsTo, textWindow, pdfOfPages, runEntityDocumentOcr } from './index'

async function blankPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200, 200])
  return Buffer.from(await doc.save())
}

describe('entity documents — paths', () => {
  it('stores under the fund, then the entity', () => {
    expect(documentStoragePath('f1', 'v1', 'Fund I LPA (final).pdf', 5)).toBe('f1/v1/5_Fund_I_LPA_final_.pdf')
  })
  it('accepts only a path issued for this fund and entity', () => {
    expect(pathBelongsTo('f1/v1/5_a.pdf', 'f1', 'v1')).toBe(true)
    expect(pathBelongsTo('f1/v2/5_a.pdf', 'f1', 'v1')).toBe(false)
    expect(pathBelongsTo('f1/v1/../v2/a.pdf', 'f1', 'v1')).toBe(false)
  })
})

describe('textWindow', () => {
  it('pages through long text', () => {
    expect(textWindow('abcdefghij', 0, 4)).toEqual({ text: 'abcd', offset: 0, total_chars: 10, next_offset: 4 })
    expect(textWindow('abcdefghij', 8, 4)).toEqual({ text: 'ij', offset: 8, total_chars: 10, next_offset: null })
  })
})

describe('pdfOfPages', () => {
  it('makes a PDF of just the requested pages', async () => {
    const sub = await pdfOfPages(await blankPdf(5), [2, 4])
    expect((await PDFDocument.load(sub)).getPageCount()).toBe(2)
  })
})

describe('runEntityDocumentOcr — a long scanned document', () => {
  it('transcribes textless pages in small batches, saves progress, and rebuilds text and chunks', async () => {
    const pdf = await blankPdf(10)
    const doc = {
      id: 'd1', fund_id: 'f1', vehicle_id: 'v1', storage_path: 'f1/v1/x.pdf', content_type: 'application/pdf',
      ocr_status: 'pending', ocr_attempts: 0, warnings: [], ocr_progress: { needed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pages: {} },
    }
    const updates: any[] = []
    const inserted: any[] = []
    const admin = {
      storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array(pdf)]), error: null }) }) },
      from: (t: string) => {
        const chain: any = {
          select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
          update: (u: any) => { updates.push(u); return chain },
          delete: () => chain,
          insert: (rows: any[]) => { inserted.push(...rows); return Promise.resolve({ error: null }) },
          then: (res: any) => res({ data: t === 'entity_documents' ? [doc] : [], error: null }),
        }
        return chain
      },
    } as any
    const calls: number[] = []
    const engine = {
      name: 'test-ocr',
      transcribeImage: async () => '',
      transcribePdfPages: async (buf: Buffer, pages: number[]) => {
        calls.push((await PDFDocument.load(buf)).getPageCount())
        return Object.fromEntries(pages.map(p => [p, `Section ${p}. The Management Fee shall be two percent per annum.`]))
      },
    }
    const out = await runEntityDocumentOcr(admin, { engineFor: async () => engine })
    expect(calls).toEqual([8, 2])
    expect(out).toMatchObject({ documents: 1, pages: 10, completed: 1 })
    expect(updates.filter(u => u.ocr_progress && u.ocr_status === undefined)).toHaveLength(2)
    const final = updates[updates.length - 1]
    expect(final).toMatchObject({ ocr_status: 'complete', extraction_status: 'complete', ocr_progress: null })
    expect(final.extracted_text).toContain('[Page 10 (OCR)]')
    expect(inserted.length).toBe(10)
    expect(inserted[0]).toMatchObject({ document_id: 'd1', vehicle_id: 'v1', locator: expect.objectContaining({ page: 1, ocr: true }) })
  })
})
