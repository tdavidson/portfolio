import { redirect } from 'next/navigation'
import Script from 'next/script'
import { headers } from 'next/headers'
import { NONCE_HEADER } from '@/lib/security/csp'
import { createClient, getUser } from '@/lib/supabase/server'
import { AppShell } from '@/components/app-shell'
import {
  getReviewBadge,
  getNotesBadge,
  getPendingRequests,
  getPendingActionCountsByDomain,
  pendingActionsBadgeFor,
  getFundData,
  getFundSettings,
  getMembership,
  getDomainGrants,
  getUpdateAvailable,
  getFofActive,
} from '@/lib/cache/layout'
import { accessContextFrom, hasAccess } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import type { FeatureVisibilityMap } from '@/lib/types/features'
import { themeCssVars, type FundTheme } from '@/lib/theme'
import { PRODUCT_NAME } from '@/lib/site-links'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined
  // Auth — uncached (uses cookies)
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')

  // Get fund ID (uncached — quick single query, needed to key everything else)
  const { data: fund } = await supabase.from('funds').select('id').limit(1).single() as { data: { id: string } | null }
  if (!fund) redirect('/onboarding')

  // All cached queries in parallel
  const [fundData, membership, fundSettings, reviewBadge, notesBadge, domainGrants, fofActive] = await Promise.all([
    getFundData(fund.id),
    getMembership(user.id, fund.id),
    getFundSettings(fund.id),
    getReviewBadge(fund.id),
    getNotesBadge(user.id),
    getDomainGrants(user.id, fund.id),
    getFofActive(fund.id),
  ])

  const isAdmin = membership?.role === 'admin'
  const [pendingRequestCount, updateAvailable, pendingActionCounts] = await Promise.all([
    isAdmin ? getPendingRequests(fund.id) : Promise.resolve(0),
    isAdmin ? getUpdateAvailable() : Promise.resolve(false),
    // Not admin-gated any more. A member with grants can open /pending-actions and see their
    // readable rows, so withholding the badge from them hid a queue they were meant to act on;
    // and giving admins the raw total counted rows a fund-level switch had turned off for
    // everyone. The count is now resolved against the same access the page filters by.
    getPendingActionCountsByDomain(fund.id),
  ])

  const featureVisibility = { ...DEFAULT_FEATURE_VISIBILITY, ...(fundSettings?.feature_visibility as Partial<FeatureVisibilityMap> | null) }
  // The LP portal is a master switch: when off, the LP Portal management page and
  // the nested LP Activity page are unavailable for everyone (the pages also gate
  // themselves server-side). Hiding the nav keys here keeps the sidebar in sync.
  if (!fundSettings?.lp_portal_enabled) {
    featureVisibility.lp_portal = 'hidden'
    featureVisibility.lp_activity = 'hidden'
  }
  // The resolver's INPUTS go to the client, which runs the same effectiveAccess the server does.
  // Not a precomputed answer per domain: that has to pick one feature key per domain, and several
  // span more than one — which made the nav hide pages the user could actually open.
  const accessContext = accessContextFrom({
    fundId: fund.id,
    userId: user.id,
    role: membership?.role,
    features: featureVisibility,
    grants: domainGrants.grants,
    defaults: domainGrants.defaults,
    // Only the domain half reaches the client (below); entity scoping is the server's job, done
    // where the data is read. Claim none here rather than guess.
    vehicles: { all: false, ids: [] },
  })
  const { role, features, grants, defaults } = accessContext
  const domainAccess = { role, features, grants, defaults }

  // Resolved AFTER the access context exists, because the whole point is that the number matches
  // what the queue will actually show this person.
  const pendingActionsBadge = pendingActionsBadgeFor(pendingActionCounts, domain =>
    hasAccess(accessContext, domain, 'read'),
  )

  const fundCurrency = fundSettings?.currency ?? 'USD'
  const configuredProviders = [
    fundSettings?.claude_api_key_encrypted ? 'anthropic' : null,
    fundSettings?.openai_api_key_encrypted ? 'openai' : null,
  ].filter(Boolean) as string[]
  const hasAIKey = configuredProviders.length > 0
  const defaultAIProvider = fundSettings?.default_ai_provider ?? 'anthropic'
  const fathomSiteId = fundSettings?.analytics_fathom_site_id ?? null
  const rawGaId = fundSettings?.analytics_ga_measurement_id ?? null
  const gaMeasurementId = rawGaId && /^[A-Z0-9-]+$/i.test(rawGaId) ? rawGaId : null
  const fundName = fundData?.name ?? PRODUCT_NAME
  const fundLogo = fundData?.logo_url ?? null
  // Per-fund branding: override CSS variables app-wide. Empty when no theme set.
  const themeVars = themeCssVars((fundSettings?.theme as FundTheme | null) ?? null)

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {themeVars && <style dangerouslySetInnerHTML={{ __html: `:root{${themeVars}}` }} />}
      <div className="w-full max-w-page mx-auto flex flex-col flex-1">
        <AppShell
          lpPortalEnabled={!!fundSettings?.lp_portal_enabled}
          fundName={fundName}
          fundLogo={fundLogo}
          userEmail={user.email ?? ''}
          reviewBadge={reviewBadge}
          settingsBadge={pendingRequestCount}
          notesBadge={notesBadge}
          pendingActionsBadge={pendingActionsBadge}
          isAdmin={isAdmin}
          currency={fundCurrency}
          hasAIKey={hasAIKey}
          configuredProviders={configuredProviders}
          defaultAIProvider={defaultAIProvider}
          updateAvailable={updateAvailable}
          featureVisibility={featureVisibility}
          domainAccess={domainAccess}
          fofActive={fofActive}
        >
          {children}
        </AppShell>
      </div>

      {fathomSiteId && (
        <Script src="https://cdn.usefathom.com/script.js" data-site={fathomSiteId} strategy="afterInteractive" defer nonce={nonce} />
      )}
      {gaMeasurementId && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`} strategy="afterInteractive" nonce={nonce} />
          <Script id="ga-config" strategy="afterInteractive" nonce={nonce}>{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',${JSON.stringify(gaMeasurementId)});`}</Script>
        </>
      )}
    </div>
  )
}
