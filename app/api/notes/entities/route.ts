import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { noteEntityCandidates } from '@/lib/notes/entity'

/**
 * GET ?companyId= → the entities a new note may be for: the caller's active entities, and for a note
 * about a company only those that hold it. Every note belongs to an entity (lib/notes/entity.ts);
 * the composer offers a choice only when there is more than one.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const companyId = req.nextUrl.searchParams.get('companyId')
  // A company the caller cannot see offers nothing, rather than confirming it exists.
  if (companyId && scope.companyIds !== null && !scope.companyIds.includes(companyId)) return NextResponse.json([])
  return NextResponse.json(await noteEntityCandidates(admin, scope, companyId))
}
