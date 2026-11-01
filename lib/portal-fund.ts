import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { FundTheme } from '@/lib/theme'

export interface PortalFund {
  fundId: string
  name: string
  logoUrl: string | null
  theme: FundTheme | null
}

/**
 * Resolve the fund behind the current LP user, for portal branding (logo, name,
 * per-fund theme). LP accounts aren't fund-scoped directly — the fund comes from
 * the investor(s) the account is linked to. Returns null if the user isn't an LP
 * or no fund can be resolved (the portal then falls back to a generic header).
 */
export async function getPortalFund(): Promise<PortalFund | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // LP tables aren't in the generated DB types; use an untyped client (matches
  // resolveLpAccess, which takes the generic SupabaseClient).
  const admin = createAdminClient() as any
  const { data: account } = await admin
    .from('lp_accounts')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (!account) return null
  const accountId = (account as { id: string }).id

  // Direct link first, then a delegated (authorized-user) link.
  // A link disabled in its fund (lp_account_links.disabled_at) does not count.
  const { data: linkRows } = await admin
    .from('lp_account_links')
    .select('*')
    .eq('lp_account_id', accountId)
  const link = ((linkRows ?? []) as { lp_investor_id: string; disabled_at?: string | null }[]).find(l => !l.disabled_at) ?? null
  let investorId = link?.lp_investor_id
  if (!investorId) {
    const { data: del } = await admin
      .from('lp_authorized_users')
      .select('lp_investor_id')
      .eq('authorized_user_account_id', accountId)
      .limit(1)
      .maybeSingle()
    investorId = (del as { lp_investor_id: string } | null)?.lp_investor_id
  }
  if (!investorId) return null

  const { data: inv } = await admin
    .from('lp_investors')
    .select('fund_id')
    .eq('id', investorId)
    .maybeSingle()
  const fundId = (inv as { fund_id: string } | null)?.fund_id
  if (!fundId) return null

  const [{ data: fund }, { data: fs }] = await Promise.all([
    admin.from('funds').select('name, logo_url').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('theme').eq('fund_id', fundId).maybeSingle(),
  ])

  return {
    fundId,
    name: (fund as any)?.name ?? 'Investor Portal',
    logoUrl: (fund as any)?.logo_url ?? null,
    theme: ((fs as any)?.theme ?? null) as FundTheme | null,
  }
}
