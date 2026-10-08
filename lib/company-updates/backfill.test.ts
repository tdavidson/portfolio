import { describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn())
vi.mock('./capture', async importOriginal => {
  const original = await importOriginal<typeof import('./capture')>()
  return { ...original, captureCompanyUpdate: captureMock }
})

import { createBackfillJob, isTransient, planBackfillJob, recoverReportingPeriod, retryFailedItems, runBackfillBatch, summarize, type BackfillJob } from './backfill'
import { CAPTURE_VERSION } from './extraction'

const FUND = '00000000-0000-4000-8000-000000000001'
const COMPANY = '00000000-0000-4000-8000-000000000002'
const E = (n: number) => `00000000-0000-4000-8000-0000000000e${n}`

/**
 * An in-memory stand-in for the four tables and the claim RPC, faithful to the filters the
 * production code sends (fund scoping is asserted through them).
 */
function fakeDb(seed: { emails?: any[]; updates?: any[]; metricValues?: any[] } = {}) {
  const jobs: any[] = []
  const items: any[] = []
  const emails = seed.emails ?? []
  const updates = seed.updates ?? []
  const periodWrites: any[] = []
  let ids = 0

  const filterRows = (rows: any[], filters: Array<[string, string, any]>) =>
    rows.filter(row => filters.every(([op, col, value]) => {
      if (op === 'eq') return row[col] === value
      if (op === 'in') return (value as any[]).includes(row[col])
      if (op === 'notnull') return row[col] !== null && row[col] !== undefined
      if (op === 'or-route') return row.routed_to === 'reporting' || row.routed_to == null
      if (op === 'or-cursor') return `${row.received_at}|${row.id}` > value
      return true
    }))

  const builder = (table: string) => {
    const filters: Array<[string, string, any]> = []
    let action: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let payload: any = null
    let limitN = Number.POSITIVE_INFINITY
    let countOnly = false
    let projectAttachments = false
    const rows = () => (table === 'company_update_backfill_jobs' ? jobs : table === 'company_update_backfill_items' ? items : table === 'inbound_emails' ? emails : table === 'company_updates' ? updates : table === 'metric_values' ? seed.metricValues ?? [] : [])
    const run = () => {
      if (action === 'insert') {
        const row = { id: `row-${++ids}`, status: 'pending', counts: {}, planned: 0, total_eligible: 0, plan_cursor: null, started_at: null, finished_at: null, created_at: 'now', updated_at: 'now', ...payload }
        rows().push(row)
        return { data: row, error: null }
      }
      if (action === 'upsert') {
        const added: any[] = []
        for (const r of payload) {
          if (items.some(i => i.job_id === r.job_id && i.email_id === r.email_id)) continue
          const row = { id: `item-${++ids}`, attempts: 0, error: null, result: null, ...r }
          items.push(row)
          added.push(row)
        }
        return { data: added, error: null }
      }
      if (action === 'update') {
        if (table === 'company_updates') { periodWrites.push({ payload, filters }); return { data: null, error: null } }
        const matched = filterRows(rows(), filters)
        for (const row of matched) Object.assign(row, payload)
        return { data: table === 'company_update_backfill_items' ? matched : matched[0] ?? null, error: null }
      }
      const matched = filterRows(rows(), filters).sort((a, b) => (`${a.received_at}|${a.id}` < `${b.received_at}|${b.id}` ? -1 : 1)).slice(0, limitN)
      const projected = projectAttachments
        ? matched.map(({ raw_payload, claude_response, ...rest }) => ({ ...rest, attachments: raw_payload?.Attachments ?? null }))
        : matched
      return countOnly ? { data: null, count: matched.length, error: null } : { data: projected, error: null }
    }
    const q: any = {
      select: (cols?: string, opts?: any) => { if (opts?.head) countOnly = true; if (cols?.includes('attachments:raw_payload->Attachments')) projectAttachments = true; return q },
      insert: (p: any) => { action = 'insert'; payload = p; return q },
      upsert: (p: any) => { action = 'upsert'; payload = p; return q },
      update: (p: any) => { action = 'update'; payload = p; return q },
      eq: (col: string, value: any) => { filters.push(['eq', col, value]); return q },
      in: (col: string, value: any) => { filters.push(['in', col, value]); return q },
      not: (col: string) => { filters.push(['notnull', col, null]); return q },
      or: (expr: string) => {
        if (expr.startsWith('routed_to')) filters.push(['or-route', '', null])
        else { const m = /received_at\.gt\.([^,]+),and\(received_at\.eq\.[^,]+,id\.gt\.([^)]+)\)/.exec(expr)!; filters.push(['or-cursor', '', `${m[1]}|${m[2]}`]) }
        return q
      },
      order: () => q,
      range: () => q,
      limit: (n: number) => { limitN = n; return q },
      single: async () => run(),
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null } },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    }
    return q
  }

  const admin = {
    from: builder,
    rpc: async (name: string, args: any) => {
      if (name !== 'company_update_backfill_claim') throw new Error(`unexpected rpc ${name}`)
      const claimed = items.filter(i => i.job_id === args.p_job_id && i.status === 'pending').slice(0, args.p_limit)
      for (const i of claimed) { i.status = 'running'; i.attempts++ }
      return { data: claimed.map(i => ({ ...i })), error: null }
    },
  }
  return { admin, jobs, items, periodWrites }
}

