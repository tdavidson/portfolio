import type { createAdminClient } from '@/lib/supabase/admin'

type Supabase = ReturnType<typeof createAdminClient>

export interface DiligenceDealRef {
  id: string
  name: string
  aliases: string[] | null
  /** Domains associated with the deal, resolved via the inbound_deals it was promoted from. */
  domains: string[]
}

export interface DealMatch {
  deal: DiligenceDealRef
  /** How the match was made — determines whether we trust it without an LLM. */
  basis: 'sender_domain' | 'name' | 'alias'
  confidence: 'high' | 'medium'
}

/**
 * Load the fund's active diligence deals along with any domains we know about.
 *
 * Domains come from `inbound_deals.company_domain` via `promoted_diligence_id`:
 * when a deal is promoted out of the screening pipeline, that row already
 * carries the founder's email domain. `diligence_deals` itself has no domain
 * column, so this join is the only place that knowledge lives.
 */
export async function loadActiveDiligenceDeals(
  supabase: Supabase,
  fundId: string,
  /**
   * The forwarding member's entities (null = every record: the email came from outside, to the
   * fund's inbox). Required: a member's forward may only route to diligence they can see.
   */
  visibleVehicleIds: string[] | null,
): Promise<DiligenceDealRef[]> {
  let query = supabase
    .from('diligence_deals')
    .select('id, name, aliases')
    .eq('fund_id', fundId)
    .eq('deal_status', 'active')
  // Filtered only for a scoped member: vehicle_id exists once the entity migration has run.
  if (visibleVehicleIds !== null) query = query.in('vehicle_id' as any, visibleVehicleIds)
  const { data: deals } = await query.limit(200)

  const rows = (deals ?? []) as Array<{ id: string; name: string; aliases: string[] | null }>
  if (rows.length === 0) return []

  const { data: inbound } = await supabase
    .from('inbound_deals')
    .select('promoted_diligence_id, company_domain')
    .eq('fund_id', fundId)
    .in('promoted_diligence_id', rows.map(r => r.id))

  const domainsByDeal = new Map<string, string[]>()
  for (const r of ((inbound as any[]) ?? [])) {
    const dealId = r.promoted_diligence_id as string | null
    const domain = normalizeDomain(r.company_domain as string | null)
    if (!dealId || !domain) continue
    const list = domainsByDeal.get(dealId) ?? []
    if (!list.includes(domain)) list.push(domain)
    domainsByDeal.set(dealId, list)
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases,
    domains: domainsByDeal.get(r.id) ?? [],
  }))
}

/**
 * Deterministic pre-check: can we tie this email to a diligence deal without
 * asking a model?
 *
 * The sender's domain is the strongest signal available — an email from
 * @acme.com about a deal whose known domain is acme.com is not a coincidence.
 * Name matching is weaker and only trusted on a whole-word hit in the subject,
 * because a deal called "Notion" would otherwise match half the inbox.
 *
 * Returns null when nothing matches; the classifier is then the only source of
 * a diligence route, and its match still gets confirmed by a human.
 */
export function matchDiligenceDeal(params: {
  senderEmail: string
  /** Original sender when the mail was forwarded — often the real counterparty. */
  forwardedFromEmail?: string | null
  subject: string
  deals: DiligenceDealRef[]
}): DealMatch | null {
  const { deals, subject } = params
  if (deals.length === 0) return null

  const senderDomain = domainOf(params.senderEmail)
  const forwardedDomain = domainOf(params.forwardedFromEmail ?? '')

  // 1. Sender (or original forwarded sender) domain matches a known deal domain.
  for (const deal of deals) {
    for (const domain of deal.domains) {
      if (domain && (domain === senderDomain || domain === forwardedDomain)) {
        return { deal, basis: 'sender_domain', confidence: 'high' }
      }
    }
  }

  // 2. Deal name / alias appears as a whole word in the subject.
  const subjectLower = ` ${subject.toLowerCase()} `
  const candidates: DealMatch[] = []
  for (const deal of deals) {
    const names: Array<{ value: string; basis: 'name' | 'alias' }> = [
      { value: deal.name, basis: 'name' },
      ...((deal.aliases ?? []).map(a => ({ value: a, basis: 'alias' as const }))),
    ]
    for (const { value, basis } of names) {
      const needle = value.trim().toLowerCase()
      // Two-character deal names ("X") produce garbage matches; require enough
      // signal to be meaningful.
      if (needle.length < 3) continue
      if (wholeWordMatch(subjectLower, needle)) {
        candidates.push({ deal, basis, confidence: 'medium' })
        break
      }
    }
  }

  // Ambiguity is a reason to defer to a human, not to guess. Two deals matching
  // the same subject means we genuinely don't know which one it is.
  if (candidates.length === 1) return candidates[0]

  return null
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  if (at === -1) return ''
  return normalizeDomain(email.slice(at + 1)) ?? ''
}

function normalizeDomain(domain: string | null): string | null {
  if (!domain) return null
  const d = domain.trim().toLowerCase().replace(/^www\./, '')
  if (!d || !d.includes('.')) return null
  // Free mail providers tell us nothing about which company an email is about —
  // a founder writing from gmail would otherwise match whichever deal happened
  // to have gmail.com stored as its domain.
  if (FREE_MAIL.has(d)) return null
  return d
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com',
  'msn.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com',
])

function wholeWordMatch(haystackPadded: string, needle: string): boolean {
  // Escape regex metacharacters — a deal name can legitimately contain '.', '+'
  // or '(' (e.g. "Notion.so", "C++ Tools"), which would otherwise be treated as
  // a pattern and either throw or match the wrong thing.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystackPadded)
}
