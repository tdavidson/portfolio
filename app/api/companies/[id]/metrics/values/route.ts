import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { dbError } from '@/lib/api-error'
import { dedupeMetricValues } from '@/lib/metric-values'
import type { MetricValue } from '@/lib/types/database'

/** Chart histories in one request. The proxy gates portfolio/entity access and both reads use RLS. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: company, error: companyError } = await client.from('companies')
    .select('id, fund_id').eq('id', id).eq('holding_type', 'company').returns<{ id: string; fund_id: string }[]>().maybeSingle()
  if (companyError) return dbError(companyError, 'company-chart-values')
  if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Limit per series, matching the existing history endpoint's default row cap. Never apply a
  // global limit across all series: one long history would crowd the other metrics out.
  const { data, error } = await client.from('metrics')
    .select('id, values:metric_values(*, inbound_emails(id, subject, received_at))')
    .eq('company_id', id).eq('fund_id', company.fund_id).eq('is_active', true)
    .eq('values.company_id', id).eq('values.fund_id', company.fund_id)
    .order('period_year', { referencedTable: 'values' })
    .order('period_quarter', { referencedTable: 'values', nullsFirst: false })
    .order('period_month', { referencedTable: 'values', nullsFirst: false })
    .limit(1000, { referencedTable: 'values' })
    .returns<{ id: string; values: MetricValue[] }[]>()
  if (error) return dbError(error, 'company-chart-values')
  return NextResponse.json(Object.fromEntries((data ?? []).map(m => [m.id, dedupeMetricValues(m.values)])))
}
