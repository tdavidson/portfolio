// Is an inbound email really from the address in its From header? The From header is the sender's
// own claim; SPF, DKIM and DMARC are what the receiving server checked. Mail that is not shown to be
// from that domain is still accepted from an authorized sender, but never gets a member's treatment
// (the receipt branch, interactions, skipping the authorized-senders list).

import type { ResendAuthentication } from '@/lib/resend/inbound'

const domainOf = (address: string) => address.split('@')[1]?.trim().toLowerCase().replace(/>$/, '') ?? ''

/** `d` is the From domain or a parent of it (relaxed alignment, as DMARC defines it). */
function aligned(fromDomain: string, d: string | undefined): boolean {
  const x = (d ?? '').trim().toLowerCase().replace(/^.*@/, '')
  return !!x && !!fromDomain && (fromDomain === x || fromDomain.endsWith(`.${x}`) || x.endsWith(`.${fromDomain}`))
}

/** Resend: DMARC passed, so SPF or DKIM passed aligned with the From domain. */
export function resendSenderVerified(auth: ResendAuthentication | null): boolean {
  return auth?.dmarc === 'pass'
}

type Header = { Name?: string; Value?: string }

/**
 * The authserv-ids (RFC 8601) of the receiving servers whose Authentication-Results we trust, from
 * POSTMARK_AUTHSERV_IDS (comma-separated). Empty by default.
 */
export function trustedAuthservIds(raw: string | undefined = process.env.POSTMARK_AUTHSERV_IDS): string[] {
  return (raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

/** The authserv-id an Authentication-Results value names: the token before the first ';'. */
function authservIdOf(value: string): string {
  return (value.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

/**
 * Postmark: the sender's address is shown to be real by
 *   - an Authentication-Results header written by a server we trust (its authserv-id is in
 *     `trustedIds`), showing DMARC pass or a DKIM or SPF pass aligned with From, or
 *   - the first Received-SPF header (Postmark's own check) passing for an aligned envelope sender.
 *
 * Any other Authentication-Results header is ignored, as RFC 8601 section 5 asks. A sender can put
 * one in the message themselves, and Postmark's inbound processing doesn't write its own, so
 * "the topmost one" can be the sender's. Reading it would let a spoofer claim `dmarc=pass`.
 */
export function postmarkSenderVerified(
  from: string,
  headers: Header[] | null | undefined,
  trustedIds: string[] = trustedAuthservIds(),
): boolean {
  const fromDomain = domainOf(from)
  if (!fromDomain || !Array.isArray(headers)) return false
  const named = (n: string) => headers.filter(h => h?.Name?.toLowerCase() === n).map(h => h.Value ?? '')

  for (const results of named('authentication-results')) {
    if (!trustedIds.includes(authservIdOf(results))) continue
    const lower = results.toLowerCase()
    if (/\bdmarc=pass\b/.test(lower)) return true
    for (const m of lower.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=([^\s;]+)/g)) if (aligned(fromDomain, m[1])) return true
    for (const m of lower.matchAll(/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=([^\s;]+)/g)) if (aligned(fromDomain, m[1])) return true
  }

  const spf = named('received-spf')[0]
  if (spf && /^\s*pass\b/i.test(spf)) {
    const m = spf.match(/envelope-from=["<]?([^\s">;]+)/i)
    return aligned(fromDomain, m?.[1])
  }
  return false
}
