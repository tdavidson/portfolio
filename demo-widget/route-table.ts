import type { DemoPages, DemoSnapshot } from './types'

/**
 * The widget's route table, as data: every URL pattern a viewer of the demo fund can open, how
 * to enumerate each one's concrete URLs for a fund, and which section's module renders it. No
 * component is imported here, so build.mjs can run `allHrefs` in Node and publish the list
 * (dist/routes.json) for the marketing site's build to prerender and the scripts to walk.
 * routes.tsx adds the renders. `routes.test.ts` fails when a page exists in the app without
 * an entry here.
 */
export type Section = 'portfolio' | 'inbound' | 'diligence' | 'lps' | 'funds' | 'settings'

export interface DemoRoute {
  /** `/companies/:id` — segments starting with `:` are params. */
  pattern: string
  /** The section module that renders it; the core renders the rest (routes.tsx). */
  section?: Section
  /** Concrete URLs to walk when recording, checking or prerendering; static routes list themselves. */
  hrefs?: (snapshot: DemoSnapshot, pages: DemoPages) => string[]
}

const recordedHrefs = (prefix: RegExp) => (_s: DemoSnapshot, pages: DemoPages) => Object.keys(pages.pages).filter(h => prefix.test(h))

/** The `/funds/<slug>` sections and `/funds/<id>/<slug>` pages the widget walks. */
const SECTION_SLUGS = ['status', 'bank', 'capital-accounts', 'journal', 'ledger', 'periods', 'schedule-of-investments', 'construction', 'forecast', 'statements']

export const ROUTES: DemoRoute[] = [
  { pattern: '/' },
  { pattern: '/start' },
  { pattern: '/dashboard' },
  // Portfolio
  { pattern: '/companies/:id', section: 'portfolio', hrefs: s => s.companies.map(c => `/companies/${c.id}`) },
  { pattern: '/company-updates', section: 'portfolio' },
  { pattern: '/import', section: 'portfolio' },
  { pattern: '/investments', section: 'portfolio' },
  { pattern: '/requests', section: 'portfolio' },
  { pattern: '/interactions', section: 'portfolio' },
  { pattern: '/letters', section: 'portfolio' },
  { pattern: '/letters/new', section: 'portfolio' },
  { pattern: '/letters/:id', section: 'portfolio', hrefs: () => [] },
  { pattern: '/notes', section: 'portfolio' },
  { pattern: '/compliance', section: 'portfolio' },
  { pattern: '/compliance/links', section: 'portfolio' },
  // Inbound, review, deals
  { pattern: '/emails', section: 'inbound' },
  { pattern: '/emails/:id', section: 'inbound', hrefs: recordedHrefs(/^\/emails\/[^/]+$/) },
  { pattern: '/review', section: 'inbound' },
  { pattern: '/deals', section: 'inbound' },
  { pattern: '/deals/:id', section: 'inbound', hrefs: s => s.deals.map(d => `/deals/${d.id}`) },
  // Diligence
  { pattern: '/diligence', section: 'diligence' },
  { pattern: '/diligence/inbox', section: 'diligence' },
  { pattern: '/diligence/:id', section: 'diligence', hrefs: recordedHrefs(/^\/diligence\/[^/]+$/) },
  { pattern: '/diligence/:id/qa', section: 'diligence', hrefs: recordedHrefs(/^\/diligence\/[^/]+\/qa$/) },
  { pattern: '/diligence/:id/drafts/:draftId', section: 'diligence', hrefs: recordedHrefs(/^\/diligence\/[^/]+\/drafts\/[^/]+$/) },
  // LPs
  { pattern: '/lps', section: 'lps' },
  { pattern: '/lps/capital', section: 'lps' },
  { pattern: '/lps/cards', section: 'lps' },
  { pattern: '/lps/cards/:investorId', section: 'lps', hrefs: s => s.lps.map(lp => `/lps/cards/${lp.id}`) },
  { pattern: '/lp-portal', section: 'lps' },
  { pattern: '/lp-activity', section: 'lps' },
  // Entities
  { pattern: '/funds', section: 'funds' },
  { pattern: '/funds/:x', section: 'funds', hrefs: s => [...SECTION_SLUGS.map(slug => `/funds/${slug}`), ...s.vehicles.map(v => `/funds/${v.id}`)] },
  { pattern: '/funds/:id/:slug', section: 'funds', hrefs: s => s.vehicles.flatMap(v => SECTION_SLUGS.map(slug => `/funds/${v.id}/${slug}`)) },
  { pattern: '/funds/:id/capital-accounts/:lpEntityId', section: 'funds', hrefs: s => (s.lpPositions ?? []).map(p => `/funds/${p.vehicleId}/capital-accounts/${p.lpEntityId}`) },
  // Settings and support
  { pattern: '/settings', section: 'settings' },
  { pattern: '/support', section: 'settings' },
]

/** The route for a path and the params it binds, or null for a path the demo does not serve. */
export function matchRoute(pathname: string): { route: DemoRoute; params: Record<string, string> } | null {
  const segs = pathname.split('/')
  for (const route of ROUTES) {
    const pat = route.pattern.split('/')
    if (pat.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(segs[i])
      else if (pat[i] !== segs[i]) { ok = false; break }
    }
    if (ok) return { route, params }
  }
  return null
}

/** Every concrete URL the widget serves for this data: what the recorder and the check walk. */
export function allHrefs(snapshot: DemoSnapshot, pages: DemoPages): string[] {
  const out = new Set<string>()
  for (const route of ROUTES) {
    if (route.hrefs) for (const h of route.hrefs(snapshot, pages)) out.add(h)
    else if (!route.pattern.includes(':')) out.add(route.pattern)
  }
  // Anything the snapshot script recorded that the table can serve, whether or not the table
  // could have enumerated it (a letter, a memo draft).
  for (const h of Object.keys(pages.pages)) if (matchRoute(h)) out.add(h)
  return [...out].filter(h => h !== '/')
}
