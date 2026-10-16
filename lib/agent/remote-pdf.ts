// The PDF renderers lp_send_item attaches with, for a function that does not ship Chromium.
//
// The send route renders in-process (app/api/lps/send: generateInvestorReportPdf and
// generateLetterPdf). The agent surface cannot, so it signs a report link for the acting member
// (lib/agent/report-links.ts) and downloads the PDF from the route that renders those links,
// app/api/agent/reports/[token], which is in lib/pdf-routes.mjs. The same render functions run
// there, with the same arguments, so the attachment is the one the app would send — and that route
// re-checks the member's live access before rendering, as it does for every link.
//
// A failure throws. sendPortalItem then counts that recipient as failed (a snapshot) or refuses
// the send (a letter): an email the person asked to carry a statement never goes out without it.

import type { SendPdfRenderers } from '@/lib/lps/outreach'
import { reportLinkUrl, signReportLink, type ReportKind } from './report-links'
import { responseError, selfOrigin, selfRequestHeaders, type FetchLike } from './self-request'

/** Marks a report link minted for an attachment: the reports route rate-limits these on their own. */
export const SEND_ATTACHMENT_PURPOSE = 'lp_send'

export class RemotePdfError extends Error {}

/** `filename="..."` from a Content-Disposition header (the reports route always sets one). */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim()
  return name || null
}

export interface RemoteRendererOptions {
  /** The member the send runs as: the link names them, and the route re-checks their access. */
  userId: string
  /** The origin the caller reached (AgentToolContext.origin); else the configured site origin. */
  origin?: string
  fetch?: FetchLike
}

/**
 * SendPdfRenderers that fetch each PDF from this deployment's report-link route. `errors` collects
 * what went wrong, so the tool can say why a recipient failed rather than only that they did.
 */
export function remotePdfRenderers(opts: RemoteRendererOptions): SendPdfRenderers & { errors: string[] } {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init))
  const errors: string[] = []

  async function download(fundId: string, kind: ReportKind, args: Record<string, string | string[]>, what: string) {
    const { token } = signReportLink({ fundId, userId: opts.userId, kind, args: { ...args, for: SEND_ATTACHMENT_PURPOSE } })
    const url = reportLinkUrl(selfOrigin(opts.origin), token)
    let res: Response
    try {
      res = await doFetch(url, { method: 'GET', headers: selfRequestHeaders({ accept: 'application/pdf' }), cache: 'no-store' })
    } catch (e) {
      throw fail(`Could not reach the PDF renderer for ${what}: ${(e as Error)?.message ?? 'network error'}.`)
    }
    if (!res.ok) throw fail(`Could not render ${what} (${await responseError(res)}).`)
    if (!String(res.headers.get('content-type') ?? '').includes('application/pdf')) {
      throw fail(`Could not render ${what}: the renderer answered with ${res.headers.get('content-type') || 'no content type'}, not a PDF.`)
    }
    const pdf = Buffer.from(await res.arrayBuffer())
    if (pdf.length === 0) throw fail(`Could not render ${what}: the renderer returned an empty file.`)
    return { pdf, fileName: dispositionFileName(res.headers.get('content-disposition')) ?? 'Document.pdf' }
  }

  function fail(message: string): RemotePdfError {
    errors.push(message)
    return new RemotePdfError(message)
  }

  return {
    errors,
    // As generateInvestorReportPdf: nothing to render for no investors.
    snapshotPdf: async (_admin, { fundId, snapshotId, investorIds }) => {
      if (investorIds.length === 0) return null
      return download(fundId, 'lp_snapshot', { snapshot: snapshotId, investors: investorIds }, 'the statement attachment')
    },
    letterPdf: async (_admin, { fundId, letterId }) =>
      download(fundId, 'lp_letter', { letter: letterId }, 'the letter attachment'),
  }
}
