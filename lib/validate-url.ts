import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

type ValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * Validates the OpenRouter base URL (the one custom AI endpoint a fund can set, in Settings) to
 * prevent SSRF: the server fetches it with the fund's key, so it must not reach inside the network.
 *
 * Allows: public IPs and hostnames, over HTTP(S).
 *
 * Blocks:
 * - Loopback: localhost, *.localhost, 127.0.0.0/8, ::1 (there is no self-hosted provider any more)
 * - Cloud metadata endpoints (169.254.x.x, fe80::/10)
 * - Private network ranges (10.x, 172.16-31.x, 192.168.x, 100.64/10, 198.18/15, 192.0.0/24, fc00::/7,
 *   and NAT64 64:ff9b::/96 judged by its embedded IPv4), 0.0.0.0/8,
 *   multicast/reserved, and IPv4-mapped IPv6 forms of any of these (`[::ffff:169.254.169.254]`)
 * - Non-HTTP(S) protocols
 * - URLs without a valid hostname
 *
 * This is the SYNCHRONOUS, literal-only check: a hostname is not resolved. Wherever the URL is
 * saved or fetched, use `validateBaseUrlResolved`, which also resolves the hostname and checks
 * every address it returns — otherwise `internal.example` pointing at 10.0.0.5 passes.
 */
export function validateBaseUrl(input: string): ValidationResult {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, error: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are allowed' }
  }

  const host = normalizeHost(parsed.hostname)
  if (!host) {
    return { ok: false, error: 'URL must include a hostname' }
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, error: 'Loopback addresses are not allowed' }
  }

  const blocked = blockedAddressReason(host)
  if (blocked) return { ok: false, error: blocked }

  return { ok: true, url: input }
}

/**
 * `validateBaseUrl`, plus DNS: a hostname is resolved (every A/AAAA record) and refused if ANY
 * address lands in a blocked range. Used where the URL is saved (settings) and where it is about
 * to be fetched (lib/ai) — the second matters because DNS can change after the URL was saved.
 *
 * Residual risk: the fetch does its own lookup, so a rebinding server that answers public here and
 * private a moment later is not covered; closing that needs a pinned-address agent.
 */
export async function validateBaseUrlResolved(
  input: string,
  lookup: (host: string) => Promise<{ address: string; family: number }[]> = host => dnsLookup(host, { all: true, verbatim: true }),
): Promise<ValidationResult> {
  const literal = validateBaseUrl(input)
  if (!literal.ok) return literal

  const host = normalizeHost(new URL(input).hostname)
  if (isIP(host)) return literal

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host)
  } catch {
    return { ok: false, error: 'Could not resolve the URL\'s hostname' }
  }
  if (addresses.length === 0) return { ok: false, error: 'Could not resolve the URL\'s hostname' }
  for (const { address } of addresses) {
    const blocked = blockedAddressReason(normalizeHost(address))
    if (blocked) return { ok: false, error: `${blocked} (the hostname resolves to one)` }
  }
  return literal
}

// ---------------------------------------------------------------------------------------------

/** URL.hostname keeps IPv6 brackets (`[::1]`) and a trailing root dot; strip both, lowercase. */
function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/** Why an IP literal is refused, or null when it is a public address (or not an IP at all). */
export function blockedAddressReason(host: string): string | null {
  const kind = isIP(host)
  if (kind === 4) return blockedV4(host.split('.').map(Number))
  if (kind === 6) return blockedV6(host)
  if (host.includes('%')) return 'Scoped IPv6 addresses are not allowed'
  return null
}

function blockedV4([a, b, c]: number[]): string | null {
  if (a === 0) return 'Invalid address'
  if (a === 127) return 'Loopback addresses are not allowed'
  if (a === 169 && b === 254) return 'Link-local addresses are not allowed'
  if (a === 10) return 'Private network addresses are not allowed'
  if (a === 172 && b >= 16 && b <= 31) return 'Private network addresses are not allowed'
  if (a === 192 && b === 168) return 'Private network addresses are not allowed'
  if (a === 100 && b >= 64 && b <= 127) return 'Private network addresses are not allowed'
  if (a === 198 && (b === 18 || b === 19)) return 'Private network addresses are not allowed' // 198.18/15, benchmarking
  if (a === 192 && b === 0 && c === 0) return 'Reserved addresses are not allowed' // 192.0.0/24, IETF protocol assignments
  if (a >= 224) return 'Multicast and reserved addresses are not allowed'
  return null
}

/** Expand an IPv6 literal to its eight 16-bit groups (embedded dotted IPv4 tail included). */
function expandV6(host: string): number[] | null {
  let h = host
  const tail: number[] = []
  const dotted = h.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const o = dotted[1].split('.').map(Number)
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3])
    h = h.slice(0, -dotted[1].length)
    if (h.endsWith(':') && !h.endsWith('::')) h = h.slice(0, -1)
  }
  const parse = (s: string) => (s ? s.split(':').map(x => parseInt(x, 16)) : [])
  const want = 8 - tail.length
  let groups: number[]
  if (h.includes('::')) {
    const [l, r] = h.split('::')
    const left = parse(l)
    const right = parse(r)
    groups = [...left, ...Array(Math.max(0, want - left.length - right.length)).fill(0), ...right]
  } else {
    groups = parse(h)
  }
  groups = [...groups, ...tail]
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

function blockedV6(host: string): string | null {
  const g = expandV6(host)
  if (!g) return 'Invalid address'
  const zeroPrefix = (n: number) => g.slice(0, n).every(x => x === 0)

  if (zeroPrefix(8)) return 'Invalid address' // ::
  // ::1, written literally or resolved from a hostname.
  if (zeroPrefix(7) && g[7] === 1) return 'Loopback addresses are not allowed'
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d): judge the v4.
  if (zeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) {
    return blockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
  }
  // NAT64 (64:ff9b::/96, and the local-use 64:ff9b:1::/48): the last 32 bits are an IPv4 address a
  // NAT64 gateway reaches on our behalf, so judge that address.
  if (g[0] === 0x64 && g[1] === 0xff9b && (g.slice(2, 6).every(x => x === 0) || g[2] === 1)) {
    return blockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'Private IPv6 addresses are not allowed' // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'Link-local addresses are not allowed' // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return 'Multicast and reserved addresses are not allowed' // ff00::/8
  return null
}
