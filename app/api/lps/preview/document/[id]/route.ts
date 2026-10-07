import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadLpScopeForUser, lpDocumentVisible } from '@/lib/access/lp-scope'

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
  // One document, so the document rule decides (lp-scope.ts) — the same one the documents list and
  // the onboarding review use, which open files through this route.
  const lp = await loadLpScopeForUser(admin, user.id)
  if (!lp || !(await lpDocumentVisible(admin, membership.fund_id, params.id, lp))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: doc } = await (admin as any)
    .from('lp_documents').select('storage_path, file_name').eq('id', params.id).eq('fund_id', membership.fund_id).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (String(doc.storage_path).startsWith('sample/')) return NextResponse.json({ error: 'This is a sample document.' }, { status: 404 })

  const { data: signed, error } = await admin.storage.from('lp-documents').createSignedUrl(doc.storage_path, 300, { download: doc.file_name })
  if (error || !signed) return NextResponse.json({ error: 'Could not generate download link' }, { status: 500 })
  return NextResponse.json({ url: signed.signedUrl })
}
