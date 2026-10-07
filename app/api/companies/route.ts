import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { seedCompanyFromDefaults } from '@/lib/metrics/seed-default-metrics'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows, scopeGroups, scopeTransactions, newCompanyGroupsProblem } from '@/lib/access/scope'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  type CompanyRow = {
    id: string; name: string; stage: string | null; status: string
    industry: string[] | null; aliases: string[] | null; tags: string[]
    portfolio_group: string[] | null; contact_email: string[] | null
    metrics: { id: string }[]; inbound_emails: { received_at: string }[]
  }

  const { data, error } = await admin
    .from('companies')
    .select('id, name, stage, status, industry, aliases, tags, portfolio_group, contact_email, metrics(id), inbound_emails(received_at)')
    .eq('fund_id', membership.fund_id)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
    .order('name') as { data: CompanyRow[] | null; error: { message: string } | null }

  if (error) return dbError(error, 'companies')

  // Only companies linked to the caller's entities, naming only those entities.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const visible = scopeCompanyRows(data ?? [], (scope ? scope.companyIds : []))

  const companies = visible.map(c => {
    const emails = c.inbound_emails ?? []
    const lastReportAt = emails.length > 0
      ? emails.reduce((max, e) => e.received_at > max ? e.received_at : max, emails[0].received_at)
      : null
    return {
      id: c.id,
      name: c.name,
      stage: c.stage,
      status: c.status,
      industry: c.industry,
      aliases: c.aliases,
      tags: c.tags ?? [],
      portfolioGroup: scopeGroups(c.portfolio_group, (scope ? scope.vehicleNames : [])),
      contactEmail: c.contact_email,
      metricsCount: c.metrics?.length ?? 0,
      lastReportAt,
    }
  })

  return NextResponse.json(companies)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { name, aliases, tags, stage, industry, notes, overview, founders, why_invested, current_update, contact_email, portfolio_group } = body
  // Metric choices made in the Add-company modal, before the company existed. Both optional:
  // omit `default_metric_ids` and every active default seeds, as it always has.
  const defaultMetricIds: string[] | undefined = Array.isArray(body.default_metric_ids)
    ? body.default_metric_ids.filter((v: unknown): v is string => typeof v === 'string')
    : undefined
  const customMetrics: CustomMetricInput[] = Array.isArray(body.custom_metrics) ? body.custom_metrics : []

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'No fund found for this user' }, { status: 403 })
  }

  // A member creates a company only in their own entities, and must name one (an unlinked company is
  // admin-only). Checked before ensureVehiclesByName, which would create an entity they cannot see.
  const createScope = await loadEntityScopeForUser(admin, user.id)
  const groupProblem = newCompanyGroupsProblem(createScope ? createScope.vehicleNames : [], portfolio_group)
  if (groupProblem) return NextResponse.json({ error: groupProblem }, { status: 403 })

  // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
  // disconnected string. Resolve/create before the write, not after.
  await ensureVehiclesByName(admin, membership.fund_id, portfolio_group ?? [])

  const { data, error } = await admin
    .from('companies')
    .insert({
      fund_id: membership.fund_id,
      name: name.trim(),
      aliases: aliases ?? null,
      tags: tags ?? [],
      stage: stage?.trim() || null,
      industry: industry ?? null,
      notes: notes?.trim() || null,
      overview: overview?.trim() || null,
      founders: founders?.trim() || null,
      why_invested: why_invested?.trim() || null,
      current_update: current_update?.trim() || null,
      contact_email: contact_email ?? null,
      portfolio_group: portfolio_group ?? null,
      status: 'active',
      // A holding is a company unless it is explicitly a fund. Anything but 'fund' falls
      // back to 'company' so an unexpected value cannot create an unreachable holding.
      holding_type: body?.holding_type === 'fund' ? 'fund' : 'company',
    })
    .select()
    .single()

  if (error) return dbError(error, 'companies')

  // Seed the fund's default metric profile into the new company (deduped by slug; no-op if
  // the fund has no defaults configured). If the modal sent an explicit selection, seed only
  // those and record the rest as exclusions, so a later fund-wide apply doesn't re-add them.
  await seedCompanyFromDefaults(admin, membership.fund_id, data.id, defaultMetricIds)
  if (defaultMetricIds) {
    await recordDefaultMetricExclusions(admin, membership.fund_id, data.id, defaultMetricIds)
  }
  if (customMetrics.length > 0) {
    await insertCustomMetrics(admin, membership.fund_id, data.id, customMetrics)
  }

  logActivity(admin, membership.fund_id, user.id, 'company.create', { companyName: name.trim() })

  return NextResponse.json(data, { status: 201 })
}

interface CustomMetricInput {
  name?: string
  slug?: string
  unit?: string
  unit_position?: string
  value_type?: string
  reporting_cadence?: string
  currency?: string
}

type MetricInsert = {
  company_id: string
  fund_id: string
  name: string
  slug: string
  unit: string | null
  unit_position: string
  value_type: string
  reporting_cadence: string
  display_order: number
  currency: string | null
  is_active: boolean
}

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * A default the operator unchecked at create time is an opt-out, not a "not yet" — record it so
 * Settings → Default metrics → apply to all doesn't quietly put it back. Best-effort: a failure
 * here leaves the company correct, only the future apply less precise.
 */
async function recordDefaultMetricExclusions(
  admin: ReturnType<typeof createAdminClient>,
  fundId: string,
  companyId: string,
  keptIds: string[]
) {
  // `as any`: default_metrics / default_metric_exclusions aren't in the generated DB types yet —
  // same escape hatch the /api/default-metrics routes use.
  const { data: actives } = await (admin as any)
    .from('default_metrics')
    .select('id')
    .eq('fund_id', fundId)
    .eq('is_active', true)

  const kept = new Set(keptIds)
  const rows = ((actives ?? []) as { id: string }[])
    .filter(d => !kept.has(d.id))
    .map(d => ({ fund_id: fundId, company_id: companyId, default_metric_id: d.id }))

  if (rows.length === 0) return
  const { error } = await (admin as any)
    .from('default_metric_exclusions')
    .upsert(rows, { onConflict: 'company_id,default_metric_id' })
  if (error) console.error('[companies.POST] exclusion insert failed:', error.message)
}

/** One-off metrics typed straight into the Add-company modal, on top of the fund defaults. */
async function insertCustomMetrics(
  admin: ReturnType<typeof createAdminClient>,
  fundId: string,
  companyId: string,
  inputs: CustomMetricInput[]
) {
  const { data: existing } = await admin.from('metrics').select('slug').eq('company_id', companyId)
  const taken = new Set(((existing ?? []) as { slug: string }[]).map(m => m.slug))

  const rows: MetricInsert[] = []
  inputs.forEach((m, i) => {
    const metricName = (m.name ?? '').trim()
    if (!metricName) return
    const slug = (m.slug ?? '').trim() || toSlug(metricName)
    if (!slug || taken.has(slug)) return
    taken.add(slug)
    rows.push({
      company_id: companyId,
      fund_id: fundId,
      name: metricName,
      slug,
      unit: (m.unit ?? '').trim() || null,
      unit_position: m.unit_position ?? 'suffix',
      value_type: m.value_type ?? 'number',
      reporting_cadence: m.reporting_cadence ?? 'quarterly',
      display_order: 100 + i,
      currency: (m.currency ?? '').trim() || null,
      is_active: true,
    })
  })

  if (rows.length === 0) return
  const { error } = await admin.from('metrics').insert(rows)
  if (error) console.error('[companies.POST] custom metric insert failed:', error.message)
}
