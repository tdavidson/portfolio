import { createRoot, type Root } from 'react-dom/client'
import { DemoApp } from './app'
import { toast } from 'sonner'
import { createDemoFetch, interceptApiFetch } from './mock-api'
import { allHrefs, prefetchSections } from './routes'
import { initDemoTheme } from './stubs/next-themes'
import { DEMO_SCHEMA_VERSION, EMPTY_API, EMPTY_PAGES, type DemoAnswers, type DemoApi, type DemoPages, type DemoSnapshot } from './types'
import type { AppFetch } from '@/components/app-runtime'

/**
 * The public demo widget's entry point. Built by demo-widget/build.mjs into an ES module
 * (`widget.js`, loaded with `<script type="module">`) that sets the global `PortfolioDemo` and
 * pulls each section of the app from its own chunk on first use, plus a stylesheet. The
 * marketing site mounts it:
 *
 *   const demo = PortfolioDemo.mount(el, { snapshot, answers, pages, api, chrome: 'page', basePath: '/demo' })
 *   demo.navigate('/deals')
 *   demo.unmount()
 *
 * The stylesheet is the app's own, scoped to elements carrying `oa-demo-root`: the widget's frame,
 * and every portal (dialog, popover, select menu) it renders under <body>, which markPortalRoots
 * tags as it appears. The `dark` class on <html> switches the theme. While mounted, every
 * `/api/*` request on the page is answered by the widget (mock-api.ts).
 */
export const schemaVersion = DEMO_SCHEMA_VERSION

export interface MountOptions {
  snapshot: DemoSnapshot
  answers: DemoAnswers
  pages?: DemoPages
  api?: DemoApi
  /** The page to open first. */
  initialPath?: string
  /** Fires after each navigation with the app's path (no basePath); the host may mirror it into
   *  its own URL (`replace` when the app replaced its history entry rather than adding one). */
  onNavigate?: (href: string, opts: { replace: boolean }) => void
  /**
   * The host path the demo lives under (`/demo`). Every link the widget renders is written with
   * it (`/demo/companies/<id>`), so a new tab, a middle-click, a copied link or a crawler reaches
   * the demo page rather than the host's bare `/companies/<id>`. Without it hrefs are the app's paths.
   */
  basePath?: string
  /** The host URL for an app href, when a prefix is not enough. Wins over basePath. */
  hrefFor?: (appHref: string) => string
  /** Replaces the mock for `/api/*` (the recorder proxies to a live app through this). */
  fetch?: AppFetch
  /** A request nothing could answer; the check script collects these. */
  onMiss?: (key: string) => void
  /** `card` (default): a bordered frame of fixed height. `page`: fills the mount element. */
  chrome?: 'card' | 'page'
  /** Fires once the first page is in the DOM: a host showing prerendered HTML swaps it out here. */
  onReady?: () => void
  /** Where the header's "Exit demo" goes (the app's sign-out, in the demo). Default: the host's `/`. */
  exitHref?: string
  /** The host's theme storage key (next-themes' `storageKey`), so the demo's System / Light /
   *  Dark control and the host read and write one setting. */
  themeStorageKey?: string
}

export function mount(el: HTMLElement, opts: MountOptions): { unmount: () => void; navigate: (href: string) => void } {
  if (opts.snapshot.schemaVersion !== DEMO_SCHEMA_VERSION) {
    throw new Error(`Snapshot schema ${opts.snapshot.schemaVersion} does not match widget schema ${DEMO_SCHEMA_VERSION}`)
  }
  const data = { snapshot: opts.snapshot, answers: opts.answers, pages: opts.pages ?? EMPTY_PAGES, api: opts.api ?? EMPTY_API }
  // One notice however many requests a click sends, and it says what the visitor needs to know:
  // the button worked, the demo just does not keep changes. Components that show the error
  // inline show mock-api.ts's READ_ONLY sentence.
  const onWrite = () => toast('Read-only demo', { id: 'oa-demo-read-only', description: 'Nothing you change here is saved. In your own installation it would be.' })
  const demoFetch = opts.fetch ?? createDemoFetch({ snapshot: data.snapshot, answers: data.answers, api: data.api, onMiss: opts.onMiss, onWrite })
  // Before the first render: a page's own effects fetch on mount, and they run before any effect
  // of the component that would otherwise install this.
  const restore = interceptApiFetch(demoFetch)
  initDemoTheme(opts.themeStorageKey)
  const stopMarking = markPortalRoots()

  let navigateTo: (href: string, opts?: { replace?: boolean }) => void = () => {}
  const root: Root = createRoot(el)
  root.render(
    <DemoApp
      data={data}
      fetch={demoFetch}
      initialPath={opts.initialPath}
      onNavigate={opts.onNavigate}
      exposeNavigate={fn => { navigateTo = fn }}
      chrome={opts.chrome}
      onReady={opts.onReady}
      exit={{ href: opts.exitHref ?? '/', label: 'Exit demo' }}
      basePath={opts.basePath}
      hrefFor={opts.hrefFor}
    />,
  )
  // The other sections, while the visitor reads the first page.
  prefetchSections()
  return {
    navigate: href => navigateTo(href),
    unmount: () => {
      root.unmount()
      restore()
      stopMarking()
    },
  }
}

/**
 * Radix renders dialogs, popovers and menus into <body>, outside the frame, and Recharts appends
 * a hidden element there to measure text. Anything the page adds to <body> while the widget is
 * mounted is the widget's, so it gets the root class and the app's styles; what was there before
 * (the host's own markup) is left alone.
 *
 * The class goes on AS the element is inserted, not after: Recharts measures the moment its
 * element is in the document, and a measurement taken in the host's font sizes the chart's
 * ticks wrongly for the life of the page. So body's insertion methods are wrapped for the
 * duration of the mount; the observer catches anything inserted another way.
 */
function markPortalRoots(): () => void {
  const body = document.body
  const before = new Set(Array.from(body.children))
  const mark = (n: unknown) => { if (n instanceof HTMLElement && !before.has(n) && n.tagName !== 'SCRIPT') n.classList.add('oa-demo-root') }
  const originals = { appendChild: body.appendChild, insertBefore: body.insertBefore, append: body.append, prepend: body.prepend }
  body.appendChild = function <T extends Node>(node: T): T { mark(node); return originals.appendChild.call(this, node) as T }
  body.insertBefore = function <T extends Node>(node: T, ref: Node | null): T { mark(node); return originals.insertBefore.call(this, node, ref) as T }
  body.append = function (...nodes: (Node | string)[]) { nodes.forEach(mark); return originals.append.apply(this, nodes) }
  body.prepend = function (...nodes: (Node | string)[]) { nodes.forEach(mark); return originals.prepend.apply(this, nodes) }
  const observer = new MutationObserver(records => { for (const r of records) r.addedNodes.forEach(mark) })
  observer.observe(body, { childList: true })
  return () => {
    observer.disconnect()
    Object.assign(body, originals)
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) delete (body as any)[k]
  }
}

/** Every URL the widget serves for this data; what scripts/demo-record.mjs and demo-check.mjs walk. */
export function routes(snapshot: DemoSnapshot, pages?: DemoPages): string[] {
  return allHrefs(snapshot, pages ?? EMPTY_PAGES)
}

declare global {
  interface Window { PortfolioDemo?: { mount: typeof mount; routes: typeof routes; schemaVersion: number } }
}

// The host reaches the widget through the global, not through the module's exports: a static
// site can add a <script type="module"> but not import from it at build time.
if (typeof window !== 'undefined') window.PortfolioDemo = { mount, routes, schemaVersion }
