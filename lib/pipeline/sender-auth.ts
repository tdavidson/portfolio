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
 * Postmark: the topmost Authentication-Results (the one Postmark's own server added; lower ones
 * came with the message and prove nothing) shows DMARC pass, or a DKIM or SPF pass for a domain
 * aligned with From. Without that header, a Received-SPF pass whose envelope sender is aligned.
 */
export function postmarkSenderVerified(from: string, headers: Header[] | null | undefined): boolean {
  const fromDomain = domainOf(from)
  if (!fromDomain || !Array.isArray(headers)) return false
  const named = (n: string) => headers.find(h => h?.Name?.toLowerCase() === n)?.Value ?? null
  const results = named('authentication-results')
  if (results) {
    const lower = results.toLowerCase()
    if (/\bdmarc=pass\b/.test(lower)) return true
    for (const m of lower.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=([^\s;]+)/g)) if (aligned(fromDomain, m[1])) return true
    for (const m of lower.matchAll(/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=([^\s;]+)/g)) if (aligned(fromDomain, m[1])) return true
    return false
  }
  const spf = named('received-spf')
  if (spf && /^\s*pass\b/i.test(spf)) {
    const m = spf.match(/envelope-from=["<]?([^\s">;]+)/i)
    return aligned(fromDomain, m?.[1])
  }
  return false
}
