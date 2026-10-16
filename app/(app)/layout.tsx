import { Suspense } from 'react'
import { ShellBadges, ShellUpdate } from './shell-status'
import { resolvePageAccess } from '@/lib/access/page-gate'
import { redirect } from 'next/navigation'
import { hasCredential } from '@/lib/credentials/env'
import Script from 'next/script'
import { headers } from 'next/headers'
import { NONCE_HEADER } from '@/lib/security/csp'
import { getUser } from '@/lib/supabase/server'
import { AppShell } from '@/components/app-shell'
import {
  getFundData,
  getFundSettings,
  getFofActive,
} from '@/lib/cache/layout'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import { themeCssVars, type FundTheme } from '@/lib/theme'
import { PRODUCT_NAME } from '@/lib/site-links'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined
  // Auth — uncached (uses cookies)
  const user = await getUser()
  if (!user) redirect('/auth')

  // Share the page's live, request-memoized access context. Membership and entity scope arrive
  // in this same RPC, without separate fund, membership or grant queries in the layout.
  const page = await resolvePageAccess(user.id)
  if (!page) redirect('/onboarding')
  const [fundData, fundSettings, fofActive] = await Promise.all([
    getFundData(page.fundId),
    getFundSettings(page.fundId),
    getFofActive(page.fundId),
  ])
  const isAdmin = page.isAdmin
  const noEntities = !page.access.vehicles.all && page.access.vehicles.ids.length === 0

  const featureVisibility = { ...DEFAULT_FEATURE_VISIBILITY, ...page.access.features }
  // The LP portal is a master switch: when off, the LP Portal management page and
  // the nested LP Activity page are unavailable for everyone (the pages also gate
  // themselves server-side). Hiding the nav keys here keeps the sidebar in sync.
  if (!fundSettings?.lp_portal_enabled) {
    featureVisibility.lp_portal = 'hidden'
    featureVisibility.lp_activity = 'hidden'
  }
  // Nav and page use the same fresh role and grants; branding/configuration may stay cached.
  const { role, grants, defaults } = page.access
  const features = featureVisibility
  const domainAccess = { role, features, grants, defaults }

  const fundCurrency = fundSettings?.currency ?? 'USD'
  const configuredProviders = [
    hasCredential(fundSettings, 'anthropic') ? 'anthropic' : null,
    hasCredential(fundSettings, 'openai') ? 'openai' : null,
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
          reviewBadge={0}
          isAdmin={isAdmin}
          currency={fundCurrency}
          hasAIKey={hasAIKey}
          configuredProviders={configuredProviders}
          defaultAIProvider={defaultAIProvider}
          featureVisibility={featureVisibility}
          domainAccess={domainAccess}
          fofActive={fofActive}
        >
          {noEntities && (
            <div className="mb-4 rounded-card border bg-warning-subtle px-4 py-3 text-sm">
              You haven&apos;t been given access to any of the fund&apos;s entities yet, so there&apos;s nothing to
              show here. Ask an admin to choose yours in Settings → Team.
            </div>
          )}
          <Suspense fallback={null}><ShellBadges page={page} userId={user.id} /></Suspense>
          {isAdmin && <Suspense fallback={null}><ShellUpdate /></Suspense>}
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
