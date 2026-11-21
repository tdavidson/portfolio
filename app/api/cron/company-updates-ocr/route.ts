import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runOcrBatch } from '@/lib/company-updates/ocr'
import { cronAuthDenial } from '@/lib/security/cron-auth'
import { kickCron } from '@/lib/cron/kick'

const BATCH = 8

export const maxDuration = 300

/**
 * Company Updates OCR worker. Claims pending artifacts (images, scanned PDF pages) across funds
 * and transcribes them with each fund's configured vision model, merging text back atomically.
 * Started when an update queues OCR (lib/cron/kick.ts), and by the daily tick as a safety net. A full
 * batch that made progress starts the next run, so a long queue drains without waiting a day.
 * Same fail-closed CRON_SECRET pattern as the other workers.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()
  try {
    const result = await runOcrBatch(admin as any, { limit: BATCH })
    if (result.claimed === BATCH && result.completed + result.failed + result.retried > 0) await kickCron('company-updates-ocr')
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cron/company-updates-ocr] failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
