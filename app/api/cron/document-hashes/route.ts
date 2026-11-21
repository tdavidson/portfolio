import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { backfillDocumentHashes } from '@/lib/companies/document-hashes'
import { cronAuthDenial } from '@/lib/security/cron-auth'
import { kickCron } from '@/lib/cron/kick'

export const maxDuration = 300

/**
 * Holding document hashes backfill (lib/companies/document-hashes.ts). Hashes holding documents and
 * update files stored before their hashes existed, a bounded batch per run and one row at a time,
 * so the database never sees a burst. While rows remain after a run that made progress, it starts
 * its own next run; the daily tick starts it while any row is unhashed (lib/cron/dispatch.ts).
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  try {
    const outcome = await backfillDocumentHashes(createAdminClient(), { maxDocuments: 25, maxArtifacts: 200, timeBudgetMs: 240_000 })
    if (outcome.more && outcome.documents + outcome.artifacts > 0) await kickCron('document-hashes')
    return NextResponse.json(outcome)
  } catch (err) {
    console.error('[cron/document-hashes] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Backfill failed' }, { status: 500 })
  }
}
