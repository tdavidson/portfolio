import { NextRequest, NextResponse } from 'next/server'
import { kickCron } from '@/lib/cron/kick'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess, resolveFund } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { backfillStatus, createBackfillJob, planBackfillJob, type BackfillMode } from '@/lib/company-updates/backfill'

export const maxDuration = 120

/**
 * Operator backfill of the Company Updates projection.
 *
 * POST starts a job (dry_run | sample | full) and PLANS it — enumerating eligible emails into
 * items. It does not extract anything: the cron worker (/api/cron/company-updates-backfill) and
 * the operator script (scripts/backfill-company-updates.ts) process items with bounded
 * concurrency and retries. GET reports durable progress for polling.
 *
 * Starting a job is an admin action: it is a fund-wide reprocessing cost, not a portfolio read.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const limited = await rateLimit({ key: `cu-backfill:${user.id}`, limit: 5, windowSeconds: 600 })
  if (limited) return limited

  const body = await req.json().catch(() => ({})) as {
    mode?: string
    reprocess?: boolean
    sample_company_id?: string | null
    sample_limit?: number | null
    concurrency?: number
  }
  const mode = body.mode as BackfillMode
  if (mode !== 'dry_run' && mode !== 'sample' && mode !== 'full') {
    return NextResponse.json({ error: 'mode must be dry_run, sample or full' }, { status: 400 })
  }
  if (mode === 'sample' && (!Number.isInteger(body.sample_limit) || (body.sample_limit as number) < 1 || (body.sample_limit as number) > 1000)) {
    return NextResponse.json({ error: 'sample_limit must be an integer between 1 and 1000' }, { status: 400 })
  }
  if (body.sample_company_id) {
    const { data: company } = await admin
      .from('companies')
      .select('id')
      .eq('id', body.sample_company_id)
      .eq('fund_id', gate.fundId)
      .eq('holding_type', 'company')
      .maybeSingle()
    if (!company) return NextResponse.json({ error: 'Invalid sample_company_id' }, { status: 400 })
  }

  const { data: active } = await admin
    .from('company_update_backfill_jobs' as any)
    .select('id')
    .eq('fund_id', gate.fundId)
    .in('status', ['pending', 'running'])
    .limit(1)
  if ((active ?? []).length > 0) {
    return NextResponse.json({ error: 'A backfill job is already running for this fund', job_id: (active as any)[0].id }, { status: 409 })
  }

  try {
    const job = await createBackfillJob({ admin: admin as any }, {
      fundId: gate.fundId,
      mode,
      reprocess: body.reprocess === true,
      sampleCompanyId: body.sample_company_id ?? null,
      sampleLimit: body.sample_limit ?? null,
      concurrency: body.concurrency,
      createdBy: user.id,
    })
    const planned = await planBackfillJob({ admin: admin as any }, job.id)
    if (planned.status === 'running') await kickCron('company-updates-backfill')
    return NextResponse.json({ job: planned })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[company-updates/backfill] failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** GET ?job=<id> → that job's status; GET → recent jobs for the fund. Any portfolio reader. */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const fund = await resolveFund(admin, user.id)
  if (fund instanceof NextResponse) return fund

  const jobId = req.nextUrl.searchParams.get('job')
  if (jobId) {
    const status = await backfillStatus(admin as any, { fundId: fund.fundId, jobId })
    if (!status) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(status)
  }

  const { data, error } = await admin
    .from('company_update_backfill_jobs' as any)
    .select('id, mode, status, parser_version, reprocess, sample_company_id, sample_limit, total_eligible, planned, counts, last_error, created_at, started_at, finished_at')
    .eq('fund_id', fund.fundId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) return NextResponse.json({ error: 'Could not list jobs' }, { status: 500 })
  return NextResponse.json({ jobs: data ?? [] })
}
