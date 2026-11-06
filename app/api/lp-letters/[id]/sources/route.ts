import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { outcomeResponse } from '@/lib/service-outcome'
import { changeLetterSources, MAX_LETTER_SOURCES } from '@/lib/lp-letters/service'
import { rateLimit } from '@/lib/rate-limit'

// Extracting text from a long PDF can take a while.
export const maxDuration = 120

const MAX_FILE_BYTES = 15 * 1024 * 1024

async function gate() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  const scope = await loadEntityScopeForUser(admin, user.id)
  return { admin, ctx: { fundId: writeCheck.fundId, userId: user.id, visible: scope ? scope.vehicleNames : [] as string[] } }
}

/**
 * Add documents to a letter as sources (a market report, a board deck): PDF, Word or text files,
 * kept as their text. They are read into the letter's brief and never shown to investors.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const g = await gate()
  if ('error' in g) return g.error
  const limited = await rateLimit({ key: `lp-letter-sources:${g.ctx.userId}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const form = await req.formData().catch(() => null)
  const files = (form?.getAll('files') ?? []).filter((f): f is File => typeof f !== 'string')
  if (!files.length) return NextResponse.json({ error: 'Add at least one file.' }, { status: 400 })
  if (files.length > MAX_LETTER_SOURCES) return NextResponse.json({ error: `At most ${MAX_LETTER_SOURCES} files at a time.` }, { status: 400 })

  const add: { name: string; text: string }[] = []
  const unread: string[] = []
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) { unread.push(file.name); continue }
    try {
      const extracted = await extractFromBuffer(Buffer.from(await file.arrayBuffer()), file.name, file.type)
      if (extracted.extractedText?.trim()) add.push({ name: file.name, text: extracted.extractedText.trim() })
      else unread.push(file.name)
    } catch {
      unread.push(file.name)
    }
  }
  if (!add.length) return NextResponse.json({ error: `Could not read any text from ${unread.join(', ')}.` }, { status: 400 })
  const res = outcomeResponse(await changeLetterSources(g.admin, g.ctx, params.id, { add }))
  if (!unread.length || res.status !== 200) return res
  return NextResponse.json({ ...(await res.json()), unread }, { status: 200 })
}

/** Take a source document off a letter: ?source=<id>. */
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const g = await gate()
  if ('error' in g) return g.error
  const source = req.nextUrl.searchParams.get('source')
  if (!source) return NextResponse.json({ error: 'Name the source to remove.' }, { status: 400 })
  return outcomeResponse(await changeLetterSources(g.admin, g.ctx, params.id, { remove: source }))
}
