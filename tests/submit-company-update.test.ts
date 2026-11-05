import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A company update handed over from chat runs the emailed-update pipeline: recorded as an inbound
 * email routed to reporting, files scanned before they are stored, an unsafe file never reaching
 * extraction, and the result read back from what the pipeline wrote.
 */

const runPipeline = vi.fn(async (..._a: unknown[]) => {})
const scanFileAsync = vi.fn(async (_b: Buffer, name: string) => (name.startsWith('bad') ? { safe: false, reason: 'executable content' } : { safe: true }))
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: (...a: unknown[]) => runPipeline(...a) }))
vi.mock('@/lib/parsing/extractAttachmentText', () => ({ hydrateAttachments: async (p: unknown) => p }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: (b: Buffer, n: string) => scanFileAsync(b, n) }))

import { companyUpdateStatus, parseUpdateFiles, reprocessCompanyUpdate, submitCompanyUpdate } from '@/lib/company-updates/submit'

const inserts: any[] = []
const updates: any[] = []
const uploads: string[] = []
function admin(): any {
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'gp@firm.com' } } }) } },
    storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null } } }) },
    from(table: string) {
      const q: any = {
        insert: (row: any) => { inserts.push({ table, row }); return q },
        update: (row: any) => { updates.push({ table, row }); return q },
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { id: 'email-1' }, error: null }),
        maybeSingle: async () => ({ data: table === 'inbound_emails' ? { processing_status: 'success', companies: { id: 'co-1', name: 'Acme' }, processing_error: null } : null }),
        then: (res: any) => res({ data: table === 'metric_values' ? [{ period_label: 'Q3 2026', value_number: 120000, metrics: { name: 'MRR' } }] : [] }),
      }
      return q
    },
  }
}

const deps = (over: Record<string, unknown> = {}) => ({
  admin: admin(), fundId: 'fund-1', userId: 'u1', access: {} as any, origin: 'https://fund.example.com',
  resolveCompany: async (ref: string) => ({ id: 'co-1', name: ref }),
  ...over,
})
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeEach(() => { vi.clearAllMocks(); inserts.length = 0; updates.length = 0; uploads.length = 0 })

describe('submitCompanyUpdate', () => {
  it('records it as a reporting email for the named company and runs the pipeline on it', async () => {
    const r = await submitCompanyUpdate(deps(), { company: 'Acme', text: 'MRR was $120k in Q3.' })
    const row = inserts.find(i => i.table === 'inbound_emails').row
    expect(row).toMatchObject({ fund_id: 'fund-1', routed_to: 'reporting', company_id: 'co-1', from_address: 'gp@firm.com' })
    const [, emailId, fundId, payload, member, options] = runPipeline.mock.calls[0] as any[]
    expect([emailId, fundId, member, options]).toEqual(['email-1', 'fund-1', { userId: 'u1' }, { forcedRoute: 'reporting' }])
    expect(payload.TextBody).toBe('MRR was $120k in Q3.')
    expect(r.metricsRecorded).toEqual([{ metric: 'MRR', period: 'Q3 2026', value: 120000 }])
    expect(r.url).toBe('https://fund.example.com/emails/email-1')
  })

  it('scans files before storing them, and keeps an unsafe one away from extraction', async () => {
    const r = await submitCompanyUpdate(deps(), {
      company: 'Acme',
      files: [{ filename: 'deck.pdf', content_base64: b64('%PDF-1.4 ok') }, { filename: 'bad.pdf', content_base64: b64('MZ...') }],
    })
    expect(uploads).toEqual(['email-1/0_deck.pdf'])
    const payload = (runPipeline.mock.calls[0] as any[])[3]
    expect(payload.Attachments[0].Content).toBeTruthy()
    expect(payload.Attachments[1].Content).toBeUndefined()
    expect(payload.Attachments[1].ContentError).toMatch(/Safety scan failed/)
    expect(r.warnings.join(' ')).toMatch(/bad\.pdf was refused/)
  })

  it('needs something to process', async () => {
    await expect(submitCompanyUpdate(deps(), { company: 'Acme' })).rejects.toThrow(/text, as files, or both/)
    expect(inserts).toHaveLength(0)
  })

  it('lets the pipeline identify the company when none is named', async () => {
    await submitCompanyUpdate(deps(), { text: 'Q3 update' })
    expect(inserts[0].row.company_id).toBeNull()
  })
})

