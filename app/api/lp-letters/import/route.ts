import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { outcomeResponse } from '@/lib/service-outcome'
import { importLetter } from '@/lib/lp-letters/service'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 120

const MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * Bring in a letter as it was sent (PDF or Word): its text becomes a final, imported letter, and
 * the file itself is kept as sent in the private lp-letter-originals bucket.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const limited = await rateLimit({ key: `lp-letter-import:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Add the letter file.' }, { status: 400 })
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'The file is over 25 MB.' }, { status: 400 })
  const vehicle = String(form?.get('vehicle') ?? '')
  const year = Number(form?.get('year'))
  const quarter = Number(form?.get('quarter'))
  const yearEnd = form?.get('year_end') === 'true'
  if (!vehicle) return NextResponse.json({ error: 'Choose the entity.' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  let text = ''
  try {
    text = (await extractFromBuffer(buffer, file.name, file.type)).extractedText?.trim() ?? ''
  } catch { /* reported below */ }
  if (!text) return NextResponse.json({ error: `Could not read any text from ${file.name}.` }, { status: 400 })

  const scope = await loadEntityScopeForUser(admin, user.id)
  const ctx = { fundId: writeCheck.fundId, userId: user.id, visible: scope ? scope.vehicleNames : [] as string[] }
  const saved = await importLetter(admin, ctx, { vehicle, year, quarter, yearEnd, text })
  if (!saved.ok) return outcomeResponse(saved)

  // The file as sent, kept beside the letter. A failed upload leaves the imported text in place.
  const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'letter'
  const path = `${writeCheck.fundId}/${saved.value.id}/${safe}`
  const { error: upErr } = await admin.storage.from('lp-letter-originals').upload(path, buffer, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (upErr) {
    console.error('[lp-letter-import] storing the original failed:', upErr.message)
    return NextResponse.json({ ...saved.value, original_stored: false })
  }
  const { data } = await (admin as any).from('lp_letters')
    .update({ original_file: { path, name: file.name, type: file.type || null, size: file.size } })
    .eq('id', saved.value.id).eq('fund_id', writeCheck.fundId).select().single()
  return NextResponse.json({ ...(data ?? saved.value), original_stored: true })
}
