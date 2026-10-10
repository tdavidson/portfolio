import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppRuntimeProvider } from '@/components/app-runtime'
import { AppShell } from '@/components/app-shell'
import { ConfirmProvider } from '@/components/confirm-dialog'
import { Toaster } from '@/components/toaster'
import type { ClientAccess } from '@/components/access-context'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AppExit, AppFetch } from '@/components/app-runtime'
import { DemoLocationProvider } from './stubs/next-navigation'
import { matchRoute, RouteScreen } from './routes'
import type { DemoData } from './types'

/**
 * The demo: the app's own shell (header, sidebar, palette, Analyst, phone tab bar) around the
 * app's own pages, on the snapshot. Two substitutions make it run without a server —
 * `fetch` (installed on the window by index.tsx before the first render, and answered by
 * mock-api.ts) and `navigate` (this component, which swaps the page instead of the URL) — and
 * everything else is the component tree the product renders.
 */

// Every product area on, so the palette lists the pages and the sidebar shows the sections. The
// viewer role keeps it all read-only, exactly as the hosted demo account is.
export const FEATURES: FeatureVisibilityMap = {
  ...DEFAULT_FEATURE_VISIBILITY,
  interactions: 'everyone', notes: 'everyone', lp_letters: 'everyone', asks: 'everyone', lps: 'everyone',
  lp_tracking: 'everyone', lp_portal: 'everyone', lp_activity: 'everyone', compliance: 'everyone',
  deals: 'everyone', diligence: 'everyone', accounting: 'everyone', imports: 'everyone', investments: 'everyone',
  gp_economics: 'everyone', budgeting: 'everyone',
}
export const ACCESS: ClientAccess = { role: 'viewer', features: FEATURES, grants: {}, defaults: {} }

interface Location { pathname: string; search: string }

function parse(href: string): Location {
  const u = new URL(href, 'https://demo.invalid')
  return { pathname: u.pathname.replace(/\/+$/, '') || '/', search: u.search }
}

export interface DemoAppProps {
  data: DemoData
  fetch: AppFetch
  initialPath?: string
  /** Called after every navigation with the new path; the host may mirror it into its URL. */
  onNavigate?: (href: string, opts: { replace: boolean }) => void
  /** Hands the host the widget's `navigate`, for `mount().navigate`. */
  exposeNavigate?: (navigate: (href: string, opts?: { replace?: boolean }) => void) => void
  /** Fires once the first page has been committed to the DOM. */
  onReady?: () => void
  /** The header's "Exit demo" link, in place of the app's sign-out. */
  exit?: AppExit
  /**
   * `card`: a bordered, fixed-height frame to sit inside a page of prose. `page`: fills the
   * element it is mounted in, no border — the host gives it the viewport and the demo is the page.
   */
  chrome?: 'card' | 'page'
}

export function DemoApp({ data, fetch, initialPath = '/dashboard', onNavigate, exposeNavigate, onReady, exit, chrome = 'card' }: DemoAppProps) {
  const [loc, setLoc] = useState<Location>(() => parse(initialPath))
  const frame = useRef<HTMLDivElement>(null)

  // Where the widget is now, for the no-op check below; written when navigating, never in render.
  const current = useRef(loc)
  const navigate = useCallback((href: string, opts?: { replace?: boolean }) => {
    if (/^(https?:)?\/\//.test(href) || href.startsWith('mailto:')) { window.open(href, '_blank', 'noopener'); return }
    const next = parse(href)
    // Already there: nothing to do. A page that syncs its state into the URL asks for the URL it
    // is on, and must not cause a render that asks again.
    if (next.pathname === current.current.pathname && next.search === current.current.search) return
    const samePage = next.pathname === current.current.pathname
    current.current = next
    setLoc(next)
    if (!samePage) frame.current?.scrollTo({ top: 0 })
    onNavigate?.(next.pathname + next.search, { replace: !!opts?.replace })
  }, [onNavigate])

  useEffect(() => { exposeNavigate?.(navigate) }, [navigate, exposeNavigate])
  useEffect(() => { onReady?.() }, [onReady])

  const match = useMemo(() => matchRoute(loc.pathname), [loc.pathname])
  const location = useMemo(
    () => ({ pathname: loc.pathname, search: loc.search, params: match?.params ?? {} }),
    [loc.pathname, loc.search, match],
  )

  // Links inside the pages are <a href> (next/link's stub); a click on one navigates here rather
  // than leaving the marketing site. Anchors with a target, hash-only anchors and downloads pass.
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null
      if (!a || a.target || a.hasAttribute('download')) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
      if (/^https?:\/\//.test(href)) { if (!href.startsWith(window.location.origin + '/api')) return }
      e.preventDefault()
      navigate(href)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [navigate])

  const screen = (
    <RouteScreen
      ctx={{
        pathname: loc.pathname,
        href: loc.pathname === '/' ? '/dashboard' : loc.pathname,
        pattern: match?.route.pattern ?? '',
        params: match?.params ?? {},
        query: new URLSearchParams(loc.search),
        snapshot: data.snapshot,
        pages: data.pages,
      }}
    />
  )

  return (
    <DemoLocationProvider value={location}>
    <AppRuntimeProvider fetch={fetch} navigate={navigate} exit={exit}>
      {/* A transformed ancestor is the containing block for `position: fixed` descendants, which
          keeps the app's phone tab bar and drawers inside the frame instead of over the site. */}
      <div
        ref={frame}
        className={`oa-demo oa-demo-root oa-demo-frame relative flex flex-col overflow-auto bg-background text-foreground [transform:translateZ(0)] ${chrome === 'page' ? 'h-full' : 'h-[820px] max-h-[85vh] rounded-card border'}`}
      >
        {/* The root layout's providers (app/layout.tsx), minus the theme: the host owns that. */}
        <ConfirmProvider>
        <div className="w-full max-w-page mx-auto flex flex-col flex-1 min-h-full">
          <AppShell
            fundName={data.snapshot.fund.name}
            fundLogo={null}
            userEmail="viewer@hemrock.demo"
            reviewBadge={0}
            notesBadge={0}
            pendingActionsBadge={0}
            isAdmin={false}
            currency={data.snapshot.fund.currency}
            hasAIKey
            configuredProviders={['anthropic']}
            defaultAIProvider="anthropic"
            updateAvailable={false}
            featureVisibility={FEATURES}
            domainAccess={ACCESS}
            lpPortalEnabled
            fofActive={false}
          >
            <div key={loc.pathname} className="flex-1">{screen}</div>
          </AppShell>
        </div>
        </ConfirmProvider>
        <Toaster />
      </div>
    </AppRuntimeProvider>
    </DemoLocationProvider>
  )
}
