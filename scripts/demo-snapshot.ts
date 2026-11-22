/**
 * Export the demo fund for the public demo widget: demo-widget/data/snapshot.json and, as the
 * fund's viewer, every server page's data into demo-widget/data/pages.json.
 *
 *   DEMO_FUND_NAME="Hemrock Ventures" DEMO_USER_EMAIL=… DEMO_USER_PASSWORD=… \
 *     npx tsx --env-file=.env.local scripts/demo-snapshot.ts
 *
 * Runs against the database in .env.local (service role) and reads only the one fund. The
 * snapshot is the shape demo-widget/types.ts describes; the pages are the output of every loader
 * in lib/pages/registry.ts, run with a client signed in as DEMO_USER_EMAIL (RLS applies) exactly
 * as the page would run it, keyed by the URL the page serves. Commit both; CI builds the widget
 * from them. The fund's own name is replaced by DEMO_FUND_LABEL (default "Portfolio Demo") so
 * the public widget never carries whatever the install happens to call it.
 *
 * Without DEMO_USER_EMAIL/DEMO_USER_PASSWORD only the snapshot is written.
 *
 * Without the service role (no SUPABASE_SERVICE_ROLE_KEY), everything runs as the viewer: one
 * signed-in client stands in for both, so RLS scopes every read to what the demo account can
 * see, which is the most the public demo should ever carry. NEXT_PUBLIC_SUPABASE_URL and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY (a publishable key) are then all the configuration it needs.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/types/database'
import { createAdminClient } from '@/lib/supabase/admin'
import type { PageAccess } from '@/lib/access/page-gate'
import { loadAccessContext } from '@/lib/access/effective'
import { PAGE_LOADERS, matchPattern } from '@/lib/pages/registry'
import type { PageContext } from '@/lib/pages/context'
import { DEMO_SCHEMA_VERSION, type DemoPages, type DemoSnapshot } from '@/demo-widget/types'

const FUND_NAME = process.env.DEMO_FUND_NAME ?? 'Hemrock Ventures'
const FUND_LABEL = process.env.DEMO_FUND_LABEL ?? 'Portfolio Demo'
const OUT = path.join(process.cwd(), 'demo-widget', 'data', 'snapshot.json')
const PAGES_OUT = path.join(process.cwd(), 'demo-widget', 'data', 'pages.json')

/** Signed in as the demo viewer with the publishable key: RLS applies to everything it reads. */
async function signInViewer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.DEMO_USER_EMAIL
  const password = process.env.DEMO_USER_PASSWORD
  if (!url || !anonKey || !email || !password) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, DEMO_USER_EMAIL and DEMO_USER_PASSWORD (or SUPABASE_SERVICE_ROLE_KEY).')
  }
  const client = createSupabaseClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.user) throw new Error(`Could not sign in as ${email}: ${error?.message ?? 'no user'}`)
  return { client, user: data.user }
}

const asViewer = !process.env.SUPABASE_SERVICE_ROLE_KEY
let viewer: Awaited<ReturnType<typeof signInViewer>> | null = null

