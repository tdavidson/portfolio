import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { registerEmailAttachment } from '@/lib/emails/attachments'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Register a file the browser uploaded into this email's folder of the email-attachments bucket:
 * verified, scanned and listed on the email (lib/emails/attachments.ts, which
 * `add_email_attachment` calls for a file uploaded from chat).
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  return outcomeResponse(await registerEmailAttachment(admin, writeCheck.fundId, params.id, {
    filename: body?.filename,
    contentType: body?.contentType,
    contentLength: body?.contentLength,
    storagePath: body?.storagePath,
  }))
}
