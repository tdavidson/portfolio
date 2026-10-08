import type { DemoSnapshot } from './types'

/**
 * Page data for the server-page views when data/pages.json has no entry for the URL: the same
 * shapes the loaders produce, built from the structured snapshot instead. Thinner than a real
 * export (no review counts, no email history), but a page rather than a notice, and enough for
 * the palette and the Analyst to land somewhere. scripts/demo-snapshot.ts replaces all of it.
 */
/** The snapshot's date as a timestamp, for rows that carry one; today when it has none. */
function stamp(snapshot: DemoSnapshot): string {
  const t = Date.parse(snapshot.generatedAt)
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString()
}

export function fallbackPageData(pattern: string, params: Record<string, string>, snapshot: DemoSnapshot): unknown | null {
  const at = stamp(snapshot)
  switch (pattern) {
    case '/dashboard': return dashboard(snapshot)
    case '/companies/:id': return company(snapshot, params.id)
    case '/company-updates': return { companies: snapshot.companies.map(c => ({ id: c.id, name: c.name })) }
    case '/deals': return { initialDeals: snapshot.deals.map(d => ({ ...d, email_id: null, company_url: null, company_domain: null, founder_email: null, referrer_name: null, prior_deal_id: null, created_at: at })) }
    case '/deals/:id': {
      const d = snapshot.deals.find(x => x.id === params.id)
      return d ? { deal: { ...d, email_id: null, created_at: at }, email: null, priorDeal: null } : null
    }
    case '/interactions': return {
      interactions: snapshot.interactions.map((i, n) => ({
        id: `demo-interaction-${n}`, fund_id: 'demo', company_id: i.company_id, email_id: null, user_id: null, tags: [],
        subject: i.subject, summary: i.summary, intro_contacts: null, body_preview: null, interaction_date: i.date, created_at: i.date,
        company_name: snapshot.companies.find(c => c.id === i.company_id)?.name ?? null,
      })),
    }
    default: return null
  }
}

function latest(values: { number: number | null; year: number; quarter: number | null; month: number | null; period_label: string }[]) {
  const withNumber = values.filter(v => v.number != null)
  return withNumber[withNumber.length - 1] ?? null
}

function periodLabel(v: { year: number; quarter: number | null; month: number | null }): string {
  if (v.month) return new Date(v.year, v.month, 0).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  if (v.quarter) return `Q${v.quarter} ${v.year}`
  return `${v.year}`
}

function dashboard(snapshot: DemoSnapshot) {
  const companies = snapshot.companies.map(c => {
    const cash = c.metrics.find(m => m.slug === 'cash' || /\bcash\b/i.test(m.name))
    const latestCash = cash ? latest(cash.values)?.number ?? null : null
    const last = c.metrics.flatMap(m => m.values).sort((a, b) => a.year - b.year || (a.quarter ?? 0) - (b.quarter ?? 0) || (a.month ?? 0) - (b.month ?? 0)).pop()
    const txns = snapshot.investments.filter(t => t.company_id === c.id && t.type === 'investment' && t.date)
    return {
      id: c.id, name: c.name, stage: c.stage, status: c.status, tags: [] as string[], industry: c.industry, portfolioGroup: c.portfolio_group,
      lastReportAt: last ? periodLabel(last) : null,
      openReviews: 0,
      activeMetrics: c.metrics.map(m => ({ id: m.id, name: m.name, unit: m.unit, unit_position: m.unit_position, value_type: m.value_type, currency: null })),
      latestCash,
      firstInvestmentDate: txns[0]?.date ?? null,
      moic: null, grossIrr: null, totalInvested: null, totalRealized: null, unrealizedValue: null,
    }
  })
  // The entity picker (DashboardPageView): every entity the companies are held in, none excluded.
  const groups = Array.from(new Set(companies.flatMap(c => c.portfolioGroup ?? []))).sort()
  const entityOptions = groups.map(name => ({ id: name, name, names: [name] }))
  return { companies, entityOptions, initialExcluded: [] as string[], hasSavedSelection: false, canAdd: false, isAdmin: false, userId: 'demo-viewer' }
}

function company(snapshot: DemoSnapshot, id: string) {
  const c = snapshot.companies.find(x => x.id === id)
  if (!c) return null
  const metrics = c.metrics.map(m => ({
    id: m.id, company_id: m.company_id, fund_id: 'demo', name: m.name, slug: m.slug, unit: m.unit, unit_position: m.unit_position,
    value_type: m.value_type, currency: null, reporting_cadence: m.cadence, display_order: m.display_order, is_active: true, created_at: stamp(snapshot),
  }))
  const highlight = (pick: (m: typeof metrics[number]) => boolean) => {
    const m = metrics.find(pick)
    const src = m && c.metrics.find(x => x.id === m.id)
    const v = src && latest(src.values)
    return m && v ? { value: v.number as number, period: v.period_label, metric: m } : null
  }
  return {
    company: {
      id: c.id, fund_id: 'demo', name: c.name, aliases: c.aliases, industry: c.industry, stage: c.stage, status: c.status, tags: [],
      overview: c.overview, founders: c.founders, why_invested: c.why_invested, portfolio_group: c.portfolio_group,
      contact_email: [], current_update: null, holding_type: 'company', created_at: stamp(snapshot),
    },
    userId: 'demo-viewer', isAdmin: false, fundCurrency: snapshot.fund.currency,
    hasClaudeKey: true, hasOpenAIKey: false, defaultAIProvider: 'anthropic', storageProvider: null, googleDriveFolderId: null,
    featureVisibility: {}, showNotes: true, showInvestments: true, showInteractions: true,
    metrics,
    latestMrr: highlight(m => m.slug === 'mrr' || /\bmrr\b/i.test(m.name) || /monthly recurring revenue/i.test(m.name)),
    latestCash: highlight(m => m.slug === 'cash' || /\bcash\b/i.test(m.name)),
    hasCapturedUpdates: false,
  }
}
