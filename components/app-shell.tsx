'use client'

import { useMemo } from 'react'
import { ShellStatusProvider, useShellStatus } from '@/components/shell-status'
import { usePathname, useRouter } from 'next/navigation'
import { AppRuntimeProvider } from '@/components/app-runtime'
import { SidebarProvider, useSidebar } from '@/components/sidebar-context'
import { CurrencyProvider } from '@/components/currency-context'
import { AnalystProvider } from '@/components/analyst-context'
import { VehicleProvider } from '@/components/accounting-vehicle'
import { AppHeader } from '@/components/app-header'
import { AppSidebar } from '@/components/app-sidebar'
import { AppFooter } from '@/components/app-footer'
import { MobileNav, MOBILE_TAB_BAR_SPACER } from '@/components/mobile-nav'
import { CommandPaletteProvider } from '@/components/command-palette'
import { FeatureVisibilityProvider } from '@/components/feature-visibility-context'
import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

/** A member with no grants — the fail-closed default when the shell is rendered without access. */
const EMPTY_ACCESS: ClientAccess = { role: 'member', features: DEFAULT_FEATURE_VISIBILITY, grants: {}, defaults: {} }
import type { FeatureVisibilityMap } from '@/lib/types/features'

interface AppShellProps {
  fundName: string
  fundLogo: string | null
  userEmail: string
  reviewBadge: number
  /** Staged changes waiting for approval that this user can read. Shows the Approvals nav entry. */
  approvalsBadge?: number
  settingsBadge?: number
  notesBadge?: number
  isAdmin?: boolean
  currency?: string
  hasAIKey?: boolean
  configuredProviders?: string[]
  defaultAIProvider?: string
  updateAvailable?: boolean
  featureVisibility?: FeatureVisibilityMap
  /** Derived, not a setting: true when the fund holds at least one fund. */
  fofActive?: boolean
  /** The access resolver's inputs for this user. Drives what the nav offers. */
  domainAccess?: ClientAccess
  /** LP portal switched on for this fund. Gates every 'publish/share to LPs' button. */
  lpPortalEnabled?: boolean
  children: React.ReactNode
}

export function AppShell(props: AppShellProps) {
  return (
    <ShellStatusProvider initial={{
      reviewBadge: props.reviewBadge,
      approvalsBadge: props.approvalsBadge ?? 0,
      settingsBadge: props.settingsBadge ?? 0,
      notesBadge: props.notesBadge ?? 0,
      updateAvailable: props.updateAvailable ?? false,
    }}>
      <AppShellContent {...props} />
    </ShellStatusProvider>
  )
}

