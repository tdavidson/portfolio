import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFund } from '@/lib/api-helpers'
import { CAPTURE_VERSION } from '@/lib/company-updates/extraction'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'

/**
 * Coverage and quality counts for the fund's Company Updates corpus — eligible emails vs captured
 * updates, source attachments vs artifact rows, artifacts by format × status, OCR queue, parser
 * failures by version, stale chunks, and the latest backfill job. Durable data, not logs.
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const fund = await resolveFund(admin, user.id)
  if (fund instanceof NextResponse) return fund

  // Corpus-wide counts across every company: for unscoped callers only.
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope || scope.companyIds !== null) return NextResponse.json({ error: 'Not available' }, { status: 403 })

  const { data, error } = await (admin as any).rpc('company_updates_stats', {
    p_fund_id: fund.fundId,
    p_current_parser_version: CAPTURE_VERSION,
  })
  if (error) {
    console.error('[company-updates/status] failed:', error.message)
    return NextResponse.json({ error: 'Could not load status' }, { status: 500 })
  }
  return NextResponse.json({ ...(data ?? {}), current_parser_version: CAPTURE_VERSION })
}
