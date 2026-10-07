import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess } from '@/lib/api-helpers'
import { extractDocumentText } from '@/lib/lp-onboarding-extract'
import { classifyKind, extractFacts, prepareText } from '@/lib/lp-onboarding-classify'
import { defaultExpiry } from '@/lib/tax/forms'
import { canRecordTaxForms } from '@/lib/lp-onboarding-tax'
import { loadLpScope, lpDocumentVisible } from '@/lib/access/lp-scope'

export const maxDuration = 60

/**
 * What an already-uploaded onboarding document says, for the verify dialog to prefill.
 *
 *   GET ?document_id=… → the tax-form facts read from the file (form type, legal name, TIN type
 *   and last four, country, signed date, default expiry), and whether this caller may record
 *   them. Read on this server, used once, not kept — the same rule as the batch sorter.
 *
 * An LP-uploaded W-9 arrives through the checklist rather than the sorter, so the reviewer
 * verifying it needs the same head start the sorter gives.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const a = admin as any

  const documentId = req.nextUrl.searchParams.get('document_id') ?? ''
  if (!documentId) return NextResponse.json({ error: 'document_id is required' }, { status: 400 })

  // The document must be this fund's — lp_documents is cross-fund and the id came from the URL.
  const { data: doc } = await a.from('lp_documents').select('id, storage_path, file_name, mime_type').eq('id', documentId).eq('fund_id', gate.fundId).maybeSingle()
  if (!doc || !(await lpDocumentVisible(admin, gate.fundId, documentId, await loadLpScope(admin, gate)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { can } = await canRecordTaxForms(admin, gate.fundId, user.id, gate.role)

  const { data: blob, error } = await admin.storage.from('lp-documents').download(doc.storage_path)
  if (error || !blob) return NextResponse.json({ canRecordTax: can, facts: null, note: 'Could not open the file.' })
  const extracted = await extractDocumentText(Buffer.from(await blob.arrayBuffer()), doc.file_name, doc.mime_type)
  const text = prepareText(extracted.text)
  const kind = classifyKind(text, doc.file_name)
  const facts = extractFacts(text, 'tax_form')
  const formType = kind.taxFormType
  const signedDate = facts.dateCandidates[0] ?? null

  return NextResponse.json({
    canRecordTax: can,
    source: extracted.source,
    note: extracted.note,
    facts: {
      formType,
      legalName: facts.nameCandidates[0] ?? null,
      tinType: facts.tin?.type ?? null,
      tinLast4: facts.tin?.last4 ?? null,
      country: facts.country,
      signedDate,
      expiresOn: formType ? defaultExpiry(formType, signedDate) : null,
    },
  })
}
