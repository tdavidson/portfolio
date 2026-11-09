import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Link from './stubs/next-link'
import { createLinker, LinkerProvider } from './hrefs'

/**
 * The hrefs the widget writes (hrefs.ts). The host mounts it under a path of its own (`/demo`),
 * and a link opened in a new tab or by a crawler follows the href itself, so the href must be the
 * host's URL while the click handler still navigates by the app's path.
 */
describe('demo widget hrefs', () => {
  const demo = createLinker({ basePath: '/demo/' })

  it('writes app paths under basePath and reads them back', () => {
    expect(demo.resolve('/companies/company-a?tab=metrics')).toEqual({ href: '/demo/companies/company-a?tab=metrics', appHref: '/companies/company-a?tab=metrics', hidden: false })
    expect(demo.resolve('/').href).toBe('/demo')
    expect(demo.toApp('/demo/companies/company-a?tab=metrics')).toBe('/companies/company-a?tab=metrics')
    expect(demo.toApp('/demo')).toBe('/')
    expect(demo.toApp('/demo?x=1')).toBe('/?x=1')
    // Not this base: a sibling path that only starts with the same letters.
    expect(demo.toApp('/demonstration')).toBe('/demonstration')
  })

  it('leaves external, hash, mailto and API hrefs alone', () => {
    for (const href of ['https://example.com/x', '//cdn.example/x', '#top', 'mailto:someone@example.com', '/api/companies']) {
      expect(demo.resolve(href)).toEqual({ href, appHref: null, hidden: false })
    }
  })

  it('takes hrefFor over basePath', () => {
    const custom = createLinker({ basePath: '/demo', hrefFor: h => `https://site.example/try${h}` })
    expect(custom.resolve('/deals').href).toBe('https://site.example/try/deals')
  })

  it('hides links to pages the demo does not serve, and inlines the template downloads', () => {
    expect(demo.resolve('/lps/preview').hidden).toBe(true)
    const t = demo.resolve('/templates/investments-import.csv')
    expect(t.href.startsWith('data:text/csv;charset=utf-8,')).toBe(true)
    expect(t.download).toBe('investments-import.csv')
  })

  it('writes the host href from the next/link stub, with the app path beside it', () => {
    const html = renderToStaticMarkup(
      <LinkerProvider value={demo}>
        <Link href="/deals">Deals</Link>
        <Link href="/lps/preview">Preview</Link>
      </LinkerProvider>,
    )
    expect(html).toContain('href="/demo/deals" data-app-href="/deals"')
    expect(html).toMatch(/href="\/demo\/lps\/preview"[^>]*style="display:none"/)
  })

  it('writes app paths when mounted without a basePath', () => {
    expect(renderToStaticMarkup(<Link href="/deals">Deals</Link>)).toContain('href="/deals"')
  })
})
