import { describe, expect, it } from 'vitest'
import { readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { PAGE_LOADERS, matchPattern } from '@/lib/pages/registry'

import { ROUTES } from './route-table'

/**
 * The demo's route table against the app. route-table.ts is data — no page component is
 * imported — so a page added to the app without a demo route, or a loader without a route to
 * show its data, fails here rather than silently rendering "not in the demo".
 */
const APP_DIR = path.resolve(__dirname, '..', 'app', '(app)')
const patterns = ROUTES.map(r => r.pattern)

/** Pages the demo deliberately leaves out: admin-only, redirects, or flows that need a signed-in user. */
const NOT_IN_DEMO: Record<string, string> = {
  'accounting/[[...rest]]': 'redirect to /funds',
  'companies': 'redirect to /dashboard',
  'lps/live': 'redirect to /lps',
  'lps/preview': 'admin only',
  'pending-actions': 'admin only',
  'usage': 'admin only',
  'portfolio': 'holdings by entity — the demo shows one fund, which the dashboard already covers',
  'entities/[id]/documents': 'an entity\'s uploaded governing documents — the demo fund has none to show',
  'updates': 'admin only',
  'diligence/analytics': 'admin only',
  'settings/memo-agent/defaults': 'admin only',
  'settings/memo-agent/schemas': 'admin only',
  'settings/memo-agent/schemas/[name]': 'admin only',
  'settings/memo-agent/style-anchors': 'admin only',
  'settings/memo-agent/style-anchors/[id]': 'admin only',
  'manco/[[...rest]]': 'redirect into /funds',
  'funds/[id]/text': 'redirect to the journal',
  'funds/[id]/migrate': 'reached from Admin, not the nav; an import flow',
  'funds/[id]/opening-balances': 'reached from Admin, not the nav; a setup flow',
  'funds/[id]/tax': 'tax_reporting ships off',
}

function pages(dir = APP_DIR, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...pages(full, prefix ? `${prefix}/${name}` : name))
    else if (name === 'page.tsx' && prefix) out.push(prefix)
  }
  return out
}

/** `companies/[id]` → `/companies/:id`; catch-alls have no demo route. */
const toPattern = (key: string) => '/' + key.replace(/\[\.\.\.[^\]]+\]|\[\[\.\.\.[^\]]+\]\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1')

describe('demo widget route table', () => {
  it('finds the pages at all', () => {
    expect(pages().length).toBeGreaterThan(40)
    expect(patterns.length).toBeGreaterThan(30)
  })

  it('serves every page under app/(app) or names why not', () => {
    const missing = pages().filter(key => {
      if (NOT_IN_DEMO[key]) return false
      const pattern = toPattern(key)
      // /funds/[id]/<slug> pages are one route with the slug as a param.
      if (/^\/funds\/:id\/[a-z-]+$/.test(pattern)) return !patterns.includes('/funds/:id/:slug')
      // /funds/[id] is /funds/:x (section or entity).
      if (pattern === '/funds/:id') return !patterns.includes('/funds/:x')
      return !patterns.includes(pattern)
    })
    expect(missing, `pages without a demo route (add to demo-widget/routes.tsx or to NOT_IN_DEMO here):\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('has no entries in NOT_IN_DEMO for pages that no longer exist', () => {
    const stale = Object.keys(NOT_IN_DEMO).filter(key => !existsSync(path.join(APP_DIR, key, 'page.tsx')))
    expect(stale).toEqual([])
  })

  it('has a route for every registered page loader', () => {
    const unrouted = Object.keys(PAGE_LOADERS).filter(pattern => !patterns.includes(pattern))
    expect(unrouted).toEqual([])
  })

  it('matches patterns the way the widget does', () => {
    expect(matchPattern('/companies/:id', '/companies/abc')).toEqual({ id: 'abc' })
    expect(matchPattern('/companies/:id', '/deals/abc')).toBeNull()
    expect(matchPattern('/diligence/:id/drafts/:draftId', '/diligence/a/drafts/b?x=1')).toEqual({ id: 'a', draftId: 'b' })
  })
})
