import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { getLetter, updateLetter } from '@/lib/lp-letters/service'
import { investorText } from '@/lib/lp-letters/internal'
import { diffDraft, normalizeDocText, parseGoogleDocUrl } from '@/lib/lp-letters/pull'
import { fundDriveToken } from '@/lib/google/fund-drive'
import { exportFile } from '@/lib/google/drive'

/**
 * Bring a draft back from the Google Doc the partners edited. Without `apply` it only reads the doc
 * and returns what would change; with `apply: true` it replaces the draft's text. The internal notes
 * are kept either way, and a final letter is never changed.
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

  const body = await req.json().catch(() => ({}))
  const docId = parseGoogleDocUrl(String(body?.url ?? ''))
  if (!docId) return NextResponse.json({ error: 'Paste the link to a Google Doc' }, { status: 400 })

  const scope = await loadEntityScopeForUser(admin, user.id)
  const visible = scope ? scope.vehicleNames : []
  const found = await getLetter(admin, fundId, visible, params.id)
  if (!found.ok) return outcomeResponse(found)
  const letter = found.value
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (letter.status !== 'draft') {
    return NextResponse.json({ error: 'Only a draft can be replaced. This letter is final or still being generated.' }, { status: 409 })
  }

  const drive = await fundDriveToken(admin, fundId)
  if (!drive.ok) return outcomeResponse(drive)

  let incoming: string
  try {
    incoming = normalizeDocText((await exportFile(drive.value.accessToken, docId, 'text/plain')).toString('utf8'))
  } catch (err) {
    console.error('[lp-letters-pull-gdoc]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Couldn't read that Google Doc. Check that the fund's Google account can open it." }, { status: 502 })
  }
  if (!incoming) return NextResponse.json({ error: 'That Google Doc is empty' }, { status: 400 })

  // Compared with what investors would see: the internal notes stay with the letter, apart.
  const diff = diffDraft(investorText(letter.full_draft) ?? '', incoming)
  if (body?.apply !== true) return NextResponse.json({ diff, text: incoming })

  const saved = await updateLetter(admin, { fundId, visible }, params.id, { full_draft: incoming })
  if (!saved.ok) return outcomeResponse(saved)
  return NextResponse.json({ diff, letter: saved.value })
}