const email = (n: number, over: Partial<any> = {}) => ({
  id: E(n), fund_id: FUND, company_id: COMPANY, received_at: `2026-08-0${n}T00:00:00Z`, routed_to: 'reporting',
  raw_payload: { From: 'a@b', To: 'c@d', TextBody: `Update ${n}`, Attachments: [{ Name: 'deck.pdf', ContentType: 'application/pdf', ContentLength: 10, StoragePath: `${E(n)}/0_deck.pdf` }] },
  claude_response: { reporting_period: { label: `Aug 2026`, year: 2026, quarter: null, month: 8, confidence: 'high' } },
  ...over,
})

describe('backfill planning', () => {
  it('dry run counts eligibility and capture state by version without writing items', async () => {
    const db = fakeDb({
      emails: [email(1), email(2), email(3, { routed_to: 'deals' }), email(4, { company_id: null }), email(5, { routed_to: null })],
      updates: [{ fund_id: FUND, source_email_id: E(1), parser_version: CAPTURE_VERSION }, { fund_id: FUND, source_email_id: E(2), parser_version: 'old' }],
    })
    const job = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'dry_run' })
    const planned = await planBackfillJob({ admin: db.admin as any }, job.id)
    expect(planned.status).toBe('completed')
    expect(planned.counts).toMatchObject({ eligible: 3, already_current: 1, stale_version: 1, never_captured: 1, would_process: 2 })
    // Planning no longer reads the raw payloads (they carry the files and timed out the read).
    expect(planned.counts).toMatchObject({ attachments: 0 })
    expect(db.items).toHaveLength(0)
  })

  it('a sample run plans only the requested company and count; a full run skips current captures unless reprocess', async () => {
    const db = fakeDb({ emails: [email(1), email(2), email(3, { company_id: 'other' })], updates: [{ fund_id: FUND, source_email_id: E(1), parser_version: CAPTURE_VERSION }] })
    const sample = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'sample', sampleCompanyId: COMPANY, sampleLimit: 1 })
    await planBackfillJob({ admin: db.admin as any }, sample.id)
    expect(db.items.filter(i => i.job_id === sample.id).map(i => [i.email_id, i.status])).toEqual([[E(1), 'skipped']])

    const full = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'full', reprocess: true })
    const planned = await planBackfillJob({ admin: db.admin as any }, full.id)
    expect(planned.status).toBe('running')
    expect(db.items.filter(i => i.job_id === full.id).every(i => i.status === 'pending')).toBe(true)
    expect(db.items.filter(i => i.job_id === full.id)).toHaveLength(3)
  })

  it('refuses a sample run without a limit', async () => {
    await expect(createBackfillJob({ admin: fakeDb().admin as any }, { fundId: FUND, mode: 'sample' })).rejects.toThrow(/sample_limit/)
  })
})

