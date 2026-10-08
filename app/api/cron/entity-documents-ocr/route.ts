import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createVisionOcrEngine } from '@/lib/company-updates/ocr'
import { runEntityDocumentOcr } from '@/lib/entity-documents'

export const maxDuration = 300

/**
 * Entity-documents OCR worker: transcribes scanned pages of governing documents with each fund's
 * vision model, a batch at a time, resuming long documents across runs. Same fail-closed
 * CRON_SECRET pattern as the other workers.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  if (req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const admin = createAdminClient()
  try {
    const result = await runEntityDocumentOcr(admin as any, {
      engineFor: fundId => createVisionOcrEngine(fundId, { admin }),
    })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/entity-documents-ocr] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
