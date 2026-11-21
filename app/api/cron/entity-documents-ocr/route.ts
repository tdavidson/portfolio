import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createVisionOcrEngine } from '@/lib/company-updates/ocr'
import { runEntityDocumentOcr } from '@/lib/entity-documents'
import { cronAuthDenial } from '@/lib/security/cron-auth'
import { kickCron } from '@/lib/cron/kick'

export const maxDuration = 300

/**
 * Entity-documents OCR worker: transcribes scanned pages of governing documents with each fund's
 * vision model, a batch at a time, resuming long documents across runs. Started when a scanned
 * document is uploaded (lib/cron/kick.ts), and by the daily tick as a safety net; a run that made
 * progress with documents still pending starts the next one. Same fail-closed CRON_SECRET pattern
 * as the other workers.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied
  const admin = createAdminClient()
  try {
    const result = await runEntityDocumentOcr(admin as any, {
      engineFor: fundId => createVisionOcrEngine(fundId, { admin }),
    })
    if (result.pages > 0 || result.completed > 0) {
      const { data: more } = await (admin as any).from('entity_documents').select('id').eq('ocr_status', 'pending').limit(1)
      if ((more ?? []).length > 0) await kickCron('entity-documents-ocr')
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/entity-documents-ocr] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
