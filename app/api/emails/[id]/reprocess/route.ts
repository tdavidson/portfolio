import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { ReprocessRefused, resetForReprocess, runReprocess } from '@/lib/pipeline/reprocess'
import type { InboundEmail } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 300

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Rate limit reprocessing: 10 per 5 minutes per user
  const limited = await rateLimit({ key: `reprocess:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  // Fetch email — RLS ensures it belongs to the user's fund
  const { data: emailData, error } = await supabase
    .from('inbound_emails')
    .select('id, fund_id, raw_payload, processing_status')
    .eq('id', params.id)
    .maybeSingle()

  if (error) return dbError(error, 'emails-id-reprocess')
  if (!emailData) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const email = emailData as unknown as Pick<
    InboundEmail,
    'id' | 'fund_id' | 'raw_payload' | 'processing_status'
  >

  const admin = createAdminClient()
  const emailId = email.id

  try {
    await resetForReprocess(admin, email)
  } catch (err) {
    if (err instanceof ReprocessRefused) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  // Keep the request alive until the pipeline reaches a terminal state. A
  // fire-and-forget promise can be terminated when a serverless response ends.
  await runReprocess(admin, email)

  expireTag('review-badge')

  const { data: result } = await admin
    .from('inbound_emails')
    .select('processing_status, processing_error')
    .eq('id', emailId)
    .maybeSingle()

  return NextResponse.json({
    ok: true,
    message: 'Reprocessing finished',
    processing_status: result?.processing_status ?? 'failed',
    processing_error: result?.processing_error ?? null,
  })
}
