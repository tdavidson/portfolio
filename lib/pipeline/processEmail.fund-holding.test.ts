// lib/pipeline/processEmail.fund-holding.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ propose: vi.fn() }))
vi.mock('@/lib/company-updates/capture', () => ({
  captureCompanyUpdate: vi.fn(async () => 'update-1'),
  removeCompanyUpdate: vi.fn(async () => undefined),
  updateCompanyUpdatePeriod: vi.fn(async () => undefined),
}))
vi.mock('@/lib/parsing/extractAttachmentText', () => ({
  extractAttachmentText: vi.fn(async () => ({
    emailBody: 'Please find our Q3 statement attached.',
    attachments: [
      { filename: 'q3.pdf', contentType: 'application/pdf', extractedText: '', skipped: false, base64Content: 'JVBERi0x' },
      { filename: 'logo.png', contentType: 'image/png', extractedText: '', skipped: true, base64Content: 'iVBOR' },
    ],
  })),
}))
vi.mock('@/lib/ai/feature-provider', () => ({
  getFeatureProvider: vi.fn(async () => ({ provider: { createMessage: vi.fn() }, providerType: 'test', model: 'test-model' })),
}))
vi.mock('@/lib/portfolio/fof-email', () => ({ proposeFundReviews: mocks.propose }))
import { emailDate, runPipeline, type PostmarkPayload } from './processEmail'

const payload: PostmarkPayload = {
  From: 'ir@meridian.test', To: 'updates@fund.test', Subject: 'Q3 capital account statement',
  TextBody: 'Please find our Q3 statement attached.', Date: 'Fri, 14 Nov 2025 10:00:00 +0000',
}

beforeEach(() => { mocks.propose.mockReset().mockResolvedValue({ written: 2, warnings: [] }) })

describe('a fund holding\'s email', () => {
  it('proposes register rows from the PDF and leaves the email needing review', async () => {
    const db = fakeDb('fund')
    await runPipeline(db as any, 'email-1', 'fund-1', payload, null, { forcedRoute: 'reporting' })
    expect(mocks.propose).toHaveBeenCalledWith(db, expect.objectContaining({
      fundId: 'fund-1', emailId: 'email-1', companyId: 'h1',
      access: { vehicles: { all: true, ids: [] } },
      fallbackDate: '2025-11-14',
      content: [
        { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0x' },
        { type: 'text', text: expect.stringContaining('[EMAIL BODY]') },
      ],
    }))
    expect(db.statuses.at(-1)).toBe('needs_review')
  })

  it('a company\'s email never runs the manager reader', async () => {
    const db = fakeDb('company')
    await runPipeline(db as any, 'email-2', 'fund-1', payload, null, { forcedRoute: 'reporting' })
    expect(mocks.propose).not.toHaveBeenCalled()
    expect(db.statuses.at(-1)).toBe('success')
  })

  it('with fund holdings switched off or hidden, the manager reader does not run and the email is filed', async () => {
    for (const investments of ['off', 'hidden']) {
      mocks.propose.mockClear()
      const db = fakeDb('fund', { investments })
      await runPipeline(db as any, 'email-3', 'fund-1', payload, null, { forcedRoute: 'reporting' })
      expect(mocks.propose).not.toHaveBeenCalled()
      expect(db.statuses.at(-1)).toBe('success')
    }
  })

  it('a date that is not a date falls back to today rather than throwing', () => {
    expect(emailDate({ ...payload, Date: 'not a date' })).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

function fakeDb(holdingType: string, featureVisibility: Record<string, string> | null = null) {
  const statuses: string[] = []
  return {
    statuses,
    from(table: string) {
      if (table === 'inbound_emails') {
        return {
          update: (v: any) => { if (v.processing_status) statuses.push(v.processing_status); return chain({ data: null, error: null }) },
          select: () => chain({ data: { company_id: 'h1' }, error: null }),
        }
      }
      if (table === 'companies') {
        return {
          select: (cols: string) => chain(cols.includes('holding_type')
            ? { data: { holding_type: holdingType }, error: null }
            : { data: [{ id: 'h1', name: 'Meridian Growth Partners IV', aliases: [] }], error: null }),
        }
      }
      if (table === 'metrics') return { select: () => chain({ data: [], error: null }) }
      if (table === 'fund_settings') {
        return { select: (cols: string) => chain({ data: cols.includes('feature_visibility') && featureVisibility ? { feature_visibility: featureVisibility } : null, error: null }) }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }
}

function chain(result: any) {
  const query: any = {
    eq: () => query, order: () => query,
    single: async () => result, maybeSingle: async () => result,
    then: (resolve: (v: any) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}
