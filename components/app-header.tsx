'use client'

import { useEffect } from 'react'
import { LogOut, Building2, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LpPortalSwitchLink } from '@/components/lp-portal-switch-link'
import { useSidebar } from '@/components/sidebar-context'
import { CommandPaletteTrigger } from '@/components/command-palette'
import { useAppExit } from '@/components/app-runtime'
import { rememberAccount, useRecentAccounts } from '@/lib/recent-accounts'
import { useThemeCycle } from '@/components/app-sidebar'
import type { NavLayout } from '@/lib/nav/layout'

interface AppHeaderProps {
  fundName: string
  fundLogo?: string | null
  userEmail: string
  /**
   * The member's nav layout (lib/nav/layout.ts). `fixed` moves the fund and the account into the
   * pinned sidebar on desktop, so the header keeps only the palette there; `top` adds the theme
   * switch, which has no sidebar to live in. Phones get the full header in every layout.
   */
  layout?: NavLayout
}

// Identity and sign-out. Navigation is NOT here any more: on desktop it is the aside
// in app-shell.tsx, and on a phone it is components/mobile-nav.tsx — a bottom tab bar
// with the sidebar behind "More". The hamburger this used to carry was in the corner
// of the screen furthest from a thumb, and opened a menu a third of which could not be
// scrolled to.
//
// The one navigation control that IS here is the command palette's button (⌘K). It is
// not a menu: it is the way in for someone who knows the name of what they want, and
// the header is where every surface, phone included, has it in the same place.
export function FundMark({ fundLogo }: { fundLogo?: string | null }) {
  return fundLogo ? (
    <img
      src={fundLogo}
      alt=""
      className="h-7 w-7 rounded object-contain shrink-0"
    />
  ) : (
    <div className="h-7 w-7 rounded bg-muted flex items-center justify-center shrink-0">
      <Building2 className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

export function AppHeader({ fundName, fundLogo, userEmail, layout = 'sidebar' }: AppHeaderProps) {
  const { collapsed: collapsedPref } = useSidebar()
  // Collapsing only applies to the original sidebar; the other layouts always show the name.
  const collapsed = collapsedPref && layout === 'sidebar'
  const theme = useThemeCycle()
  const ThemeIcon = theme.icon

  return (
    <header className="relative flex items-center justify-between px-4 py-3 shrink-0">
      {/* Left: logo + fund name. In the fixed layout they sit at the top of the sidebar instead. */}
      <div className={`flex items-center gap-3 min-w-0 ${layout === 'fixed' ? 'md:hidden' : ''}`}>
        <FundMark fundLogo={fundLogo} />
        {!collapsed && (
          <span className="font-medium text-sm text-muted-foreground tracking-tight truncate">{fundName}</span>
        )}
      </div>
      {layout === 'fixed' && <div className="hidden md:block" />}

      {/* Fund name aligned above page content when sidebar collapsed.
          left-28 (112px) is the page content's left edge, and has to be kept in step with it:
          64 (the collapsed aside's w-16) + 16 (main's md:pl-4) + 32 (the section layout's
          md:pl-8, e.g. app/(app)/funds/layout.tsx). */}
      {collapsed && (
        <span className="hidden md:block absolute left-28 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground/70 tracking-tight">
          {fundName}
        </span>
      )}

      {/* Right: palette + sign out. The signed-in address is the sign-out button's tooltip rather
          than a line of header text: it is only ever looked for when deciding whether to sign out. */}
      <div className="flex items-center gap-3">
        <CommandPaletteTrigger />
        <LpPortalSwitchLink />
        {layout === 'top' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={theme.cycle}
            className="hidden md:inline-flex h-8 w-8 p-0 text-muted-foreground"
            title={`Theme: ${theme.label}`}
            aria-label={`Theme: ${theme.label}. Change theme`}
          >
            <ThemeIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        <div className={layout === 'fixed' ? 'md:hidden' : ''}>
          <AccountControls fundName={fundName} userEmail={userEmail} />
        </div>
      </div>
    </header>
  )
}

/**
 * Sign out (and switch account, once this browser knows another), or "Exit demo" in the public
 * demo. In the header for most layouts; at the foot of the fixed sidebar in that one, where
 * `compact` shows icon buttons only.
 */
export function AccountControls({ fundName, userEmail, compact }: { fundName: string; userEmail: string; compact?: boolean }) {
  const exit = useAppExit()
  // Only offered once this browser has signed in to some OTHER account: with one fund there is
  // nothing to switch to. The first switch is a plain sign-out and sign-in, after which both
  // addresses are in the list and the button appears in each.
  const recent = useRecentAccounts()
  const canSwitch = recent.some(a => a.email !== userEmail.trim().toLowerCase())

  // So "Switch account" on the sign-in page can offer this address, named by its fund.
  useEffect(() => {
    if (!exit && userEmail) rememberAccount({ email: userEmail, fundName })
  }, [exit, userEmail, fundName])

  return (
      <div className={`flex items-center ${compact ? 'flex-wrap gap-1' : 'gap-3'}`}>
        {exit ? (
          // The public demo has no session: the button leaves it instead. `target` keeps the
          // demo's own link handling from treating it as a page inside the demo.
          <Button asChild variant="outline" size="sm" className={`text-muted-foreground gap-2 ${compact ? 'h-8 w-8 p-0' : ''}`} title={compact ? exit.label : undefined}>
            <a href={exit.href} target="_self">
              <LogOut className="h-4 w-4" />
              <span className={compact ? 'sr-only' : 'hidden sm:inline'}>{exit.label}</span>
            </a>
          </Button>
        ) : (
          <>
            {/* One email is one fund, so switching funds is a sign-out that lands on the sign-in
                page with this browser's other accounts offered (lib/recent-accounts.ts). */}
            {canSwitch && (
              <form action="/api/auth/logout" method="POST">
                <input type="hidden" name="switch" value="1" />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground"
                  title={`Signed in as ${userEmail}. Switch account`}
                  aria-label="Switch account"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </Button>
              </form>
            )}
            <form action="/api/auth/logout" method="POST">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className={`text-muted-foreground gap-2 ${compact ? 'h-8 w-8 p-0' : ''}`}
                title={`Signed in as ${userEmail}`}
              >
                <LogOut className="h-4 w-4" />
                <span className={compact ? 'sr-only' : 'hidden sm:inline'}>Sign out</span>
              </Button>
            </form>
          </>
        )}
      </div>
  )
}
