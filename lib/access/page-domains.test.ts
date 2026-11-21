import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The coverage test for PAGES — the twin of route-domains.test.ts.
 *
 * That test's premise was that discipline doesn't hold a rule and a test does. The premise held,
 * and then the same rule went unenforced one layer up: 13 of 24 server components under app/(app)
 * fetched fund data and rendered it with no domain check, because nothing asked them to. The
 * middleware couldn't help — a server component issues no request for it to gate.
 *
 * So a page must now answer the same question a route does: which domain does what I render
 * belong to, or why does it need none. Two things are checked, and the second is the one that
 * matters — a registry nobody consults at runtime is a comment. The page must ACTUALLY call the
 * gate it claims here, in its own source.
 *
 * See plans/plan-access-control.md.
 */

import { PAGE_DOMAINS, UNGATED_PAGES } from './page-domains'
import { DOMAINS } from './domains'

const APP_DIR = path.join(process.cwd(), 'app', '(app)')

/** Every page.tsx under app/(app), keyed as the registry keys them: 'emails/[id]'. */
function findPages(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...findPages(full, base ? `${base}/${entry}` : entry))
    } else if (entry === 'page.tsx') {
      out.push(base)
    }
  }
  return out.sort()
}

const source = (key: string) => readFileSync(path.join(APP_DIR, key, 'page.tsx'), 'utf8')

/** A page that starts with 'use client' renders nothing on the server — see page-domains.ts. */
const isClientPage = (key: string) => /^\s*['"]use client['"]/.test(source(key))

const pages = findPages(APP_DIR)
const serverPages = pages.filter(k => !isClientPage(k))

describe('page access registry', () => {
  it('finds the pages at all (guards against a silently passing test)', () => {
    expect(pages.length).toBeGreaterThan(40)
    expect(serverPages).toContain('dashboard')
    expect(serverPages.length).toBeGreaterThan(20)
  })

  it('gives every server component a domain or an explicit ungated reason', () => {
    const unmapped = serverPages.filter(k => !(k in PAGE_DOMAINS) && !(k in UNGATED_PAGES))

    expect(
      unmapped,
      unmapped.length === 0
        ? ''
        : `\n\nThese pages render on the server with no access decision:\n${unmapped.map(r => `  - ${r}`).join('\n')}\n\n` +
          `A server component fetches its own data, so the middleware never sees it. Add each to\n` +
          `lib/access/page-domains.ts:\n` +
          `  PAGE_DOMAINS['<page>'] = { domain: '<domain>' }   // and call the gate in the page\n` +
          `  UNGATED_PAGES['<page>'] = 'why this renders no fund data'\n\n` +
          `Domains: ${DOMAINS.join(', ')}\n`,
    ).toEqual([])
  })

  it('calls the gate it claims — the registry is not a comment', () => {
    const liars = Object.entries(PAGE_DOMAINS)
      .filter(([key]) => serverPages.includes(key))
      .filter(([key, entry]) => {
        const src = source(key)
        // A named section guard resolves the same context for a whole subtree, so the page proves
        // it by calling the guard rather than canViewPage directly.
        if (entry.gate) return !src.includes(`${entry.gate}(`)
        const call = entry.feature
          ? `canViewPage(page, '${entry.domain}', '${entry.feature}')`
          : `canViewPage(page, '${entry.domain}')`
        return !src.includes(call)
      })
      .map(([key, entry]) => `${key} (claims: ${entry.domain}${entry.feature ? `/${entry.feature}` : ''})`)

    expect(
      liars,
      liars.length === 0
        ? ''
        : `\n\nThese pages are mapped to a domain they never check:\n${liars.map(l => `  - ${l}`).join('\n')}\n\n` +
          `Add to the page, before it fetches anything:\n` +
          `  const page = await resolvePageAccess(user.id)\n` +
          `  if (!page || !canViewPage(page, '<domain>')) redirect('/dashboard')\n`,
    ).toEqual([])
  })

  it('has no entries for pages that no longer exist', () => {
    const known = new Set(pages)
    const stale = [...Object.keys(PAGE_DOMAINS), ...Object.keys(UNGATED_PAGES)].filter(k => !known.has(k))
    expect(stale, `Registry entries for deleted pages: ${stale.join(', ')}`).toEqual([])
  })

  it('never lists a page as both gated and ungated', () => {
    expect(Object.keys(PAGE_DOMAINS).filter(k => k in UNGATED_PAGES)).toEqual([])
  })

  it('uses only real domains', () => {
    const bad = Object.entries(PAGE_DOMAINS).filter(([, e]) => !DOMAINS.includes(e.domain))
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('gives every ungated page a non-trivial reason', () => {
    const weak = Object.entries(UNGATED_PAGES).filter(([, reason]) => reason.trim().length < 10)
    expect(weak.map(([k]) => k)).toEqual([])
  })

  it('does not let a client page claim a gate it cannot run', () => {
    // A 'use client' page can't call resolvePageAccess. If one is listed, either it was converted
    // to a server component (map it properly) or the entry is wrong.
    const clientEntries = Object.keys(PAGE_DOMAINS).filter(k => pages.includes(k) && isClientPage(k))
    expect(clientEntries).toEqual([])
  })
})

describe('the pages that leaked, pinned individually', () => {
  // Named rather than left to the sweep above: each of these rendered fund data to anyone in the
  // fund with the URL, in a fund where the nav had correctly hidden it.
  it.each([
    ['deals', 'dealflow'],
    ['deals/[id]', 'dealflow'],
    ['dashboard', 'portfolio'],
    ['companies/[id]', 'portfolio'],
  ])('%s gates on %s before it fetches', (key, domain) => {
    expect(PAGE_DOMAINS[key].domain).toBe(domain)
    // The page body only — `generateMetadata` above it runs its own (title-sized) query, and
    // that is a separate question from whether the page renders.
    const body = source(key).slice(source(key).indexOf('export default'))
    const gateAt = body.indexOf(`canViewPage(page, '${domain}')`)
    expect(gateAt, `${key} never calls canViewPage(page, '${domain}')`).toBeGreaterThan(-1)
    // Before the first query, or the data is already fetched when the check runs. Matching the
    // quote is what keeps `Array.from(` out of it.
    const firstQuery = body.search(/\.from\(['"]|\.rpc\(['"]/)
    if (firstQuery > -1) expect(gateAt).toBeLessThan(firstQuery)
  })
})