describe('backfill processing', () => {
  it('captures each item, recovers the stored period, records per-artifact outcomes, and completes the job', async () => {
    captureMock.mockReset()
    captureMock.mockResolvedValue({ updateId: 'u', extractionStatus: 'partial', artifacts: [{ id: 'a', ordinal: 0, filename: 'deck.pdf', detectedContentType: 'application/pdf', status: 'partial', ocrStatus: 'pending' }] })
    const db = fakeDb({ emails: [email(1), email(2)] })
    const hydrate = vi.fn(async (payload: any) => ({ ...payload, hydrated: true }))
    const job = await createBackfillJob({ admin: db.admin as any, hydrate }, { fundId: FUND, mode: 'full', concurrency: 2 })
    await planBackfillJob({ admin: db.admin as any, hydrate }, job.id)
    const outcome = await runBackfillBatch({ admin: db.admin as any, hydrate }, { jobId: job.id })

    expect(outcome).toMatchObject({ claimed: 2, done: 2, failed: 0, retried: 0 })
    expect(captureMock).toHaveBeenCalledTimes(2)
    expect(captureMock.mock.calls[0][1]).toMatchObject({ fundId: FUND, companyId: COMPANY, payload: expect.objectContaining({ hydrated: true }) })
    expect(db.periodWrites).toHaveLength(2)
    expect(db.periodWrites[0].payload).toMatchObject({ period_label: 'Aug 2026', period_source: 'configured_metric_extraction' })
    expect(outcome.job.status).toBe('completed')
    expect(outcome.job.counts).toMatchObject({ items: { done: 2 }, by_status: { partial: 2 }, by_format: { 'application/pdf': { partial: 2 } }, periods_recovered: 2 })
  })

  it('returns transient failures to the queue and fails permanently after the attempt cap', async () => {
    captureMock.mockReset()
    captureMock.mockRejectedValue(new Error('Could not download e/0_deck.pdf: fetch failed'))
    const db = fakeDb({ emails: [email(1)] })
    const job = await createBackfillJob({ admin: db.admin as any, hydrate: async p => p }, { fundId: FUND, mode: 'full' })
    await planBackfillJob({ admin: db.admin as any }, job.id)

    const first = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id, maxItems: 1 })
    expect(first).toMatchObject({ retried: 1, failed: 0 })
    expect(db.items[0]).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringMatching(/fetch failed/) })
    expect(first.job.status).toBe('running')

    await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id, maxItems: 1 })
    const third = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id, maxItems: 1 })
    expect(third).toMatchObject({ failed: 1 })
    expect(db.items[0]).toMatchObject({ status: 'failed', attempts: 3 })
    expect(third.job.status).toBe('completed')
    expect(third.job.counts).toMatchObject({ items: { failed: 1, retried: 1 } })
  })

  it('a permanent capture error fails the item without retrying and is visible in status', async () => {
    captureMock.mockReset()
    captureMock.mockRejectedValue(new Error('Source email is assigned to company X, not Y'))
    const db = fakeDb({ emails: [email(1)] })
    const job = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'full' })
    await planBackfillJob({ admin: db.admin as any }, job.id)
    const outcome = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id })
    expect(outcome).toMatchObject({ failed: 1, retried: 0 })
    const status = summarize(outcome.job, db.items as any)
    expect(status.recent_errors[0]).toMatchObject({ email_id: E(1), attempts: 1, error: expect.stringMatching(/assigned to company/) })
  })

  it('skips an email that stopped being eligible between planning and processing', async () => {
    captureMock.mockReset()
    const db = fakeDb({ emails: [email(1)] })
    const job = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'full' })
    await planBackfillJob({ admin: db.admin as any }, job.id)
    db.admin.from('inbound_emails') // no-op; mutate the seed directly
    ;(db as any).admin && Object.assign((await db.admin.from('inbound_emails').select().eq('id', E(1)).maybeSingle()).data, { routed_to: 'deals' })
    const outcome = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id })
    expect(outcome.done).toBe(1)
    expect(captureMock).not.toHaveBeenCalled()
    expect(db.items[0]).toMatchObject({ status: 'skipped', result: { reason: 'no longer eligible' } })
  })
})

