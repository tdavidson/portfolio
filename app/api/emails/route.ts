import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { InboundEmail, Company } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 1000
const STALE_PROCESSING_MINUTES = 10

type EmailListRow = Pick<
  InboundEmail,
  'id' | 'from_address' | 'subject' | 'received_at' | 'processing_status' | 'metrics_extracted' | 'company_id'
> & { companies: Pick<Company, 'id' | 'name'> | null }

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Scope stale-email cleanup to the user's fund
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (membership) {
    const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString()
    await admin
      .from('inbound_emails')
      .update({ processing_status: 'failed', processing_error: 'Processing timed out. This can happen if the AI provider is slow or file storage is unreachable. Try reprocessing.' })
      .eq('processing_status', 'processing')
      .eq('fund_id', membership.fund_id)
      .lt('received_at', staleCutoff)
  }

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')
  const companyId = sp.get('company_id')
  const dateFrom = sp.get('date_from')
  const dateTo = sp.get('date_to')
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(sp.get('page_size') ?? String(DEFAULT_PAGE_SIZE), 10)))

  let query = supabase
    .from('inbound_emails')
    .select(
      'id, from_address, subject, received_at, processing_status, metrics_extracted, company_id, companies(id, name)',
      { count: 'exact' }
    )
    .order('received_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  // Only emails about companies the caller can see; unmatched ones are for admins to triage.
  const scope = await loadEntityScopeForUser(admin, user.id)
  query = filterByCompany(query, scope ? scope.companyIds : [])
  if (status) query = query.eq('processing_status', status)
  if (companyId) query = query.eq('company_id', companyId)
  if (dateFrom) query = query.gte('received_at', dateFrom)
  if (dateTo) query = query.lte('received_at', dateTo)

  const { data, error, count } = await query
  if (error) return dbError(error, 'emails')

  const rows = (data ?? []) as unknown as EmailListRow[]

  // For needs_review emails with a company, check if that company has metrics
  const needsReviewCompanyIds = Array.from(new Set(
    rows
      .filter(e => e.processing_status === 'needs_review' && e.company_id)
      .map(e => e.company_id as string)
  ))

  const companyMetricCounts = new Map<string, number>()
  if (needsReviewCompanyIds.length > 0) {
    const { data: metricRows } = await supabase
      .from('metrics')
      .select('company_id')
      .in('company_id', needsReviewCompanyIds)
      .eq('is_active', true)

    for (const m of (metricRows ?? []) as unknown as { company_id: string }[]) {
      companyMetricCounts.set(m.company_id, (companyMetricCounts.get(m.company_id) ?? 0) + 1)
    }
  }

  const items = rows.map(e => ({
    id: e.id,
    from_address: e.from_address,
    subject: e.subject,
    received_at: e.received_at,
    processing_status: e.processing_status,
    metrics_extracted: e.metrics_extracted,
    company: e.companies ?? null,
    company_metrics_count: e.company_id ? (companyMetricCounts.get(e.company_id) ?? 0) : 0,
  }))

  return NextResponse.json({
    total: count ?? 0,
    page,
    page_size: pageSize,
    items,
  })
}