async function main() {
  if (asViewer) viewer = await signInViewer()
  const admin = (viewer ? viewer.client : createAdminClient()) as unknown as ReturnType<typeof createAdminClient>
  const { data: fund, error } = await admin.from('funds').select('id, name, currency').eq('name', FUND_NAME).maybeSingle()
  if (error) throw error
  if (!fund) throw new Error(`No fund named ${JSON.stringify(FUND_NAME)}. Set DEMO_FUND_NAME.`)
  const fundId = fund.id

  const [vehicles, companies, metrics, values, lps, deals, notes, interactions, investments, positions] = await Promise.all([
    // fund_vehicles is not in the generated Database type yet; the rest of the codebase casts too.
    (admin as any).from('fund_vehicles').select('id, name, kind').eq('fund_id', fundId).order('name') as Promise<{ data: { id: string; name: string; kind: string | null }[] | null; error: unknown }>,
    admin.from('companies').select('id, name, aliases, industry, stage, status, overview, founders, why_invested, portfolio_group').eq('fund_id', fundId).order('name'),
    admin.from('metrics').select('id, company_id, name, slug, unit, unit_position, value_type, reporting_cadence, display_order').eq('fund_id', fundId).eq('is_active', true).order('display_order'),
    admin.from('metric_values').select('metric_id, period_label, period_year, period_quarter, period_month, value_number').eq('fund_id', fundId)
      .order('period_year').order('period_quarter').order('period_month'),
    admin.from('lp_investors').select('id, name').eq('fund_id', fundId).order('name'),
    admin.from('inbound_deals').select('id, company_name, founder_name, status, stage, industry, raise_amount, intro_source, thesis_fit_score, company_summary, thesis_fit_analysis').eq('fund_id', fundId).order('created_at', { ascending: false }).limit(20),
    admin.from('company_notes').select('id, company_id, content, created_at').eq('fund_id', fundId).order('created_at', { ascending: false }).limit(30),
    admin.from('interactions').select('company_id, subject, summary, interaction_date').eq('fund_id', fundId).order('interaction_date', { ascending: false }).limit(30),
    admin.from('investment_transactions').select('company_id, portfolio_group, transaction_type, transaction_date, round_name, investment_cost, share_price, unrealized_value_change, current_share_price, notes').eq('fund_id', fundId).order('transaction_date'),
    (admin as any).from('lp_investments').select('entity_id, portfolio_group').eq('fund_id', fundId) as Promise<{ data: { entity_id: string; portfolio_group: string }[] | null; error: unknown }>,
  ])
  for (const r of [vehicles, companies, metrics, values, lps, deals, notes, interactions, investments, positions]) if (r.error) throw r.error
  // The LP letters, so the widget walks and records each letter's page. Read as the viewer: a fund
  // whose viewers cannot read lp_relations gets none, and the demo serves the list without them.
  const letters = await (admin as any).from('lp_letters').select('id, period_label, portfolio_group, status')
    .eq('fund_id', fundId).neq('status', 'generating').order('period_year', { ascending: false }).order('period_quarter', { ascending: false }) as { data: { id: string; period_label: string; portfolio_group: string; status: string }[] | null }

  const valuesByMetric = new Map<string, DemoSnapshot['companies'][number]['metrics'][number]['values']>()
  for (const v of values.data ?? []) {
    const list = valuesByMetric.get(v.metric_id) ?? []
    list.push({ period_label: v.period_label, year: v.period_year, quarter: v.period_quarter, month: v.period_month, number: v.value_number })
    valuesByMetric.set(v.metric_id, list)
  }

  const snapshot: DemoSnapshot = {
    schemaVersion: DEMO_SCHEMA_VERSION,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'the demo fund',
    fund: { name: FUND_LABEL, currency: fund.currency ?? 'USD' },
    vehicles: (vehicles.data ?? []).map(v => ({ id: v.id, name: v.name, kind: v.kind ?? null })),
    companies: (companies.data ?? []).map(c => ({
      id: c.id, name: c.name, aliases: c.aliases, industry: c.industry, stage: c.stage, status: c.status ?? 'active',
      overview: c.overview, founders: c.founders, why_invested: c.why_invested, portfolio_group: c.portfolio_group,
      metrics: (metrics.data ?? []).filter(m => m.company_id === c.id).map(m => ({
        id: m.id, company_id: m.company_id, name: m.name, slug: m.slug, unit: m.unit, unit_position: m.unit_position ?? 'prefix',
        value_type: m.value_type ?? 'number', cadence: m.reporting_cadence ?? 'quarterly', display_order: m.display_order ?? 0,
        values: valuesByMetric.get(m.id) ?? [],
      })),
    })),
    lps: (lps.data ?? []).map(l => ({ id: l.id, name: l.name })),
    // One URL per LP per vehicle for the capital statement page; a vehicle is named by its group.
    lpPositions: [...new Map((positions.data ?? []).flatMap(p => {
      const vehicleId = (vehicles.data ?? []).find(v => v.name === p.portfolio_group)?.id
      return vehicleId ? [[`${vehicleId}/${p.entity_id}`, { vehicleId, lpEntityId: p.entity_id }] as const] : []
    })).values()],
    letters: (letters.data ?? []).map(l => ({ id: l.id, periodLabel: l.period_label, portfolioGroup: l.portfolio_group, status: l.status })),
    deals: (deals.data ?? []).map(d => ({ ...d })),
    notes: (notes.data ?? []).map(n => ({ id: n.id, company_id: n.company_id, content: n.content, created_at: String(n.created_at).slice(0, 10) })),
    interactions: (interactions.data ?? []).map(i => ({ company_id: i.company_id, subject: i.subject ?? '', summary: i.summary ?? '', date: String(i.interaction_date).slice(0, 10) })),
    investments: (investments.data ?? []).map(t => ({
      company_id: t.company_id, vehicle: t.portfolio_group ?? '', type: t.transaction_type, date: t.transaction_date ?? '',
      ...(t.round_name ? { round: t.round_name } : {}),
      ...(t.investment_cost != null ? { cost: t.investment_cost } : {}),
      ...(t.share_price != null ? { share_price: t.share_price } : {}),
      ...(t.unrealized_value_change != null ? { unrealized_change: t.unrealized_value_change } : {}),
      ...(t.current_share_price != null ? { mark_share_price: t.current_share_price } : {}),
      ...(t.notes ? { note: t.notes } : {}),
    })),
  }

  writeFileSync(OUT, JSON.stringify(snapshot, null, 1) + '\n')
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${snapshot.companies.length} companies, ${snapshot.companies.reduce((n, c) => n + c.metrics.length, 0)} metrics, ${snapshot.deals.length} deals`)

  await exportPages(admin, fundId)
}

/** resolvePageAccess, with the viewer's own client instead of the service role. */
async function viewerPageAccess(client: any, userId: string): Promise<PageAccess | null> {
  const { data: membership } = await client.from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
  if (!membership) return null
  const access = await loadAccessContext(client, membership.fund_id, userId, membership.role)
  return { fundId: membership.fund_id, role: membership.role, isAdmin: membership.role === 'admin', access }
}

/**
 * Every server page, loaded as the demo viewer. The user-context client is a real sign-in with
 * the anon key, so RLS scopes what the loaders read exactly as it does for the hosted demo; the
 * admin client is filtered by the fund in every loader, as in the pages themselves.
 */
async function exportPages(admin: ReturnType<typeof createAdminClient>, fundId: string) {
  const email = process.env.DEMO_USER_EMAIL
  const password = process.env.DEMO_USER_PASSWORD
  if (!email || !password) {
    console.log('DEMO_USER_EMAIL/DEMO_USER_PASSWORD not set: pages.json left as is.')
    return
  }
  const { client: supabase, user } = viewer ?? await signInViewer()
  const auth = { user }
  // Not resolvePageAccess: it reads the request's cookies (lib/supabase/server), and a script has no request.
  const page = await viewerPageAccess(supabase, user.id)
  if (!page) throw new Error(`${email} is not a member of any fund.`)
  if (page.fundId !== fundId) throw new Error(`${email} belongs to fund ${page.fundId}, not to ${JSON.stringify(FUND_NAME)} (${fundId}).`)
  // The ssr and js clients differ in a type parameter only; both are the same client at runtime.
  const ctx: PageContext = { supabase: supabase as unknown as PageContext['supabase'], admin, user: { id: auth.user.id, email }, page }

  const pages: DemoPages = { schemaVersion: DEMO_SCHEMA_VERSION, generatedAt: new Date().toISOString().slice(0, 10), pages: {} }
  for (const [pattern, entry] of Object.entries(PAGE_LOADERS)) {
    for (const href of await entry.hrefs(ctx)) {
      const params = matchPattern(pattern, href)
      if (!params) continue
      const data = await entry.load(ctx, params)
      if (data === null || data === undefined) continue
      pages.pages[href] = data
    }
  }
  await supabase.auth.signOut()
  writeFileSync(PAGES_OUT, JSON.stringify(pages, null, 1) + '\n')
  console.log(`Wrote ${path.relative(process.cwd(), PAGES_OUT)}: ${Object.keys(pages.pages).length} pages`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
