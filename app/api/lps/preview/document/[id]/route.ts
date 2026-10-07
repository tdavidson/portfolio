import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'

/**
 * Admin-only: signed download URL for a document, for the "view as LP" preview.
 * Scoped to the admin's own fund (the doc must belong to it).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  // Previewing the portal shows an investor everything they hold, in every entity — so only someone
  // who can see every entity may preview it (the sidebar already offers it to admins only).
  const previewScope = await loadEntityScopeForUser(admin, user.id)
  if (!previewScope || !canSeeVehicle(previewScope.access, null)) {
    return NextResponse.json({ error: 'Previewing the LP portal needs access to every entity.' }, { status: 403 })
  }

  const { data: doc } = await (admin as any)
    .from('lp_documents').select('storage_path, file_name').eq('id', params.id).eq('fund_id', membership.fund_id).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (String(doc.storage_path).startsWith('sample/')) return NextResponse.json({ error: 'This is a sample document.' }, { status: 404 })

  const { data: signed, error } = await admin.storage.from('lp-documents').createSignedUrl(doc.storage_path, 300, { download: doc.file_name })
  if (error || !signed) return NextResponse.json({ error: 'Could not generate download link' }, { status: 500 })
  return NextResponse.json({ url: signed.signedUrl })
}
