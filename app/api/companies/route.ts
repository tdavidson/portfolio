import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { createCompany } from '@/lib/companies/create'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { scopeCompanyRows, scopeGroups, scopeTransactions } from '@/lib/access/scope'

export async function GET(req: NextRequest) {
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
    portfolio_group: string[] | null; contact_email: string[] | null; holding_type: string | null
    metrics: { id: string }[]; inbound_emails: { received_at: string }[]
  }

  // Fund holdings and digital assets have their own surfaces, so the list is companies only.
  // `?holdings=all` (the Jump to palette) lists every holding: each opens on /companies/[id].
  const allHoldings = req.nextUrl.searchParams.get('holdings') === 'all'
  let query = admin
    .from('companies')
    .select('id, name, stage, status, industry, aliases, tags, portfolio_group, contact_email, holding_type, metrics(id), inbound_emails(received_at)')
    .eq('fund_id', membership.fund_id)
  if (!allHoldings) query = query.eq('holding_type', 'company')
  const { data, error } = await query.order('name') as { data: CompanyRow[] | null; error: { message: string } | null }

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
      holdingType: c.holding_type ?? 'company',
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

  // A holding is a company unless it says otherwise. A fund holding is created with its terms
  // (POST /api/portfolio/fund-holdings); a digital asset is created here and configured on its own
  // page (wallets, price feed). Anything unrecognised is a company, so an unexpected value cannot
  // create an unreachable holding.
  const holdingType: 'company' | 'fund' | 'crypto' =
    body?.holding_type === 'fund' || body?.holding_type === 'crypto' ? body.holding_type : 'company'

  // A fund holding is created with its terms and a validated entity (POST /api/portfolio/fund-holdings).
  if (body?.holding_type === 'fund') {
    return NextResponse.json({ error: 'Add a fund holding from Investments.' }, { status: 400 })
  }

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  // A digital asset is an investment, not a company: it needs write access to investments, which
  // the portfolio domain's write access alone does not imply.
  if (holdingType === 'crypto') {
    const access = await loadAccessContext(admin, writeCheck.fundId, writeCheck.userId, writeCheck.role)
    if (!hasAccess(access, 'portfolio', 'write', 'investments')) {
      return NextResponse.json({ error: 'You do not have access to digital assets.' }, { status: 403 })
    }
  }

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'No fund found for this user' }, { status: 403 })
  }

  const createScope = await loadEntityScopeForUser(admin, user.id)
  const created = await createCompany(admin, {
    fundId: membership.fund_id,
    userId: user.id,
    vehicleNames: createScope ? createScope.writableNames : [],
    fields: { name, aliases, tags, stage, industry, notes, overview, founders, why_invested, current_update, contact_email, portfolio_group },
    holdingType: holdingType as 'company' | 'crypto',
    defaultMetricIds,
  })
  if (!created.ok) {
    return created.dbError ? dbError(created.dbError as any, 'companies') : NextResponse.json({ error: created.error }, { status: created.status })
  }
  const data = created.company

  // The modal's explicit selection: record the rest as exclusions, so a later fund-wide apply
  // doesn't re-add them. Custom metrics are the modal's own additions.
  if (holdingType === 'company') {
    if (defaultMetricIds) {
      await recordDefaultMetricExclusions(admin, membership.fund_id, data.id, defaultMetricIds)
    }
    if (customMetrics.length > 0) {
      await insertCustomMetrics(admin, membership.fund_id, data.id, customMetrics)
    }
  }

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