function AppShellContent({ fundName, fundLogo, userEmail, isAdmin, currency, hasAIKey, configuredProviders, defaultAIProvider, featureVisibility, domainAccess, lpPortalEnabled, fofActive, children }: AppShellProps) {
  const { reviewBadge, approvalsBadge, settingsBadge, notesBadge, updateAvailable } = useShellStatus()
  const router = useRouter()
  const navigate = useMemo(
    () => (href: string, opts?: { replace?: boolean }) => (opts?.replace ? router.replace(href) : router.push(href)),
    [router],
  )
  return (
    // The router is the app's `navigate` (components/app-runtime.tsx); the demo widget swaps it.
    <AppRuntimeProvider navigate={navigate}>
    <FeatureVisibilityProvider value={featureVisibility ?? DEFAULT_FEATURE_VISIBILITY} isAdmin={isAdmin} lpPortalEnabled={lpPortalEnabled ?? false}>
    <AccessProvider value={domainAccess ?? EMPTY_ACCESS}>
    <CurrencyProvider currency={currency ?? 'USD'}>
      <SidebarProvider>
        <AnalystProvider hasAIKey={hasAIKey ?? false} configuredProviders={configuredProviders ?? []} defaultAIProvider={defaultAIProvider ?? 'anthropic'} fundName={fundName}>
          {/* The selected fund lives here, above the sidebar, so the Funds subnav can build
              fund-first hrefs (/funds/<id>/...) from the current vehicle's id. */}
          <VehicleProvider>
          {/* The palette sits above the shell so the header's button and any page can open it,
              and below the vehicle context so an entity-scoped jump can pin the entity. */}
          <CommandPaletteProvider reviewBadge={reviewBadge} approvalsBadge={approvalsBadge} fofActive={fofActive}>
            {/* fofActive was being dropped here, which is why "Underlying funds" and the
                fund-of-funds ledger pages never appeared in the nav on any surface: the
                layout resolves it, AppShell takes it, and AppShellInner was never handed
                it. */}
            <AppShellInner
              fundName={fundName}
              fundLogo={fundLogo}
              userEmail={userEmail}
              reviewBadge={reviewBadge}
              approvalsBadge={approvalsBadge}
              settingsBadge={settingsBadge}
              notesBadge={notesBadge}
              isAdmin={isAdmin}
              updateAvailable={updateAvailable}
              featureVisibility={featureVisibility}
              fofActive={fofActive}
            >
              {children}
            </AppShellInner>
          </CommandPaletteProvider>
          </VehicleProvider>
        </AnalystProvider>
      </SidebarProvider>
    </CurrencyProvider>
    </AccessProvider>
    </FeatureVisibilityProvider>
    </AppRuntimeProvider>
  )
}

function AppShellInner({ fundName, fundLogo, userEmail, reviewBadge, approvalsBadge, settingsBadge, notesBadge, isAdmin, updateAvailable, featureVisibility, fofActive, children }: AppShellProps) {
  const { collapsed } = useSidebar()
  const pathname = usePathname()

  // The LP-portal preview renders full-screen (no GP header/sidebar) so it looks
  // like the real /portal an LP logs into.
  if (pathname === '/lps/preview') {
    return <>{children}</>
  }

  return (
    <>
      <AppHeader
        fundName={fundName}
        fundLogo={fundLogo}
        userEmail={userEmail}
      />

      <div className="flex flex-1">
        {/* Desktop sidebar, always rendered, width varies */}
        <aside
          className={`hidden md:flex flex-col shrink-0 pt-6 transition-all duration-200 ${ collapsed ? 'w-16' : 'w-56' }`}
        >
          <AppSidebar reviewBadge={reviewBadge} approvalsBadge={approvalsBadge} settingsBadge={settingsBadge} notesBadge={notesBadge} isAdmin={isAdmin} updateAvailable={updateAvailable} featureVisibility={featureVisibility} fofActive={fofActive} />
        </aside>

        {/* Page content. The width cap lives one level up, on the wrapper in
            app/(app)/layout.tsx — capping again here would be inert.

            The bottom padding clears the phone's tab bar, which is fixed: without it
            the footer and the last row of any page sit underneath it. The measurement
            lives with the bar, so the two cannot drift. */}
        <main className={`flex-1 min-w-0 flex flex-col ${MOBILE_TAB_BAR_SPACER} ${collapsed ? 'md:pl-4' : ''}`}>
          <div className="flex-1">
            {children}
          </div>
          {/* Not on the landing page. /start is a single centred composer that claims the
              viewport, and the footer's row of links sat under it as a second, unrelated strip —
              the one thing on the page that wasn't the page. Its links live on Support instead. */}
          {pathname !== '/start' && <AppFooter />}
        </main>
      </div>

      {/* Phone navigation. Rendered below md only; the aside above covers desktop. */}
      <MobileNav
        reviewBadge={reviewBadge}
        approvalsBadge={approvalsBadge}
        settingsBadge={settingsBadge}
        notesBadge={notesBadge}
        isAdmin={isAdmin}
        updateAvailable={updateAvailable}
        featureVisibility={featureVisibility}
        fofActive={fofActive}
      />
    </>
  )
}
