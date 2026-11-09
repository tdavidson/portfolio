import { createContext, useContext } from 'react'
import investmentsImportCsv from '../public/templates/investments-import.csv?raw'
import lpImportCsv from '../public/templates/lp-import.csv?raw'
import capitalCallRegisterCsv from '../public/templates/capital-call-register.csv?raw'

/**
 * What the widget writes into an `<a href>`. The app's pages link to the app's own paths
 * (`/companies/<id>`), but the widget is mounted on a page of another site (hemrock.com/demo),
 * where those paths are the site's. A click the widget handles never leaves it, but a new tab, a
 * middle-click, a copied link or a crawler follows the href itself — so the href has to be the
 * site's URL for that page, and the click handler has to read the app's path back out of it.
 *
 * The rules, for an app href:
 * - External, hash, `mailto:` and `/api/*` hrefs are left alone (the mock answers `/api`).
 * - `/templates/<file>.csv`, the import pages' template downloads, become `data:` URLs: the
 *   files are generic and small, and shipping them inside the widget means the host serves nothing.
 * - A path in HIDDEN_IN_DEMO is a link to a page the demo cannot show; the anchor is hidden.
 * - Everything else is the host's URL for that page: `hrefFor(appHref)`, or `basePath + appHref`.
 *
 * The app's path stays on the anchor as `data-app-href`, which is what the click handler and the
 * checks read.
 */

/**
 * Links the pages render to pages the demo deliberately does not serve, by app path pattern, with
 * why. They are hidden in the demo rather than left to 404 on the site. pages-render.test.ts fails
 * on any other link to a URL the widget does not serve, so this list is the whole set.
 */
export const HIDDEN_IN_DEMO: Record<string, string> = {
  '/lps/preview': 'admin only: the portal as a chosen LP sees it; the demo viewer is not an admin',
}

const TEMPLATES: Record<string, string> = {
  '/templates/investments-import.csv': investmentsImportCsv,
  '/templates/lp-import.csv': lpImportCsv,
  '/templates/capital-call-register.csv': capitalCallRegisterCsv,
}

export interface HrefOptions {
  /** The host path the demo is mounted under (`/demo`); the widget writes `/demo/companies/<id>`. */
  basePath?: string
  /** The host URL for an app href (`/companies/<id>?tab=x`), when a prefix is not enough. Wins over basePath. */
  hrefFor?: (appHref: string) => string
}

export interface ResolvedHref {
  /** What goes in the anchor's href. */
  href: string
  /** The app's own href: what the click handler navigates to. Null for an href the widget does not route. */
  appHref: string | null
  /** A link to a page the demo cannot show (HIDDEN_IN_DEMO). */
  hidden: boolean
  /** The file name, for a template download rewritten to a data: URL. */
  download?: string
}

export interface Linker {
  resolve(appHref: string): ResolvedHref
  /** The app href behind a host href this linker wrote (basePath stripped). */
  toApp(href: string): string
}

/** The path of an href, without its query or hash. */
export const pathOf = (href: string) => href.split(/[?#]/)[0] || '/'

const isAppPath = (href: string) => href.startsWith('/') && !href.startsWith('//')

/** Does a path match a `/a/:param/b` pattern? */
const matches = (pattern: string, path: string) => {
  const a = pattern.split('/'), b = path.split('/')
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i])
}

export function isHiddenInDemo(appHref: string): boolean {
  const path = pathOf(appHref)
  return Object.keys(HIDDEN_IN_DEMO).some(pattern => matches(pattern, path))
}

export function createLinker({ basePath, hrefFor }: HrefOptions = {}): Linker {
  const base = (basePath ?? '').replace(/\/+$/, '')
  const toHost = hrefFor ?? ((appHref: string) => (base ? (appHref === '/' ? base : base + appHref) : appHref))
  return {
    resolve(href) {
      if (!isAppPath(href) || href.startsWith('/api/')) return { href, appHref: null, hidden: false }
      const template = TEMPLATES[pathOf(href)]
      if (template !== undefined) {
        return { href: `data:text/csv;charset=utf-8,${encodeURIComponent(template)}`, appHref: null, hidden: false, download: pathOf(href).split('/').pop() }
      }
      return { href: toHost(href), appHref: href, hidden: isHiddenInDemo(href) }
    },
    toApp(href) {
      if (!base || !href.startsWith(base)) return href
      const rest = href.slice(base.length)
      if (rest === '') return '/'
      return /^[/?#]/.test(rest) ? (rest.startsWith('/') ? rest : '/' + rest) : href
    },
  }
}

const LinkerContext = createContext<Linker>(createLinker())
export const LinkerProvider = LinkerContext.Provider
export const useLinker = () => useContext(LinkerContext)

/**
 * Applies the linker to an anchor the app rendered as a plain `<a href="/...">` rather than
 * through next/link (the stub resolves those itself). Idempotent: an anchor already carrying the
 * resolved href is left as it is, so the observer that calls this does not loop on its own writes.
 */
export function applyToAnchor(a: HTMLAnchorElement, linker: Linker): void {
  const current = a.getAttribute('href')
  if (current === null) return
  const known = a.getAttribute('data-app-href')
  // Already resolved (by the stub, or by an earlier pass) and React has not written a new href since.
  if (known !== null && linker.resolve(known).href === current) return
  const r = linker.resolve(current)
  if (r.appHref === null && r.download === undefined) return
  if (r.appHref !== null) a.setAttribute('data-app-href', r.appHref)
  if (r.download !== undefined) a.setAttribute('download', r.download)
  if (r.href !== current) a.setAttribute('href', r.href)
  if (r.hidden) { a.style.display = 'none'; a.setAttribute('aria-hidden', 'true') }
}
