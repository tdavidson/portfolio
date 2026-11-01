import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { claimableEmailDomain } from '@/lib/onboarding/wizard'

// GET — list this fund's whitelisted email patterns (admin only). Each fund keeps its own list;
// the signup gate accepts an address on any of them.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || membership.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { data: entries } = await admin
    .from('allowed_signups')
    .select('id, email_pattern, created_at')
    .eq('fund_id', membership.fund_id)
    .order('email_pattern')

  return NextResponse.json({ entries: entries ?? [] })
}

// POST — add a whitelist entry to this fund's list (admin only)
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || membership.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { emailPattern } = await req.json()
  if (!emailPattern?.trim()) {
    return NextResponse.json({ error: 'Email pattern is required' }, { status: 400 })
  }

  const pattern = emailPattern.trim().toLowerCase()

  // Validate format: exact email or *@domain.com
  const isExact = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pattern)
  const isWildcard = /^\*@[^\s@]+\.[^\s@]+$/.test(pattern)
  if (!isExact && !isWildcard) {
    return NextResponse.json({
      error: 'Must be an email (user@domain.com) or wildcard (*@domain.com)',
    }, { status: 400 })
  }

  // The signup gate honours every fund's list for the whole deployment, so a wildcard on a consumer
  // mailbox (*@<webmail>) would open signup, and fund creation, to everyone. Name people instead.
  if (isWildcard && !claimableEmailDomain(pattern.replace(/^\*/, ''))) {
    return NextResponse.json({
      error: 'That is a personal email provider. Add people on it one address at a time instead of the whole domain.',
    }, { status: 400 })
  }

  const { error } = await admin
    .from('allowed_signups')
    .insert({ email_pattern: pattern, fund_id: membership.fund_id })

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This pattern already exists' }, { status: 409 })
    }
    return dbError(error, 'settings-whitelist')
  }

  return NextResponse.json({ ok: true })
}