describe('retryFailedItems', () => {
  it('requeues failed items with a fresh attempt budget and reopens a completed job', async () => {
    captureMock.mockReset()
    captureMock.mockRejectedValue(new Error('function setweight(tsvector, text) does not exist'))
    const db = fakeDb({ emails: [email(1)] })
    const job = await createBackfillJob({ admin: db.admin as any }, { fundId: FUND, mode: 'full' })
    await planBackfillJob({ admin: db.admin as any }, job.id)
    const first = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id })
    expect(first.job.status).toBe('completed')
    expect(db.items[0].status).toBe('failed')

    expect(await retryFailedItems(db.admin as any, { jobId: job.id, fundId: FUND })).toBe(1)
    expect(db.items[0]).toMatchObject({ status: 'pending', attempts: 0, error: null })
    expect(db.jobs[0].status).toBe('running')

    captureMock.mockResolvedValue({ updateId: 'u', extractionStatus: 'complete', artifacts: [] })
    const second = await runBackfillBatch({ admin: db.admin as any, hydrate: async p => p }, { jobId: job.id })
    expect(second).toMatchObject({ done: 1, failed: 0 })
    expect(second.job.status).toBe('completed')
  })
})

describe('recoverReportingPeriod', () => {
  it('uses the stored metric result first, then linked metric values, and never a low-confidence period', async () => {
    const db = fakeDb({ metricValues: [{ fund_id: FUND, source_email_id: E(1), period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, period_month: null }] })
    const fromValues = await recoverReportingPeriod(db.admin as any, { fundId: FUND, emailId: E(1), claudeResponse: { reporting_period: { label: 'x', year: 2026, confidence: 'low' } } })
    expect(fromValues).toMatchObject({ label: 'Q2 2026', quarter: 2, confidence: 'medium' })
    const none = await recoverReportingPeriod(db.admin as any, { fundId: FUND, emailId: E(2), claudeResponse: null })
    expect(none).toBeNull()
    expect(db.periodWrites).toHaveLength(1)
  })
})

describe('isTransient', () => {
  it('classifies network/storage/rate-limit errors as retryable and everything else as permanent', () => {
    expect(isTransient('fetch failed')).toBe(true)
    expect(isTransient('Could not download x: 503')).toBe(true)
    expect(isTransient('Source email is routed to deals')).toBe(false)
  })
})

describe('summarize', () => {
  it('counts items, retries, statuses and formats', () => {
    const job = { id: 'j', fund_id: FUND, counts: {} } as unknown as BackfillJob
    const status = summarize(job, [
      { id: '1', job_id: 'j', fund_id: FUND, email_id: 'a', status: 'done', attempts: 2, error: null, result: { extraction_status: 'complete', period_recovered: true, artifacts: [{ format: 'text/csv', status: 'complete' }] } },
      { id: '2', job_id: 'j', fund_id: FUND, email_id: 'b', status: 'failed', attempts: 3, error: 'boom', result: null },
    ])
    expect(status.items).toMatchObject({ done: 1, failed: 1, retried: 2 })
    expect(status.by_format).toEqual({ 'text/csv': { complete: 1 } })
    expect(status.periods_recovered).toBe(1)
  })
})
