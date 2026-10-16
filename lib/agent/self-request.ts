// A request from one of this deployment's functions to another of its own routes.
//
// The agent surface (/api/mcp, /api/agent) does not ship headless Chromium (lib/pdf-routes.mjs):
// the binary is ~67 MB and every function that carries it pays for it. When a chat needs a PDF
// rendered (an LP statement attached to an email) or notices published (each one a rendered PDF),
// it asks a route that does ship it, over HTTP, with a signed short-lived token naming the member
// and the exact work. That route trusts the token only to say who asked for what, and re-checks
// the member's live access itself (app/api/agent/reports/[token], app/api/agent/call-notices/publish).
//
// The origin is the one the caller reached (the tool context's), else the configured site origin.
// A caller who sends an odd Host header only points the request, and its token, at a host of
// their choosing: the token grants nothing beyond what that same caller could ask for directly.

import { siteOrigin } from '@/lib/site-links'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The origin to reach this deployment at, without a trailing slash. */
export function selfOrigin(origin?: string | null): string {
  return (origin || siteOrigin()).replace(/\/$/, '')
}

/**
 * Headers every self-request carries. On Vercel, a deployment behind Deployment Protection
 * (previews, usually) answers its own functions with the protection page unless the request
 * carries the automation bypass secret, which Vercel sets in the environment when it is enabled.
 */
export function selfRequestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return { ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}), ...extra }
}

/** The `error` of a JSON error body, or the status line: something a person can act on. */
export async function responseError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null
  const message = typeof body?.error === 'string' && body.error ? body.error : res.statusText || 'no detail'
  return `HTTP ${res.status}: ${message}`
}
