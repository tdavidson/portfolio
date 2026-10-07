import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess } from '@/lib/api-helpers'
import { extractDocumentText } from '@/lib/lp-onboarding-extract'
import { proposeSort, type MatchableEntity } from '@/lib/lp-onboarding-classify'
import { runPool } from '@/lib/lp-report-pdf'
import { canRecordTaxForms } from '@/lib/lp-onboarding-tax'
import { scanFile } from '@/lib/security/scan-file'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

export const maxDuration = 120

/**
 * Sort a batch of onboarding documents the fund has just uploaded: say what each one is and
 * whose it is, for a person to confirm.
 *
 *   POST { files: [{ storage_path, file_name, mime_type?, size_bytes? }] }
 *        → one proposal per file: kind, entity, confidence, the facts read, and a flag when a
 *          stated commitment disagrees with the one on file.
 *
 * The files are already in the fund's folder of the lp-documents bucket (uploaded through
 * /api/lps/documents/upload-url). Each is read here, on this server — PDF text, Word text, or OCR
 * for a photo or scan — classified by rules, and matched by fuzzy name against the fund's own
 * entities. No model is called and the text is not kept. Nothing is recorded by this route; the
 * confirm route does that, after the reviewer has looked.
 */

// Per request. The client sends a batch in chunks of this size so OCR on scans fits the window.
const MAX_FILES = 12

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId
  const a = admin as any

  const body = await req.json().catch(() => ({}))
  const files: { storage_path: string; file_name: string; mime_type: string | null; size_bytes: number | null }[] =
    Array.isArray(body.files) ? body.files.filter((f: any) => f && typeof f.storage_path === 'string' && typeof f.file_name === 'string')
      .map((f: any) => ({ storage_path: f.storage_path, file_name: f.file_name, mime_type: typeof f.mime_type === 'string' ? f.mime_type : null, size_bytes: typeof f.size_bytes === 'number' ? f.size_bytes : null })) : []
  if (files.length === 0) return NextResponse.json({ error: 'No files' }, { status: 400 })
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Sort at most ${MAX_FILES} files at a time` }, { status: 400 })

  // Every path must be inside this fund's folder — the upload-url route put it there, and a body
  // naming any other path is asking to read another fund's file.
  for (const f of files) {
    if (!f.storage_path.startsWith(`${fundId}/`) || f.storage_path.includes('..')) {
      return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 })
    }
  }

  const [{ data: ents }, { data: invs }] = await Promise.all([
    a.from('lp_entities').select('id, entity_name, investor_id, lp_investors(name)').eq('fund_id', fundId),
    a.from('lp_investments').select('entity_id, commitment, portfolio_group').eq('fund_id', fundId),
  ])
  // Match files only against LPs with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  const entities: MatchableEntity[] = ((ents ?? []) as any[]).filter(e => lpVisible(lp.entityIds, e.id)).map(e => ({ id: e.id, name: e.entity_name, investorName: e.lp_investors?.name ?? '' }))
  const commitmentByEntity = new Map<string, number>()
  // Only the caller's entities' commitments: an LP also in another entity must not show its total.
  for (const r of ((invs ?? []) as any[]).filter(r => lp.scope.vehicleNames === null || lp.scope.vehicleNames.includes(r.portfolio_group))) {
    const c = Number(r.commitment)
    if (Number.isFinite(c) && c > 0) commitmentByEntity.set(r.entity_id, (commitmentByEntity.get(r.entity_id) ?? 0) + c)
  }

  const results: any[] = new Array(files.length)
  await runPool(files.map((f, i) => ({ f, i })), 3, async ({ f, i }) => {
    const { data: blob, error } = await admin.storage.from('lp-documents').download(f.storage_path)
    if (error || !blob) {
      results[i] = { ...f, proposal: null, error: 'The upload did not complete.' }
      return
    }
    const buffer = Buffer.from(await blob.arrayBuffer())
    // Scanned before it is read: a hit is deleted and reported, never proposed.
    const scan = scanFile(buffer, f.file_name, f.mime_type ?? '')
    if (!scan.safe) {
      await admin.storage.from('lp-documents').remove([f.storage_path])
      results[i] = { ...f, proposal: null, rejected: true, error: `Rejected: ${scan.reason ?? 'did not pass the safety check'}. The file has been removed.` }
      return
    }
    const extracted = await extractDocumentText(buffer, f.file_name, f.mime_type)
    const proposal = proposeSort(extracted.text, f.file_name, entities, commitmentByEntity)
    results[i] = {
      ...f,
      source: extracted.source,
      note: extracted.note,
      proposal: {
        kind: proposal.kind.kind,
        kindConfidence: proposal.kind.confidence,
        kindMatchedOn: proposal.kind.matchedOn,
        taxFormType: proposal.kind.taxFormType,
        entityId: proposal.entity.entityId,
        entityConfidence: proposal.entity.confidence,
        entityMatchedOn: proposal.entity.matchedOn,
        alternatives: proposal.entity.alternatives,
        facts: proposal.facts,
        commitmentOnFile: proposal.commitmentOnFile,
        commitmentMismatch: proposal.commitmentMismatch,
        unreadable: proposal.unreadable,
      },
    }
  })

  const { can: canRecordTax } = await canRecordTaxForms(admin, fundId, user.id, gate.role)
  return NextResponse.json({ files: results, canRecordTax, entities: entities.map(e => ({ id: e.id, name: e.name, investorName: e.investorName })) })
}
