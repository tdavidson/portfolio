import type { SupabaseClient } from '@supabase/supabase-js'

export interface LpRecipientGroup {
  primaryAccountId: string
  primaryEmail: string
  primaryName: string | null
  investorIds: string[] // selected investors this primary account is linked to
  ccEmails: string[]    // authorized users delegated under this account for those investors
}

/**
 * Resolve who to email for a set of selected investors within a fund.
 *
 * Returns one group per primary LP account (the "To"), each carrying the
 * authorized users (the "Cc") delegated under that account for the selected
 * investors. Disabled accounts and accounts without an email are skipped.
 *
 * Privacy: authorized users are scoped to their principal account, so an
 * authorized user of one LP is never Cc'd on a different LP's email.
 */
export async function resolveLpRecipients(
  admin: SupabaseClient,
  fundId: string,
  investorIds: string[],
): Promise<LpRecipientGroup[]> {
  if (investorIds.length === 0) return []

  // Primary links: investor -> lp_account (scoped to this fund).
  // `*` so this reads the same before 20261101220000; a link disabled in this fund gets no email.
  const { data: allLinks } = await (admin as any)
    .from('lp_account_links')
    .select('*')
    .eq('fund_id', fundId)
    .in('lp_investor_id', investorIds)
  const links = ((allLinks ?? []) as any[]).filter(l => !l.disabled_at)
  if (links.length === 0) return []

  const primaryAccountIds = Array.from(new Set(links.map((l: any) => l.lp_account_id as string)))
  const { data: accounts } = await (admin as any)
    .from('lp_accounts')
    .select('id, email, display_name, status')
    .in('id', primaryAccountIds)
  const acctById = new Map<string, any>((accounts ?? []).map((a: any) => [a.id, a]))

  // Authorized users for the selected investors, grouped by principal account.
  const { data: authRows } = await (admin as any)
    .from('lp_authorized_users')
    .select('principal_lp_account_id, authorized_user_account_id, lp_investor_id')
    .in('lp_investor_id', investorIds)
  const authAccountIds = Array.from(new Set((authRows ?? []).map((a: any) => a.authorized_user_account_id as string)))
  let authAcctById = new Map<string, any>()
  if (authAccountIds.length) {
    const { data: authAccts } = await (admin as any)
      .from('lp_accounts').select('id, email, status').in('id', authAccountIds)
    authAcctById = new Map<string, any>((authAccts ?? []).map((a: any) => [a.id, a]))
  }

  // Build groups keyed by primary account.
  const groups = new Map<string, LpRecipientGroup>()
  for (const l of links as any[]) {
    const acct = acctById.get(l.lp_account_id)
    if (!acct || acct.status === 'disabled' || !acct.email) continue
    let g = groups.get(l.lp_account_id)
    if (!g) {
      g = { primaryAccountId: l.lp_account_id, primaryEmail: acct.email, primaryName: acct.display_name ?? null, investorIds: [], ccEmails: [] }
      groups.set(l.lp_account_id, g)
    }
    if (!g.investorIds.includes(l.lp_investor_id)) g.investorIds.push(l.lp_investor_id)
  }
  // Accumulate, per principal account, each authorized account's delegated
  // investor set (restricted to the group's selected investors). An authorized
  // user is Cc'd ONLY if they're delegated for EVERY investor in that group's
  // email — otherwise a partial delegation would receive another investor's
  // combined figures (the snapshot PDF covers the whole group's investorIds).
  // coverage: principalAccountId -> authAccountId -> { email, ids }
  const coverage = new Map<string, Map<string, { email: string; ids: Set<string> }>>()
  for (const a of (authRows ?? []) as any[]) {
    const g = groups.get(a.principal_lp_account_id)
    if (!g || !g.investorIds.includes(a.lp_investor_id)) continue
    const acct = authAcctById.get(a.authorized_user_account_id)
    if (!acct || acct.status === 'disabled' || !acct.email) continue
    let perPrincipal = coverage.get(a.principal_lp_account_id)
    if (!perPrincipal) { perPrincipal = new Map(); coverage.set(a.principal_lp_account_id, perPrincipal) }
    let entry = perPrincipal.get(a.authorized_user_account_id)
    if (!entry) { entry = { email: acct.email, ids: new Set<string>() }; perPrincipal.set(a.authorized_user_account_id, entry) }
    entry.ids.add(a.lp_investor_id)
  }
  for (const [principalId, perPrincipal] of Array.from(coverage.entries())) {
    const g = groups.get(principalId)
    if (!g) continue
    for (const entry of Array.from(perPrincipal.values())) {
      if (entry.email === g.primaryEmail || g.ccEmails.includes(entry.email)) continue
      if (g.investorIds.every(id => entry.ids.has(id))) g.ccEmails.push(entry.email)
    }
  }

  // The notice email on an entity's profile — a fund administrator's inbox, a family office's
  // operations address — is Cc'd on every send to its investor. It is not a login and sees no
  // more than the investor's own email does.
  const { data: noticeRows } = await (admin as any)
    .from('lp_entities').select('investor_id, notice_email').in('investor_id', investorIds).not('notice_email', 'is', null)
  const noticeByInvestor = new Map<string, string[]>()
  for (const r of (noticeRows ?? []) as { investor_id: string; notice_email: string | null }[]) {
    const e = (r.notice_email ?? '').trim().toLowerCase()
    if (!e) continue
    const list = noticeByInvestor.get(r.investor_id) ?? []
    if (!list.includes(e)) list.push(e)
    noticeByInvestor.set(r.investor_id, list)
  }
  for (const g of Array.from(groups.values())) {
    for (const id of g.investorIds) {
      for (const e of noticeByInvestor.get(id) ?? []) {
        if (e === g.primaryEmail.toLowerCase() || g.ccEmails.includes(e)) continue
        g.ccEmails.push(e)
      }
    }
  }
  return Array.from(groups.values())
}
