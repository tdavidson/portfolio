import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFund } from '@/lib/api-helpers'
import { getCompanyUpdate, getCompanyUpdateArtifact } from '@/lib/company-updates/search'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { updateVisible } from '@/lib/company-updates/scope'

/**
 * One artifact: its complete extracted text with chunk locators, or — with `?download=1` — a
 * short-lived signed URL to the ORIGINAL bytes in the email-attachments bucket. Artifacts are
 * addressed by id, never by filename, so duplicate filenames cannot resolve to the wrong bytes.
 *
 * Download disposition mirrors /api/emails/[id]/attachment/[index]: inline only for PDFs and a
 * raster-image allowlist; everything else is forced to download.
 */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; artifactId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const fund = await resolveFund(admin, user.id)
  if (fund instanceof NextResponse) return fund

  try {
    const artifact = await getCompanyUpdateArtifact(admin as any, { fundId: fund.fundId, artifactId: params.artifactId })
    if (!artifact || artifact.update_id !== params.id) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // An attachment is its update's: visible only when the update's company is the caller's.
    const scope = await loadEntityScopeForUser(admin, user.id)
    const parent = await getCompanyUpdate(admin as any, { fundId: fund.fundId, updateId: params.id })
    if (!parent || !updateVisible(parent, scope ? scope.companyIds : [])) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (req.nextUrl.searchParams.get('download') === '1') {
      if (!artifact.storage_path) {
        return NextResponse.json({ error: 'The original file was not stored for this attachment' }, { status: 404 })
      }
      const update = await getCompanyUpdate(admin as any, { fundId: fund.fundId, updateId: params.id })
      if (!update || !artifact.storage_path.startsWith(`${update.source_email_id}/`)) {
        return NextResponse.json({ error: 'Storage path mismatch' }, { status: 400 })
      }
      const downloadName = artifact.filename.replace(/[^\w.\-]/g, '_').slice(0, 200)
      const contentType = artifact.detected_content_type ?? artifact.declared_content_type ?? ''
      const wantsInline = req.nextUrl.searchParams.get('disposition') === 'inline'
      const inlineSafe = contentType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(contentType)
      const { data: signed, error } = await admin.storage
        .from('email-attachments')
        .createSignedUrl(artifact.storage_path, 60, wantsInline && inlineSafe ? undefined : { download: downloadName })
      if (error || !signed) return NextResponse.json({ error: error?.message ?? 'Failed to sign URL' }, { status: 500 })
      return NextResponse.redirect(signed.signedUrl, 302)
    }

    const { storage_path: _storagePath, ...rest } = artifact
    return NextResponse.json(rest)
  } catch (err) {
    console.error('[company-updates/artifact] failed:', err)
    return NextResponse.json({ error: 'Could not load artifact' }, { status: 500 })
  }
}
