import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ParsingReview, Company, Metric, InboundEmail } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFundReviewType, scopeFundReviews } from '@/lib/portfolio/fof-review-types'
import { hasAccess } from '@/lib/access/effective'

type ReviewRow = Pick<
  ParsingReview,
  'id' | 'issue_type' | 'extracted_value' | 'context_snippet' | 'created_at' | 'payload' | 'vehicle_id'
> & {
  companies: Pick<Company, 'id' | 'name'> | null
  metrics: Pick<Metric, 'id' | 'name' | 'unit' | 'value_type'> | null
  inbound_emails: (Pick<InboundEmail, 'id' | 'subject' | 'received_at' | 'from_address'> & {
    diligence_deal_id: string | null
  }) | null
  fund_vehicles: { id: string; name: string } | null
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only reviews and emails about companies the caller can see.
  const scope = await loadEntityScopeForUser(createAdminClient(), user.id)
  const visible = scope ? scope.companyIds : []

  const { data, error } = await filterByCompany(supabase
    .from('parsing_reviews')
    .select(`
      id, issue_type, extracted_value, context_snippet, created_at, payload, vehicle_id,
      companies ( id, name ),
      metrics ( id, name, unit, value_type ),
      inbound_emails ( id, subject, received_at, from_address, diligence_deal_id ),
      fund_vehicles ( id, name )
    `)
    .is('resolution', null), visible)
    .order('created_at', { ascending: false })

  if (error) return dbError(error, 'review')

  // A fund review is one entity's: RLS already narrows it for the Data API; say the same rule here.
  // And it writes the fund register, the investments feature's: hidden with it.
  const fundReadable = !!scope?.access && hasAccess(scope.access, 'portfolio', 'read', 'investments')
  const rows = scopeFundReviews((data ?? []) as unknown as ReviewRow[], scope?.access ?? { vehicles: { all: false, ids: [] } })
    .filter(r => fundReadable || !isFundReviewType(r.issue_type))

  // The router's diligence match names a record; keep it only when the caller can see that record
  // (read with their own client, so RLS applies the entity rule).
  const dealIds = Array.from(new Set(rows.map(r => r.inbound_emails?.diligence_deal_id).filter(Boolean))) as string[]
  const { data: visibleDeals } = dealIds.length
    ? await (supabase as any).from('diligence_deals').select('id').in('id', dealIds)
    : { data: [] }
  const seenDeals = new Set(((visibleDeals as any[]) ?? []).map(d => d.id as string))
  for (const r of rows) {
    if (r.inbound_emails?.diligence_deal_id && !seenDeals.has(r.inbound_emails.diligence_deal_id)) {
      r.inbound_emails = { ...r.inbound_emails, diligence_deal_id: null }
    }
  }

  const items = rows.map(r => ({
    id: r.id,
    issue_type: r.issue_type,
    extracted_value: r.extracted_value,
    context_snippet: r.context_snippet,
    created_at: r.created_at,
    company: r.companies ?? null,
    metric: r.metrics ?? null,
    email: r.inbound_emails ?? null,
    payload: r.payload ?? null,
    vehicle: r.fund_vehicles ?? null,
  }))

  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.issue_type] = (counts[item.issue_type] ?? 0) + 1
  }

  // Also fetch inbound emails with needs_review status
  const { data: reviewEmails } = await filterByCompany(supabase
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, processing_status, company_id, attachments_count')
    .eq('processing_status', 'needs_review'), visible)
    .order('received_at', { ascending: false })

  // Get company names for those emails
  const emailRows = (reviewEmails ?? []) as unknown as { id: string; from_address: string; subject: string | null; received_at: string; processing_status: string; company_id: string | null; attachments_count: number }[]
  const emailCompanyIds = Array.from(new Set(emailRows.map(e => e.company_id).filter(Boolean))) as string[]
  let companiesById: Record<string, string> = {}
  if (emailCompanyIds.length > 0) {
    const { data: emailCompanies } = await supabase
      .from('companies')
      .select('id, name')
      .in('id', emailCompanyIds)
    companiesById = Object.fromEntries(
      (emailCompanies ?? []).map((c: { id: string; name: string }) => [c.id, c.name])
    )
  }

  const needsReviewEmails = emailRows.map(e => ({
    id: e.id,
    from_address: e.from_address,
    subject: e.subject,
    received_at: e.received_at,
    company: e.company_id ? { id: e.company_id, name: companiesById[e.company_id] ?? 'Unknown' } : null,
  }))

  return NextResponse.json({ total: items.length, counts, items, needsReviewEmails })
}
