import { dedupeMetricValues } from '@/lib/metric-values'
import type { MetricValue } from '@/lib/types/database'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { writeMetricValue } from '@/lib/pending-actions/metric-value'
import type { AccessContext } from '@/lib/access/effective'

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string; metricId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('metric_values')
    .select('*, inbound_emails(id, subject, received_at)')
    .eq('metric_id', params.metricId)
    .eq('company_id', params.id)
    .order('period_year')
    .order('period_quarter', { nullsFirst: false })
    .order('period_month', { nullsFirst: false })

  if (error) return dbError(error, 'metric-values')

  return NextResponse.json(dedupeMetricValues((data ?? []) as unknown as MetricValue[]))
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string; metricId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { period_label, period_year, period_quarter, period_month, value, notes } = body

  if (!period_label || !period_year) {
    return NextResponse.json({ error: 'period_label and period_year are required' }, { status: 400 })
  }

  // Single write path — shared with the Analyst's pending-action layer, which stages this same
  // call for human approval. `writeMetricValue` re-checks the metric belongs to the caller's fund.
  try {
    const result = await writeMetricValue(
      { admin, fundId: writeCheck.fundId, userId: user.id, access: {} as unknown as AccessContext },
      { companyId: params.id, metricId: params.metricId, period_label, period_year, period_quarter, period_month, value, notes },
    )
    return NextResponse.json(result, { status: result.mode === 'insert' ? 201 : 200 })
  } catch (e) {
    const message = (e as Error).message
    if (/not found/i.test(message)) return NextResponse.json({ error: message }, { status: 404 })
    return dbError({ message }, 'metric-values')
  }
}
