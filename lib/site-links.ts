/**
 * Where the product lives outside this deployment.
 *
 * One module so the footer, the support page, the sign-in pages and the settings
 * version card agree, and so a self-hoster can find every outbound link in one
 * place. The product is Portfolio; the company behind it is Hemrock. A fund's own
 * deployment has neither name in its UI beyond these links, which is the point of
 * the fund-themeable `--primary` and the fixed `--brand` (DESIGN.md).
 *
 * The legal pages are env-driven: a fund that redeploys under its own name has its
 * own terms, or none, and a link to someone else's is worse than no link. Unset
 * means the links do not render.
 */
export const PRODUCT_NAME = 'Portfolio'
export const PRODUCT_SITE = 'https://www.hemrock.com/portfolio'
export const PRODUCT_DOCS = 'https://www.hemrock.com/docs/reporting'
export const PRODUCT_REPO = 'https://github.com/tdavidson/reporting'
export const PRODUCT_LICENSE = `${PRODUCT_REPO}/blob/main/LICENSE.md`
export const PRODUCT_RELEASES = `${PRODUCT_REPO}/releases`
export const PRODUCT_ISSUES = `${PRODUCT_REPO}/issues`
export const PRODUCT_DEMO = 'https://www.hemrock.com/demo'

export const COMPANY_NAME = 'Hemrock'
export const COMPANY_SITE = 'https://www.hemrock.com'
export const COMPANY_CONTACT = 'https://www.hemrock.com/contact'
export const COMPANY_EMAIL = 'hello@hemrock.com'

export const TERMS_URL = process.env.NEXT_PUBLIC_TERMS_URL || null
export const PRIVACY_URL = process.env.NEXT_PUBLIC_PRIVACY_URL || null

/**
 * The deployment's own public origin, without a trailing slash.
 *
 * NEXT_PUBLIC_SITE_URL first (what DOCS.md tells an installer to set), then
 * NEXT_PUBLIC_APP_URL (the older name, still honoured), then the host's own
 * production URL, then localhost. Never a hardcoded domain: this codebase is
 * installed under many.
 */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/$/, '')
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  return 'http://localhost:3000'
}

/**
 * The origin the browser used to reach this request, for absolute redirects.
 *
 * Behind a reverse proxy, `next start -H <address> -p <port>` reports its own listen address as
 * the origin of `request.url` (Next prefers it to the Host header), so a redirect built from
 * `request.url` sends the browser to https://localhost:3100. The proxy's forwarded host, or the
 * Host header it passes on, is the address the browser used; issuerFor (lib/oauth/metadata.ts)
 * reads them the same way. On Vercel and in local development they agree with `request.url`.
 */
export function requestOrigin(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(',')[0].trim() || null
  const host = first('x-forwarded-host') ?? first('host')
  if (!host) return new URL(req.url).origin
  const proto = first('x-forwarded-proto')
    ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

/** The bare host of siteOrigin(), for display (the OG image footer). */
export function siteHost(): string {
  try {
    return new URL(siteOrigin()).host
  } catch {
    return 'localhost:3000'
  }
}
