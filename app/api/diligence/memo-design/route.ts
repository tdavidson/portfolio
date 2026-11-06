import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { describeDesignTemplate } from '@/lib/memo-agent/design'
import { designSections } from '@/lib/memo-agent/design-sections'

/**
 * The fund's memo design template, read: which sample memo it is, the section headings and first-page
 * fields the export will fill, and those headings as a memo section list (for "Use the template's
 * sections"). `?anchor=<id>` reads a sample memo before it is picked.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = (membership as any).fund_id as string

  const anchor = req.nextUrl.searchParams.get('anchor')
  const result = await describeDesignTemplate(admin as any, fundId, anchor || undefined)
  if (result.status !== 'ready') return NextResponse.json(result)
  const sections = await designSections(admin as any, fundId, result.design.headings)
  return NextResponse.json({ ...result, sections })
}
