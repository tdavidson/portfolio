import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runDealResearch } from '@/lib/deals/research'
import { dbError } from '@/lib/api-error'
import { cronAuthDenial } from '@/lib/security/cron-auth'
import { kickCron } from '@/lib/cron/kick'

/**
 * Drains the deal-research queue: inbound deals that cleared the fund's interest
 * bar (see lib/deals/research.ts) and are waiting on external web research.
 *
 * Runs out-of-band from the inbound-email webhook on purpose — a web-search
 * round takes 30-60s and would otherwise risk timing out email processing and
 * marking a good email as failed.
 *
 * Started when a deal is queued (lib/cron/kick.ts), and by the daily tick as a safety net. A full
 * batch starts the next run, so a backlog drains without waiting a day.
 *
 * Auth: same `Authorization: Bearer ${CRON_SECRET}` pattern as the other crons.
 */

export const maxDuration = 300

// Deals researched per tick. Each is a web-search round (billed per search on
// top of tokens), so the batch is small and the cadence does the throughput.
const BATCH_SIZE = 5

// Leave headroom under maxDuration so a slow final call can't get killed
// mid-write and strand a deal in 'running' forever.
const TIME_BUDGET_MS = 240_000

export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const started = Date.now()
  const admin = createAdminClient()

  // Self-heal: a deal stuck in 'running' was claimed by an invocation that died
  // (function killed mid-call). Without this it would never be retried.
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  await (admin as any)
    .from('inbound_deals')
    .update({ research_status: 'pending' })
    .eq('research_status', 'running')
    .lt('researched_at', staleCutoff)

  const { data, error } = await (admin as any)
    .from('inbound_deals')
    .select('id, fund_id, company_name, company_url, company_domain, founder_name, founder_email, industry, stage, company_summary')
    .eq('research_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) return dbError(error, 'cron-deal-research')

  const deals = ((data as any[]) ?? [])
  if (deals.length === 0) return NextResponse.json({ ok: true, researched: 0 })

  let researched = 0
  let failed = 0
  let skipped = 0

  for (const deal of deals) {
    if (Date.now() - started > TIME_BUDGET_MS) break

    // Claim it so a concurrent invocation doesn't research the same deal twice
    // (and double-bill the fund for it).
    const { data: claimed } = await (admin as any)
      .from('inbound_deals')
      .update({ research_status: 'running', researched_at: new Date().toISOString() })
      .eq('id', deal.id)
      .eq('research_status', 'pending')   // lost-update guard
      .select('id')
      .maybeSingle()

    if (!claimed) continue  // another worker got it first

    const result = await runDealResearch(admin, {
      fundId: deal.fund_id,
      dealId: deal.id,
      companyName: deal.company_name,
      companyUrl: deal.company_url,
      companyDomain: deal.company_domain,
      founderName: deal.founder_name,
      founderEmail: deal.founder_email,
      industry: deal.industry,
      stage: deal.stage,
      companySummary: deal.company_summary,
    })

    if (result.status === 'done') researched++
    else if (result.status === 'failed') failed++
    else skipped++
  }

  if (deals.length === BATCH_SIZE && researched + failed + skipped > 0) await kickCron('deal-research')

  return NextResponse.json({ ok: true, researched, failed, skipped })
}
