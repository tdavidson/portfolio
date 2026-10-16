import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthBrandProvider, AuthWordmark } from '@/components/auth-brand'
import { MARK_PATHS } from '@/lib/brand-mark'

/**
 * The signed-out screens show the fund's sign-in logo and text from Settings → Fund. Unset, they
 * show Hemrock's mark and no words at all: not "Portfolio", not "Hemrock".
 */
const render = (brand?: { logo: string | null; title: string | null }) =>
  renderToStaticMarkup(brand ? createElement(AuthBrandProvider, { brand, children: createElement(AuthWordmark) }) : createElement(AuthWordmark))

describe('the sign-in mark', () => {
  it("is Hemrock's mark with no text by default", () => {
    for (const html of [render(), render({ logo: null, title: null })]) {
      expect(html).toContain(MARK_PATHS[0].d)
      expect(html).not.toContain('<h1')
      expect(html).not.toMatch(/>[^<]*(Portfolio|Hemrock)[^<]*</)
    }
  })

  it("shows the fund's logo in place of the mark, and its text under it, when set", () => {
    const html = render({ logo: 'data:image/png;base64,AAAA', title: 'Ashgrove Capital' })
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).not.toContain(MARK_PATHS[0].d)
    expect(html).toContain('<h1 class="text-lg font-semibold tracking-tight">Ashgrove Capital</h1>')
  })
})
