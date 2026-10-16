import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { logActivity } from '@/lib/activity'
import { loadAccessContext } from '@/lib/access/effective'
import { generateCompanySummary } from '@/lib/companies/summary'
import { outcomeResponse } from '@/lib/service-outcome'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'

// Verify the company belongs to the user's fund
async function verifyCompanyAccess(supabase: Awaited<ReturnType<typeof createClient>>, admin: ReturnType<typeof createAdminClient>, userId: string, companyId: string) {
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 404 }) }

  const { data: company } = await admin
    .from('companies')
    .select('fund_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (company.fund_id !== membership.fund_id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  return { fundId: membership.fund_id, role: membership.role }
}

// ---------------------------------------------------------------------------
// GET — return the most recent stored summary (if any)
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  const { data: summaries } = await admin
    .from('company_summaries')
    .select('id, summary_text, period_label, created_at')
    .eq('company_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50) as { data: { id: string; summary_text: string; period_label: string | null; created_at: string }[] | null }

  if (!summaries || summaries.length === 0) {
    return NextResponse.json({ summary: null, generated_at: null, history: [] })
  }

  const latest = summaries[0]

  return NextResponse.json({
    summary: latest.summary_text,
    period_label: latest.period_label,
    generated_at: latest.created_at,
    history: summaries.map(s => ({
      id: s.id,
      summary_text: s.summary_text,
      period_label: s.period_label,
      created_at: s.created_at,
    })),
  })
}

// ---------------------------------------------------------------------------
// DELETE — wipe all stored summaries so the next generate is fresh
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  const { error } = await admin
    .from('company_summaries')
    .delete()
    .eq('company_id', params.id)

  if (error) return dbError(error, 'companies-id-summary')

  return NextResponse.json({ ok: true })
}

// ---------------------------------------------------------------------------
// POST — generate a new AI summary and persist it
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Rate limit AI summary generation: 10 per 5 minutes per user
  const limited = await rateLimit({ key: `ai-summary:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  // Read optional provider override from body
  let providerOverride: import('@/lib/ai').ProviderType | undefined
  try {
    const body = await req.json()
    const validProviders = ['anthropic', 'openai']
    if (validProviders.includes(body.provider)) {
      providerOverride = body.provider
    }
  } catch {
    // No body or invalid JSON — use default provider
  }

  const admin = createAdminClient()

  // Verify fund access before proceeding
  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  // Read, prompt, call the model and save: lib/companies/summary.ts, which `company_generate_summary`
  // runs from chat too.
  const ctxAccess = await loadAccessContext(admin, access.fundId, user.id, access.role)
  return outcomeResponse(await generateCompanySummary(admin, ctxAccess, params.id, { provider: providerOverride }))
}

// ---------------------------------------------------------------------------
// PUT — save analyst-drafted text as a company summary
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  let body: { summary_text?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.summary_text || typeof body.summary_text !== 'string') {
    return NextResponse.json({ error: 'summary_text is required' }, { status: 400 })
  }

  const { error: insertError } = await admin.from('company_summaries').insert({
    company_id: params.id,
    fund_id: access.fundId,
    period_label: null,
    summary_text: body.summary_text.trim(),
  })

  if (insertError) return dbError(insertError, 'companies-id-summary-put')

  logActivity(admin, access.fundId, user.id, 'company.summary', { companyId: params.id, source: 'analyst' })

  return NextResponse.json({
    summary: body.summary_text.trim(),
    generated_at: new Date().toISOString(),
  })
}