describe('a company update that outlasts the call', () => {
  it('hands back a job instead of waiting, and keeps the pipeline running', async () => {
    let finish!: () => void
    runPipeline.mockImplementationOnce(() => new Promise<void>(r => { finish = r }))
    const r = await submitCompanyUpdate(deps({ budgetMs: 5 }), { company: 'Acme', text: 'Long deck' })
    expect(r.status).toBe('processing')
    expect(r.job).toMatchObject({ id: 'company_update:email-1', status: 'running', check_with: 'company_update_status' })
    finish()
  })

  it('returns a finished job when the pipeline is quick', async () => {
    const r = await submitCompanyUpdate(deps(), { company: 'Acme', text: 'MRR was $120k.' })
    expect(r.job).toMatchObject({ id: 'company_update:email-1', status: 'done' })
  })
})

describe('companyUpdateStatus', () => {
  const emailDb = (email: any) => {
    const db = admin()
    const from = db.from.bind(db)
    db.from = (table: string) => {
      const q = from(table)
      if (table === 'inbound_emails') {
        let cols = ''
        q.select = (c: string) => { cols = c; return q }
        q.maybeSingle = async () => ({ data: cols.includes('routed_to') ? email : { processing_status: 'success', companies: { id: 'co-1', name: 'Acme' } } })
      }
      return q
    }
    return db
  }

  it('reads back what the pipeline wrote', async () => {
    const r = await companyUpdateStatus(emailDb({ id: 'email-1', company_id: 'co-1', routed_to: 'reporting' }), 'fund-1', 'email-1', ['co-1'], 'https://f.example')
    expect(r.metricsRecorded).toEqual([{ metric: 'MRR', period: 'Q3 2026', value: 120000 }])
    expect(r.job.status).toBe('done')
  })

  it("doesn't show an update for a company outside the caller's scope, or an email that isn't an update", async () => {
    await expect(companyUpdateStatus(emailDb({ id: 'email-1', company_id: 'co-2', routed_to: 'reporting' }), 'fund-1', 'email-1', ['co-1'])).rejects.toThrow(/No company update/)
    await expect(companyUpdateStatus(emailDb({ id: 'email-1', company_id: null, routed_to: 'reporting' }), 'fund-1', 'email-1', ['co-1'])).rejects.toThrow(/No company update/)
    await expect(companyUpdateStatus(emailDb({ id: 'email-1', company_id: 'co-1', routed_to: 'deals' }), 'fund-1', 'email-1', null)).rejects.toThrow(/No company update/)
    await expect(companyUpdateStatus(emailDb(null), 'fund-1', 'email-1', null)).rejects.toThrow(/No company update/)
  })
})

