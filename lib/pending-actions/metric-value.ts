import type { ActionDeps, PreviewResult } from './types'
import { visibleCompanyIds } from '@/lib/access/scope'

export interface MetricValueInput {
  companyId: string
  metricId: string
  period_label: string
  period_year: number
  period_quarter?: number
  period_month?: number
  value: number | string
  notes?: string
}

/**
 * Load the metric and any existing value for the same period. Re-run at both preview and write
 * time, so the writer re-validates against the live state (the stale-preview case): a value that
 * appeared new when staged still updates correctly if someone entered it in the meantime.
 *
 * The same-period lookup mirrors the REST route exactly — PostgREST needs `.is(col, null)` for
 * IS NULL, not `.eq(col, null)`, or a null quarter/month would never match.
 */
async function loadContext(deps: ActionDeps, input: MetricValueInput) {
  // Only a company linked to one of the caller's entities; any other is "not found".
  const visible = await visibleCompanyIds(deps.admin, deps.access)
  if (visible !== null && !visible.includes(input.companyId)) throw new Error('Metric not found in this fund')
  const { data: metric } = await deps.admin
    .from('metrics')
    .select('id, name, value_type, company_id, fund_id')
    .eq('id', input.metricId)
    .eq('company_id', input.companyId)
    .maybeSingle()
  if (!metric || (metric as any).fund_id !== deps.fundId) throw new Error('Metric not found in this fund')

  let q = deps.admin
    .from('metric_values')
    .select('id, value_number, value_text')
    .eq('metric_id', input.metricId)
    .eq('period_year', input.period_year)
  q = input.period_quarter != null ? q.eq('period_quarter', input.period_quarter) : q.is('period_quarter', null)
  q = input.period_month != null ? q.eq('period_month', input.period_month) : q.is('period_month', null)
  const { data: existing } = await q.maybeSingle()

  return { metric: metric as any, existing: existing as any }
}

export async function previewMetricValue(deps: ActionDeps, input: MetricValueInput): Promise<PreviewResult> {
  const { metric, existing } = await loadContext(deps, input)
  const isText = metric.value_type === 'text'
  const from = existing ? (isText ? existing.value_text : existing.value_number) : null
  return {
    summary: `${existing ? 'Update' : 'Set'} ${metric.name} for ${input.period_label} to ${input.value}`,
    details: {
      metric: metric.name,
      period: input.period_label,
      mode: existing ? 'update' : 'insert',
      from,
      to: input.value,
    },
  }
}

export async function writeMetricValue(
  deps: ActionDeps,
  input: MetricValueInput,
): Promise<{ metricValueId: string; mode: 'insert' | 'update' }> {
  const { metric, existing } = await loadContext(deps, input)
  const valueFields =
    metric.value_type === 'text'
      ? { value_text: String(input.value) }
      : { value_number: typeof input.value === 'number' ? input.value : parseFloat(String(input.value)) }

  if (existing) {
    const { data, error } = await deps.admin
      .from('metric_values')
      .update({
        period_label: input.period_label,
        confidence: 'high',
        is_manually_entered: true,
        notes: input.notes ?? null,
        ...valueFields,
      })
      .eq('id', existing.id)
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    return { metricValueId: (data as any).id, mode: 'update' }
  }

  const { data, error } = await deps.admin
    .from('metric_values')
    .insert({
      metric_id: input.metricId,
      company_id: input.companyId,
      fund_id: deps.fundId,
      period_label: input.period_label,
      period_year: input.period_year,
      period_quarter: input.period_quarter ?? null,
      period_month: input.period_month ?? null,
      confidence: 'high',
      is_manually_entered: true,
      notes: input.notes ?? null,
      ...valueFields,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return { metricValueId: (data as any).id, mode: 'insert' }
}
