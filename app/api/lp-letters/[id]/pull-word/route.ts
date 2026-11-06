import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { getLetter, updateLetter } from '@/lib/lp-letters/service'
import { compareWithLetter, docxToLetterText } from '@/lib/lp-letters/word-import'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 60

const MAX_FILE_BYTES = 15 * 1024 * 1024

/**
 * Bring a draft back from the Word file the partners edited (multipart `file`). Without
 * `apply=true` it only reads the file and returns what would change, section by section and line
 * by line; with it, the draft's text is replaced, each section keeping its sources and charts. The
 * internal notes are kept, and a final letter is never changed.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck
  const limited = await rateLimit({ key: `lp-letter-pull-word:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Add the Word file.' }, { status: 400 })
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'The file is over 15 MB.' }, { status: 400 })
  if (!/\.docx$/i.test(file.name)) return NextResponse.json({ error: 'Use a Word file (.docx).' }, { status: 400 })

  const scope = await loadEntityScopeForUser(admin, user.id)
  const visible = scope ? scope.vehicleNames : []
  const found = await getLetter(admin, fundId, visible, params.id)
  if (!found.ok) return outcomeResponse(found)
  const letter = found.value
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (letter.status !== 'draft') {
    return NextResponse.json({ error: 'Only a draft can be replaced. This letter is final or still being generated.' }, { status: 409 })
  }

  let fileText = ''
  try {
    fileText = await docxToLetterText(Buffer.from(await file.arrayBuffer()))
  } catch (err) {
    console.error('[lp-letters-pull-word]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: `Couldn't read ${file.name} as a Word file.` }, { status: 400 })
  }
  const comparison = compareWithLetter(letter, fileText)
  if (!comparison.text) return NextResponse.json({ error: 'That Word file has no text.' }, { status: 400 })
  if (form?.get('apply') !== 'true') return NextResponse.json({ comparison })

  // full_draft with its "Missing information" section, if the file has one: it goes to the notes.
  const saved = await updateLetter(admin, { fundId, visible, userId: user.id }, params.id, { full_draft: fileText })
  if (!saved.ok) return outcomeResponse(saved)
  return NextResponse.json({ comparison, letter: saved.value })
}
