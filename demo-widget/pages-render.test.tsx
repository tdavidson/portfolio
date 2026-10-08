import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The Next.js modules swapped for the widget's stubs, as build.mjs aliases them for the bundle.
vi.mock('next/navigation', () => import('./stubs/next-navigation'))
vi.mock('next/link', () => import('./stubs/next-link'))
vi.mock('next/script', () => import('./stubs/next-script'))
vi.mock('next-themes', () => import('./stubs/next-themes'))
vi.mock('@/lib/supabase/client', () => import('./stubs/supabase-client'))
vi.mock('xlsx', () => import('./stubs/xlsx'))

import { AppRuntimeProvider } from '@/components/app-runtime'
import { AppShell } from '@/components/app-shell'
import { ConfirmProvider } from '@/components/confirm-dialog'
import { ACCESS, FEATURES } from './app'
import { DemoLocationProvider } from './stubs/next-navigation'
import { RouteScreen, type RouteContext } from './routes'
import { allHrefs, matchRoute, type Section } from './route-table'
import { fallbackPageData } from './fallbacks'
import type { RouteRender } from './route-helpers'
import { EMPTY_PAGES, type DemoPages, type DemoSnapshot } from './types'
import snapshotJson from './data/snapshot.json'
import pagesJson from './data/pages.json'

/**
 * Every page the public demo serves, rendered with the data it would get — the recorded
 * data/pages.json entry, and the fallbacks.ts shape built from data/snapshot.json — so a view
 * whose props changed shape without the demo data following (DashboardPageView started reading
 * `entityOptions`; the recording and dashboard() did not have it, and hemrock.com/demo crashed)
 * fails here instead of in a visitor's browser.
 *
 * Server rendering runs the render phase only — no effects, so no fetches — which is where a
 * missing prop throws. The section modules are imported directly rather than through
 * RouteScreen, which shows a loading state until its dynamic import resolves.
 */
const snapshot = snapshotJson as unknown as DemoSnapshot
const pages = pagesJson as unknown as DemoPages

const SECTIONS: Record<Section, () => Promise<{ renders: Record<string, RouteRender> }>> = {
  portfolio: () => import('./sections/portfolio'),
  inbound: () => import('./sections/inbound'),
  diligence: () => import('./sections/diligence'),
  lps: () => import('./sections/lps'),
  funds: () => import('./sections/funds'),
  settings: () => import('./sections/settings'),
}

const noFetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

async function renderHref(pathname: string, data: DemoPages): Promise<string> {
  const match = matchRoute(pathname)
  if (!match) throw new Error(`${pathname} is not a demo route`)
  const ctx: RouteContext = {
    pathname,
    href: pathname === '/' ? '/dashboard' : pathname,
    pattern: match.route.pattern,
    params: match.params,
    query: new URLSearchParams(),
    snapshot,
    pages: data,
  }
  let screen: ReactNode
  if (match.route.section) {
    const render = (await SECTIONS[match.route.section]()).renders[match.route.pattern]
    if (!render) throw new Error(`section ${match.route.section} has no render for ${match.route.pattern}`)
    screen = render(ctx)
  } else {
    screen = <RouteScreen ctx={ctx} />
  }
  return renderToStaticMarkup(
    <DemoLocationProvider value={{ pathname, search: '', params: match.params }}>
      <AppRuntimeProvider fetch={noFetch} navigate={() => {}}>
        <ConfirmProvider>
          {/* DemoApp's shell, as it mounts it: the providers the pages read (Analyst, vehicle, currency, access). */}
          <AppShell
            fundName={snapshot.fund.name} fundLogo={null} userEmail="viewer@hemrock.demo" reviewBadge={0} notesBadge={0}
            pendingActionsBadge={0} isAdmin={false} currency={snapshot.fund.currency} hasAIKey configuredProviders={['anthropic']}
            defaultAIProvider="anthropic" updateAvailable={false} featureVisibility={FEATURES} domainAccess={ACCESS} lpPortalEnabled fofActive={false}
          >
            {screen}
          </AppShell>
        </ConfirmProvider>
      </AppRuntimeProvider>
    </DemoLocationProvider>,
  )
}

const hrefs = ['/', ...allHrefs(snapshot, pages)]
// Every URL whose pattern the fallbacks cover, rendered with no recording so the fallback is what the view gets.
const fallbackHrefs = hrefs.filter(h => {
  const m = matchRoute(h)
  return m && fallbackPageData(m.route.pattern, m.params, snapshot) != null
})

describe('the demo widget renders every route', () => {
  it('finds the routes and the fallback patterns', () => {
    expect(hrefs.length).toBeGreaterThan(40)
    expect(new Set(fallbackHrefs.map(h => matchRoute(h)!.route.pattern))).toEqual(
      new Set(['/dashboard', '/companies/:id', '/company-updates', '/deals', '/deals/:id', '/interactions']),
    )
  })

  it.each(hrefs)('%s with the recorded page data', async href => {
    const html = await renderHref(href, pages)
    expect(html).not.toContain('Not in the demo')
  })

  it.each(fallbackHrefs)('%s with the fallbacks.ts data', async href => {
    const html = await renderHref(href, EMPTY_PAGES)
    expect(html).not.toContain('Not in this snapshot')
  })
})
