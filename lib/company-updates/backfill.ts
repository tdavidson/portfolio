/**
 * Resumable operator backfill of the Company Updates projection.
 *
 * A job selects eligible reporting emails (effective route reporting + company assigned) with
 * keyset pagination, records one item per email, and workers claim items with SKIP LOCKED so a
 * cron tick and an operator script can share the work. Transient failures return to the queue
 * (bounded attempts); permanent partial/failed extraction results are stored on the artifact for
 * inspection, which is a SUCCESSFUL item. Reporting periods are recovered from the stored metric
 * result without any model call. Progress and counts live on the job row.
 */
import { captureCompanyUpdate, effectiveRoute, loadStoredInboundEmail, updateCompanyUpdatePeriod, type SupabaseAdmin } from './capture'
import { CAPTURE_VERSION } from './extraction'
import type { PostmarkPayload } from '@/lib/pipeline/processEmail'
import type { ReportingPeriod } from '@/lib/claude/extractMetrics'

export type BackfillMode = 'dry_run' | 'sample' | 'full'
export const BACKFILL_MAX_ATTEMPTS = 3

export interface BackfillJob {
  id: string
  fund_id: string
  mode: BackfillMode
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  parser_version: string
  reprocess: boolean
  sample_company_id: string | null
  sample_limit: number | null
  concurrency: number
  total_eligible: number
  planned: number
  counts: Record<string, unknown>
  plan_cursor: Record<string, unknown> | null
  last_error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

export interface BackfillItem {
  id: string
  job_id: string
  fund_id: string
  email_id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number
  error: string | null
  result: Record<string, unknown> | null
}

export interface BackfillDeps {
  admin: SupabaseAdmin
  /** Download attachment bytes for a stored payload; defaults to the storage-backed hydrator. */
  hydrate?: (payload: PostmarkPayload) => Promise<PostmarkPayload>
  now?: () => Date
}

interface EligibleEmail {
  id: string
  company_id: string
  received_at: string
  routed_to: string | null
  /** `raw_payload->Attachments` only — planning never loads bodies, which is what timed it out. */
  attachments: PostmarkPayload['Attachments'] | null
}


const PLAN_PAGE = 100

// ─── Job creation and planning ────────────────────────────────────────────────────────────────

export async function createBackfillJob(
  deps: BackfillDeps,
  params: {
    fundId: string
    mode: BackfillMode
    reprocess?: boolean
    sampleCompanyId?: string | null
    sampleLimit?: number | null
    concurrency?: number
    createdBy?: string | null
  },
): Promise<BackfillJob> {
  if (params.mode === 'sample' && !params.sampleLimit) {
    throw new Error('A sample run needs sample_limit (1-1000).')
  }
  const { data, error } = await deps.admin
    .from('company_update_backfill_jobs')
    .insert({
      fund_id: params.fundId,
      mode: params.mode,
      parser_version: CAPTURE_VERSION,
      reprocess: params.reprocess ?? false,
      sample_company_id: params.sampleCompanyId ?? null,
      sample_limit: params.mode === 'sample' ? params.sampleLimit : null,
      concurrency: Math.min(Math.max(params.concurrency ?? 3, 1), 10),
      created_by: params.createdBy ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`Could not create backfill job: ${error.message}`)
  return data as BackfillJob
}

/**
 * Enumerate eligible emails (keyset, resumable via plan_cursor) into items. A dry run records
 * what WOULD be processed — counts by format and by current capture state — and completes.
 */
export async function planBackfillJob(deps: BackfillDeps, jobId: string): Promise<BackfillJob> {
  const job = await loadJob(deps.admin, jobId)
  if (job.status !== 'pending' && job.status !== 'running') return job
  const nowIso = () => (deps.now?.() ?? new Date()).toISOString()
  await patchJob(deps.admin, job, { status: 'running', started_at: job.started_at ?? nowIso() })

  const captured = await capturedVersions(deps.admin, job.fund_id)
  const counts = {
    eligible: 0,
    already_current: 0,
    stale_version: 0,
    never_captured: 0,
    would_process: 0,
    attachments: 0,
    attachments_by_declared_type: {} as Record<string, number>,
    ...(job.counts as Record<string, unknown>),
  }
  let cursor = job.plan_cursor as { received_at: string; id: string } | null
  let planned = job.planned
  let remaining = job.mode === 'sample' ? Math.max((job.sample_limit ?? 0) - planned, 0) : Number.POSITIVE_INFINITY

  while (remaining > 0) {
    const page = await eligiblePage(deps.admin, job, cursor, Math.min(PLAN_PAGE, remaining))
    if (page.length === 0) break
    const rows: Array<{ job_id: string; fund_id: string; email_id: string; status: string; result: unknown }> = []
    for (const email of page) {
      counts.eligible++
      const state = captured.get(email.id)
      const attachments = Array.isArray(email.attachments) ? email.attachments : []
      counts.attachments += attachments.length
      for (const attachment of attachments) {
        const type = (attachment.ContentType || 'unknown').split(';')[0].trim().toLowerCase()
        counts.attachments_by_declared_type[type] = (counts.attachments_by_declared_type[type] ?? 0) + 1
      }
      if (!state) counts.never_captured++
      else if (state === job.parser_version) counts.already_current++
      else counts.stale_version++
      const skip = state === job.parser_version && !job.reprocess
      if (!skip) counts.would_process++
      rows.push({
        job_id: job.id,
        fund_id: job.fund_id,
        email_id: email.id,
        status: skip ? 'skipped' : 'pending',
        result: skip ? { reason: 'already captured at this parser version' } : null,
      })
    }
    if (job.mode !== 'dry_run') {
      const { error } = await deps.admin
        .from('company_update_backfill_items')
        .upsert(rows, { onConflict: 'job_id,email_id', ignoreDuplicates: true })
      if (error) throw new Error(`Could not plan backfill items: ${error.message}`)
    }
    planned += rows.length
    remaining -= rows.length
    const last = page[page.length - 1]
    cursor = { received_at: last.received_at, id: last.id }
    await patchJob(deps.admin, job, { planned, total_eligible: counts.eligible, counts, plan_cursor: cursor })
    if (page.length < Math.min(PLAN_PAGE, remaining + page.length)) break
  }

  const finished = job.mode === 'dry_run' || planned === 0
  return patchJob(deps.admin, job, {
    planned,
    total_eligible: counts.eligible,
    counts,
    plan_cursor: cursor,
    ...(finished ? { status: 'completed', finished_at: nowIso() } : {}),
  })
}

// ─── Processing ───────────────────────────────────────────────────────────────────────────────

export interface BatchOutcome {
  claimed: number
  done: number
  failed: number
  retried: number
  job: BackfillJob
}

/**
 * Claim up to `maxItems` pending items and process them with the job's concurrency. Stops early
 * when `timeBudgetMs` elapses so a serverless worker can hand the rest to the next tick.
 */
export async function runBackfillBatch(
  deps: BackfillDeps,
  params: { jobId: string; maxItems?: number; timeBudgetMs?: number },
): Promise<BatchOutcome> {
  const job = await loadJob(deps.admin, params.jobId)
  if (job.status !== 'running') return { claimed: 0, done: 0, failed: 0, retried: 0, job }
  const started = Date.now()
  const outcome = { claimed: 0, done: 0, failed: 0, retried: 0 }
  const maxItems = Math.min(Math.max(params.maxItems ?? 25, 1), 100)
  const budget = params.timeBudgetMs ?? 60_000

  while (outcome.claimed < maxItems && Date.now() - started < budget) {
    const { data, error } = await deps.admin.rpc('company_update_backfill_claim', {
      p_job_id: job.id,
      p_limit: Math.min(job.concurrency, maxItems - outcome.claimed),
    })
    if (error) throw new Error(`Could not claim backfill items: ${error.message}`)
    const items = (data ?? []) as BackfillItem[]
    if (items.length === 0) break
    outcome.claimed += items.length
    await Promise.all(items.map(async item => {
      const result = await processItem(deps, job, item)
      outcome[result]++
    }))
  }

  const refreshed = await finalizeIfDrained(deps, job)
  return { ...outcome, job: refreshed }
}

async function processItem(deps: BackfillDeps, job: BackfillJob, item: BackfillItem): Promise<'done' | 'failed' | 'retried'> {
  const nowIso = () => (deps.now?.() ?? new Date()).toISOString()
  try {
    // Same loader capture uses, including the descriptor-only fallback for rows too large to serve.
    const email = await loadStoredInboundEmail(deps.admin, { emailId: item.email_id, fundId: job.fund_id })
    const { data: extra } = await deps.admin
      .from('inbound_emails')
      .select('claude_response')
      .eq('id', item.email_id)
      .eq('fund_id', job.fund_id)
      .maybeSingle()
    const claudeResponse = (extra as { claude_response?: unknown } | null)?.claude_response ?? null
    if (!email.company_id || effectiveRoute(email.routed_to) !== 'reporting') {
      await patchItem(deps.admin, item, { status: 'skipped', finished_at: nowIso(), result: { reason: 'no longer eligible' } })
      return 'done'
    }
    if (!email.raw_payload) {
      await patchItem(deps.admin, item, { status: 'failed', finished_at: nowIso(), error: 'No stored payload' })
      return 'failed'
    }

    const hydrated = await (deps.hydrate ?? defaultHydrate)(email.raw_payload)
    const capture = await captureCompanyUpdate(deps.admin, {
      emailId: email.id,
      fundId: job.fund_id,
      companyId: email.company_id,
      payload: hydrated,
    })
    if (!capture) {
      await patchItem(deps.admin, item, { status: 'skipped', finished_at: nowIso(), result: { reason: 'route changed during processing' } })
      return 'done'
    }
    const period = await recoverReportingPeriod(deps.admin, { fundId: job.fund_id, emailId: email.id, claudeResponse })
    const result = {
      update_id: capture.updateId,
      extraction_status: capture.extractionStatus,
      period_recovered: period !== null,
      period_label: period?.label ?? null,
      artifacts: capture.artifacts.map(artifact => ({
        id: artifact.id,
        filename: artifact.filename,
        format: artifact.detectedContentType ?? 'unknown',
        status: artifact.status,
        ocr: artifact.ocrStatus,
      })),
    }
    await patchItem(deps.admin, item, { status: 'done', finished_at: nowIso(), error: null, result })
    return 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const transient = isTransient(message) && item.attempts < BACKFILL_MAX_ATTEMPTS
    await patchItem(deps.admin, item, {
      status: transient ? 'pending' : 'failed',
      error: message,
      ...(transient ? {} : { finished_at: nowIso() }),
    })
    return transient ? 'retried' : 'failed'
  }
}

/** Transient = worth another attempt without an operator looking: network, storage, rate limits. */
export function isTransient(message: string): boolean {
  return /timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|rate limit|429|502|503|504|Could not download|deadlock|could not serialize|lock/i.test(message)
}

/**
 * Recover a reporting period from evidence the pipeline already stored — the raw metric result
 * on the email, or metric values linked to it — never from a new model call.
 */
export async function recoverReportingPeriod(
  admin: SupabaseAdmin,
  params: { fundId: string; emailId: string; claudeResponse: unknown },
): Promise<ReportingPeriod | null> {
  const stored = (params.claudeResponse as { reporting_period?: Partial<ReportingPeriod> } | null)?.reporting_period
  let period: ReportingPeriod | null = null
  if (stored && typeof stored.label === 'string' && typeof stored.year === 'number' && stored.confidence !== 'low') {
    period = {
      label: stored.label,
      year: stored.year,
      quarter: stored.quarter ?? null,
      month: stored.month ?? null,
      confidence: stored.confidence === 'high' ? 'high' : 'medium',
    }
  }
  if (!period) {
    const { data } = await admin
      .from('metric_values')
      .select('period_label, period_year, period_quarter, period_month')
      .eq('fund_id', params.fundId)
      .eq('source_email_id', params.emailId)
      .limit(1)
      .maybeSingle()
    const row = data as { period_label: string; period_year: number; period_quarter: number | null; period_month: number | null } | null
    if (row?.period_label && typeof row.period_year === 'number') {
      period = { label: row.period_label, year: row.period_year, quarter: row.period_quarter ?? null, month: row.period_month ?? null, confidence: 'medium' }
    }
  }
  if (!period) return null
  await updateCompanyUpdatePeriod(admin, { emailId: params.emailId, fundId: params.fundId, period })
  return period
}

/**
 * Put a job's permanently failed items back in the queue (after a fix), resetting attempts so the
 * retry cap applies afresh, and reopen the job if it had drained.
 */
export async function retryFailedItems(admin: SupabaseAdmin, params: { jobId: string; fundId: string }): Promise<number> {
  const { data, error } = await admin
    .from('company_update_backfill_items')
    .update({ status: 'pending', attempts: 0, error: null, finished_at: null, claimed_at: null })
    .eq('job_id', params.jobId)
    .eq('fund_id', params.fundId)
    .eq('status', 'failed')
    .select('id')
  if (error) throw new Error(`Could not requeue failed items: ${error.message}`)
  const count = ((data ?? []) as unknown[]).length
  if (count > 0) {
    const { error: jobError } = await admin
      .from('company_update_backfill_jobs')
      .update({ status: 'running', finished_at: null, last_error: null, updated_at: new Date().toISOString() })
      .eq('id', params.jobId)
      .eq('fund_id', params.fundId)
    if (jobError) throw new Error(`Could not reopen backfill job: ${jobError.message}`)
  }
  return count
}

// ─── Status ───────────────────────────────────────────────────────────────────────────────────

export interface BackfillStatus {
  job: BackfillJob
  items: { pending: number; running: number; done: number; failed: number; skipped: number; retried: number }
  by_format: Record<string, Record<string, number>>
  by_status: Record<string, number>
  periods_recovered: number
  recent_errors: Array<{ email_id: string; error: string; attempts: number }>
}

export async function backfillStatus(admin: SupabaseAdmin, params: { fundId: string; jobId: string }): Promise<BackfillStatus | null> {
  const { data: jobRow } = await admin
    .from('company_update_backfill_jobs')
    .select('*')
    .eq('id', params.jobId)
    .eq('fund_id', params.fundId)
    .maybeSingle()
  if (!jobRow) return null
  const job = jobRow as BackfillJob
  const { data: itemRows, error } = await admin
    .from('company_update_backfill_items')
    .select('email_id, status, attempts, error, result')
    .eq('job_id', job.id)
    .eq('fund_id', params.fundId)
  if (error) throw new Error(`Could not load backfill items: ${error.message}`)
  return summarize(job, (itemRows ?? []) as BackfillItem[])
}

export function summarize(job: BackfillJob, items: BackfillItem[]): BackfillStatus {
  const status: BackfillStatus = {
    job,
    items: { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, retried: 0 },
    by_format: {},
    by_status: {},
    periods_recovered: 0,
    recent_errors: [],
  }
  for (const item of items) {
    status.items[item.status]++
    if (item.attempts > 1) status.items.retried++
    const result = item.result as { extraction_status?: string; period_recovered?: boolean; artifacts?: Array<{ format: string; status: string }> } | null
    if (item.status === 'done' && result?.extraction_status) {
      status.by_status[result.extraction_status] = (status.by_status[result.extraction_status] ?? 0) + 1
      if (result.period_recovered) status.periods_recovered++
      for (const artifact of result.artifacts ?? []) {
        const bucket = (status.by_format[artifact.format] ??= {})
        bucket[artifact.status] = (bucket[artifact.status] ?? 0) + 1
      }
    }
    if (item.error && status.recent_errors.length < 20) {
      status.recent_errors.push({ email_id: item.email_id, error: item.error, attempts: item.attempts })
    }
  }
  return status
}

// ─── internals ────────────────────────────────────────────────────────────────────────────────

async function eligiblePage(
  admin: SupabaseAdmin,
  job: BackfillJob,
  cursor: { received_at: string; id: string } | null,
  limit: number,
): Promise<EligibleEmail[]> {
  // The raw payloads are large — `Attachments` carries the files themselves — so reading them
  // here timed out the statement even ten emails at a time. Planning only counted attachments for
  // the dry-run summary; it no longer reads them (each email's capture reads its own payload).
  let query = admin
    .from('inbound_emails')
    .select('id, company_id, received_at, routed_to')
    .eq('fund_id', job.fund_id)
    .not('company_id', 'is', null)
    .or('routed_to.eq.reporting,routed_to.is.null')
    .order('received_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (job.sample_company_id) query = query.eq('company_id', job.sample_company_id)
  if (cursor) query = query.or(`received_at.gt.${cursor.received_at},and(received_at.eq.${cursor.received_at},id.gt.${cursor.id})`)
  const { data, error } = await query
  if (error) throw new Error(`Could not enumerate eligible emails: ${error.message}`)
  return ((data ?? []) as EligibleEmail[]).map(email => ({ ...email, attachments: null }))
}

async function capturedVersions(admin: SupabaseAdmin, fundId: string): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  const pageSize = 1000
  let from = 0
  for (;;) {
    const { data, error } = await admin
      .from('company_updates')
      .select('source_email_id, parser_version')
      .eq('fund_id', fundId)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Could not read captured updates: ${error.message}`)
    const rows = (data ?? []) as Array<{ source_email_id: string; parser_version: string | null }>
    for (const row of rows) map.set(row.source_email_id, row.parser_version)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return map
}

async function loadJob(admin: SupabaseAdmin, jobId: string): Promise<BackfillJob> {
  const { data, error } = await admin.from('company_update_backfill_jobs').select('*').eq('id', jobId).maybeSingle()
  if (error) throw new Error(`Could not load backfill job: ${error.message}`)
  if (!data) throw new Error(`Backfill job ${jobId} not found`)
  return data as BackfillJob
}

async function patchJob(admin: SupabaseAdmin, job: BackfillJob, patch: Partial<BackfillJob>): Promise<BackfillJob> {
  const { data, error } = await admin
    .from('company_update_backfill_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('fund_id', job.fund_id)
    .select('*')
    .single()
  if (error) throw new Error(`Could not update backfill job: ${error.message}`)
  Object.assign(job, data)
  return job
}

async function patchItem(admin: SupabaseAdmin, item: BackfillItem, patch: Partial<BackfillItem> & { finished_at?: string }): Promise<void> {
  const { error } = await admin
    .from('company_update_backfill_items')
    .update(patch)
    .eq('id', item.id)
    .eq('fund_id', item.fund_id)
  if (error) throw new Error(`Could not update backfill item: ${error.message}`)
}

async function finalizeIfDrained(deps: BackfillDeps, job: BackfillJob): Promise<BackfillJob> {
  const { count, error } = await deps.admin
    .from('company_update_backfill_items')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('fund_id', job.fund_id)
    .in('status', ['pending', 'running'])
  if (error) throw new Error(`Could not check backfill progress: ${error.message}`)
  const { data: itemRows } = await deps.admin
    .from('company_update_backfill_items')
    .select('email_id, status, attempts, error, result')
    .eq('job_id', job.id)
    .eq('fund_id', job.fund_id)
  const summary = summarize(job, (itemRows ?? []) as BackfillItem[])
  const counts = {
    ...(job.counts as Record<string, unknown>),
    items: summary.items,
    by_status: summary.by_status,
    by_format: summary.by_format,
    periods_recovered: summary.periods_recovered,
  }
  const drained = (count ?? 0) === 0
  return patchJob(deps.admin, job, {
    counts,
    ...(drained ? { status: 'completed', finished_at: (deps.now?.() ?? new Date()).toISOString() } : {}),
  })
}

async function defaultHydrate(payload: PostmarkPayload): Promise<PostmarkPayload> {
  const { hydrateAttachments } = await import('@/lib/parsing/extractAttachmentText')
  return (await hydrateAttachments(payload as any)) as PostmarkPayload
}
