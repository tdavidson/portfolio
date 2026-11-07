// The membership check the diligence round routes share: a signed-in member of the fund that owns
// the deal. Roles and domains are checked before the handler runs (proxy.ts, lib/access).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function ensureDealMember(dealId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  const fundId = (membership as any).fund_id as string
  const { data: deal } = await (admin as any).from('diligence_deals').select('id').eq('id', dealId).eq('fund_id', fundId).maybeSingle()
  if (!deal) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { admin, fundId, userId: user.id }
}