describe('reprocessCompanyUpdate', () => {
  const deletes: string[] = []
  const saved = { id: 'email-1', fund_id: 'fund-1', company_id: 'co-1', routed_to: 'reporting', processing_status: 'success', subject: 'Acme Q3', raw_payload: { From: 'gp@fund.example', Subject: 'Acme Q3', TextBody: 'MRR $120k', Attachments: [] } }
  const db = (email: any, update: any = null) => {
    const base = admin()
    const from = base.from.bind(base)
    base.rpc = async () => ({ data: [{ user_id: 'u1' }] })
    base.from = (table: string) => {
      const q = from(table)
      let cols = ''
      q.delete = () => { deletes.push(table); return q }
      q.select = (c: string) => { cols = c; return q }
      if (table === 'company_updates') q.maybeSingle = async () => ({ data: update })
      if (table === 'inbound_emails') {
        q.maybeSingle = async () => ({ data: cols.includes('routed_to') ? email : { processing_status: 'success', companies: { id: 'co-1', name: 'Acme' }, processing_error: null } })
      }
      return q
    }
    return base
  }
  const rdeps = (admin: any, over: Record<string, unknown> = {}) => ({ admin, fundId: 'fund-1', visibleCompanyIds: ['co-1'], origin: 'https://fund.example', ...over })
  beforeEach(() => { deletes.length = 0 })

  it('clears the last run and runs the pipeline on the stored update, keeping its company', async () => {
    const r = await reprocessCompanyUpdate(rdeps(db(saved)), { update: 'company_update:email-1' })
    expect(deletes).toEqual(['parsing_reviews', 'metric_values'])
    const reset = updates.find(u => u.row.processing_status === 'processing').row
    expect(reset).not.toHaveProperty('company_id')
    const [, emailId, fundId, payload, member] = runPipeline.mock.calls[0] as any[]
    expect([emailId, fundId, member]).toEqual(['email-1', 'fund-1', { userId: 'u1' }])
    expect(payload.TextBody).toBe('MRR $120k')
    expect(r.metricsRecorded).toEqual([{ metric: 'MRR', period: 'Q3 2026', value: 120000 }])
    expect(r.job).toMatchObject({ id: 'company_update:email-1', status: 'done' })
  })

  it("finds the update by its get_updates id", async () => {
    let calls = 0
    const base = db(saved, { source_email_id: 'email-1' })
    const from = base.from
    base.from = (table: string) => {
      const q = from(table)
      if (table === 'inbound_emails') {
        const ms = q.maybeSingle
        q.maybeSingle = async () => (calls++ === 0 ? { data: null } : ms())
      }
      return q
    }
    const r = await reprocessCompanyUpdate(rdeps(base), { update: 'update-9' })
    expect(r.emailId).toBe('email-1')
  })

  it("refuses an update outside the caller's companies, one that isn't an update, and one still processing", async () => {
    await expect(reprocessCompanyUpdate(rdeps(db({ ...saved, company_id: 'co-2' })), { update: 'email-1' })).rejects.toThrow(/No saved company update/)
    await expect(reprocessCompanyUpdate(rdeps(db({ ...saved, routed_to: 'deals' }), { visibleCompanyIds: null }), { update: 'email-1' })).rejects.toThrow(/No saved company update/)
    await expect(reprocessCompanyUpdate(rdeps(db({ ...saved, processing_status: 'processing' })), { update: 'email-1' })).rejects.toThrow(/still processing/)
    expect(runPipeline).not.toHaveBeenCalled()
    expect(deletes).toEqual([])
  })

  it('records a pipeline failure on the update instead of throwing', async () => {
    runPipeline.mockRejectedValueOnce(new Error('OpenAI API key not configured'))
    await reprocessCompanyUpdate(rdeps(db(saved)), { update: 'email-1' })
    expect(updates.map(u => u.row)).toContainEqual({ processing_status: 'failed', processing_error: 'OpenAI API key not configured. Add it in Settings to process emails.' })
  })
})

describe('parseUpdateFiles', () => {
  it('refuses unsupported types, oversized files and too many files, before anything is written', () => {
    expect(() => parseUpdateFiles([{ filename: 'run.exe', content_base64: b64('x') }])).toThrow(/send a PDF/)
    expect(() => parseUpdateFiles([{ filename: 'big.pdf', content_base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }])).toThrow(/over 3 MB/)
    expect(() => parseUpdateFiles(Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.pdf`, content_base64: b64('x') })))).toThrow(/At most 5/)
  })

  it('accepts a data URL prefix and cleans the file name', () => {
    const [f] = parseUpdateFiles([{ filename: '../q3/kpis.xlsx', content_base64: `data:application/octet-stream;base64,${b64('sheet')}` }])
    expect(f.name).not.toContain('..')
    expect(f.type).toMatch(/spreadsheetml/)
    expect(f.bytes.toString()).toBe('sheet')
  })
})
