import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { engagementActivity } from '@/lib/access/engagements'

// What an engagement's people did: the books' audit trail merged with the activity log, for
// everyone ever assigned to it. Admin-only.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const { id } = await params
  const { data: engagement } = await (admin as any).from('engagements')
    .select('id, member_history').eq('id', id).eq('fund_id', gate.fundId).maybeSingle()
  if (!engagement) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 })

  const limit = Number(req.nextUrl.searchParams.get('limit')) || undefined
  const events = await engagementActivity(admin, { fundId: gate.fundId, memberIds: engagement.member_history ?? [], limit })
  return NextResponse.json({ events })
}
