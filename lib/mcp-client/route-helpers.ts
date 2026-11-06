import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { siteOrigin } from '@/lib/site-links'

/** The signed-in member and their fund, for the per-user connector routes. */
export async function connectorMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return {
    admin,
    fundId: (membership as any).fund_id as string,
    userId: user.id,
    isAdmin: (membership as any).role === 'admin',
  }
}

/**
 * The callback URL registered with the connector's sign-in server. Built from the deployment's
 * configured origin, never the request's Host header, and identical at connect and at callback:
 * the token endpoint compares the two exactly.
 */
export function connectorRedirectUri(serverId: string): string {
  let origin = siteOrigin()
  if (origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
    origin = origin.replace(/^http:\/\//, 'https://')
  }
  return `${origin}/api/settings/connectors/${serverId}/callback`
}
