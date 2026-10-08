import type { PageContext } from '@/lib/pages/context'
import { canViewPage } from '@/lib/access/page-gate'
import type { Company, Metric } from '@/lib/types/database'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import type { FeatureVisibilityMap } from '@/lib/types/features'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { scopeGroups } from '@/lib/access/scope'
import { holdingEntities } from '@/lib/portfolio/holding-entities'
import { needsEntities, type HoldingKind } from './holding-panels'

export type CompanyPageData = NonNullable<Awaited<ReturnType<typeof loadCompanyPage>>>

/**
 * One company: the row, its active metrics, the MRR and cash highlights, and which panels this
 * caller may see. Null when the id is not a company the caller can read.
 */
export async function loadCompanyPage({ supabase, admin, user, page }: PageContext, params: { id: string }) {
  const { data: found } = await supabase
    .from('companies')
    .select('*')
    .eq('id', params.id)
    .maybeSingle() as { data: Company | null }

  if (!found) return null

  // Only a company linked to one of the viewer's entities — the same answer the API gate gives its
  // routes (lib/access/entity-gate.ts) — and only those entities named on it.
  const scope = await entityScopeFor(admin, page.access)
  if (scope.companyIds !== null && !scope.companyIds.includes(found.id)) return null
  const company: Company = { ...found, portfolio_group: scopeGroups(found.portfolio_group, scope.vehicleNames) } as Company

  // Companies, fund holdings and digital assets all live on this page; which panels it shows
  // follows the kind (holding-panels.ts). `holding_type` is not on the generated Company type.
  const rawType = (found as { holding_type?: string | null }).holding_type
  const holdingType: HoldingKind = rawType === 'fund' || rawType === 'crypto' ? rawType : 'company'
  // The viewer's entities that hold it — the fund register and the wallets are kept per entity, and
  // nothing else on the page reads them. So a company's page skips the read: a failed read there
  // would take down a page that never needed it.
  const entities = needsEntities(holdingType)
    ? await holdingEntities(admin, company.fund_id, company.id, page.access)
    : []

  const isAdmin = page.isAdmin

  // Fetch AI provider settings for the summary component
  const { data: fundSettings } = await supabase
    .from('fund_settings')
    .select('claude_api_key_encrypted, openai_api_key_encrypted, default_ai_provider, currency, file_storage_provider, google_drive_folder_id, feature_visibility')
    .eq('fund_id', company.fund_id)
    .maybeSingle() as { data: { claude_api_key_encrypted: string | null; openai_api_key_encrypted: string | null; default_ai_provider: string | null; currency: string | null; file_storage_provider: string | null; google_drive_folder_id: string | null; feature_visibility: Record<string, string> | null } | null }

  const fundCurrency = fundSettings?.currency ?? 'USD'
  const featureVisibility = { ...DEFAULT_FEATURE_VISIBILITY, ...(fundSettings?.feature_visibility as Partial<FeatureVisibilityMap> | null) }

  // These panels each belong to a domain, and their APIs are gated to it. Rendering one for a
  // member without the grant would show an empty panel that 403s on load, so ask the resolver —
  // the feature switch alone is only half the answer. (`page` is resolved above, where it decides
  // whether this page renders at all.)
  const showNotes = canViewPage(page, 'relationships', 'notes')
  const showInvestments = canViewPage(page, 'portfolio', 'investments')
  const showInteractions = canViewPage(page, 'relationships', 'interactions')

  const { data: metrics } = await supabase
    .from('metrics')
    .select('*')
    .eq('company_id', params.id)
    .eq('is_active', true)
    .order('display_order') as { data: Metric[] | null }

  // Find highlight metrics (MRR and Cash)
  const mrrMetric = metrics?.find(m =>
    m.slug === 'mrr' || /\bmrr\b/i.test(m.name) || /monthly recurring revenue/i.test(m.name)
  )
  const cashMetric = metrics?.find(m =>
    m.slug === 'cash' || /\bcash\b/i.test(m.name)
  )

  let latestMrr: { value: number; period: string; metric: Metric } | null = null
  let latestCash: { value: number; period: string; metric: Metric } | null = null

  async function getLatestValue(metricId: string) {
    const { data } = await supabase
      .from('metric_values')
      .select('value_number, period_label')
      .eq('metric_id', metricId)
      .not('value_number', 'is', null)
      .order('period_year', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1) as { data: { value_number: number; period_label: string }[] | null }
    return data?.[0] ?? null
  }

  const [mrrRow, cashRow, capturedUpdates] = await Promise.all([
    mrrMetric ? getLatestValue(mrrMetric.id) : null,
    cashMetric ? getLatestValue(cashMetric.id) : null,
    // Once the company has captured Company Updates, that section owns reporting mail and the
    // documents panel drops its legacy email listing. Until the backfill reaches a company, the
    // legacy listing is still how its email history is reachable.
    supabase.from('company_updates').select('id', { count: 'exact', head: true }).eq('company_id', params.id),
  ])
  const hasCapturedUpdates = (capturedUpdates?.count ?? 0) > 0

  if (mrrRow && mrrMetric) {
    latestMrr = { value: mrrRow.value_number!, period: mrrRow.period_label, metric: mrrMetric }
  }
  if (cashRow && cashMetric) {
    latestCash = { value: cashRow.value_number!, period: cashRow.period_label, metric: cashMetric }
  }


  return {
    company,
    holdingType,
    entities,
    userId: user.id,
    isAdmin,
    fundCurrency,
    hasClaudeKey: !!fundSettings?.claude_api_key_encrypted,
    hasOpenAIKey: !!fundSettings?.openai_api_key_encrypted,
    defaultAIProvider: fundSettings?.default_ai_provider ?? 'anthropic',
    storageProvider: fundSettings?.file_storage_provider ?? null,
    googleDriveFolderId: fundSettings?.google_drive_folder_id ?? null,
    featureVisibility,
    showNotes,
    showInvestments,
    showInteractions,
    metrics: metrics ?? [],
    latestMrr,
    latestCash,
    hasCapturedUpdates,
  }
}
