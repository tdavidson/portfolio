import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { DEFAULT_STYLE_GUIDE, DEFAULT_TEMPLATE_NAME } from '@/lib/lp-letters/default-template'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { rateLimit } from '@/lib/rate-limit'
import { outcomeResponse } from '@/lib/service-outcome'
import { MAX_DOCUMENTS, type SourceDocument } from '@/lib/lp-letters/learn-voice'
import { learnVoiceTemplate, makeFundVoice } from '@/lib/lp-letters/templates'

// Learning a voice reads every document in one long AI call.
export const maxDuration = 300

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  const { data, error } = await admin
    .from('lp_letter_templates')
    .select('*')
    .eq('fund_id', membership.fund_id)
    .order('created_at', { ascending: false })

  if (error) return dbError(error, 'lp-letters-templates')

  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const contentType = req.headers.get('content-type') ?? ''

  // Past letters or memos (multipart): learn the fund's voice from them, as a draft to review.
  if (contentType.includes('multipart/form-data')) {
    const limited = await rateLimit({ key: `lp-letter-voice:${user.id}`, limit: 3, windowSeconds: 600 })
    if (limited) return limited

    const formData = await req.formData()
    const files = formData.getAll('file').filter((f): f is File => typeof f !== 'string')
    const name = String(formData.get('name') ?? '').trim() || 'Learned voice'

    if (!files.length) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (files.length > MAX_DOCUMENTS) {
      return NextResponse.json({ error: `Upload at most ${MAX_DOCUMENTS} documents at a time` }, { status: 400 })
    }
    // Reject files over 20MB before buffering any into memory
    const big = files.find(f => f.size > 20 * 1024 * 1024)
    if (big) return NextResponse.json({ error: `${big.name} is too large (max 20MB)` }, { status: 400 })

    const docs: SourceDocument[] = []
    const unread: string[] = []
    for (const file of files) {
      const extracted = await extractFromBuffer(Buffer.from(await file.arrayBuffer()), file.name, file.type)
      if (extracted.extractedText?.trim()) docs.push({ filename: file.name, text: extracted.extractedText })
      else unread.push(file.name)
    }
    if (!docs.length) return NextResponse.json({ error: 'Could not extract text from the files' }, { status: 400 })

    const out = await learnVoiceTemplate(admin, { fundId, userId: user.id }, name, docs)
    if (!out.ok) return outcomeResponse(out)
    return NextResponse.json({ ...out.value.template, reused_from_sources: out.value.reused, unread_files: unread }, { status: 201 })
  }

  // JSON body — create default template
  const body = await req.json().catch(() => ({}))
  const name = body.name ?? DEFAULT_TEMPLATE_NAME

  const { data, error } = await admin
    .from('lp_letter_templates')
    .insert({
      fund_id: fundId,
      name,
      style_guide: DEFAULT_STYLE_GUIDE,
      source_type: 'default',
      is_default: false,
    })
    .select()
    .single()

  if (error) return dbError(error, 'lp-letters-templates')
  // It becomes the fund's voice, and the only one.
  const made = await makeFundVoice(admin, fundId, data.id)
  return made.ok ? NextResponse.json(made.value, { status: 201 }) : outcomeResponse(made)
}
