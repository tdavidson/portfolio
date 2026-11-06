import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { uploadLetterToGoogleDocs } from '@/lib/lp-letters/export'
import { exportLetter, letterDocx, LETTER_EXPORT_FORMATS, type LetterExportFormat } from '@/lib/lp-letters/export-letter'
import { getLetter } from '@/lib/lp-letters/service'
import { fundDriveToken } from '@/lib/google/fund-drive'
import { outcomeResponse } from '@/lib/service-outcome'

export const maxDuration = 60

/** A letter as a file (Word, PDF, Markdown, JSON), or as a Google Doc in the fund's Drive. */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const { format } = await req.json().catch(() => ({}))
  if (format !== 'google-docs' && !LETTER_EXPORT_FORMATS.includes(format)) {
    return NextResponse.json({ error: 'Invalid format. Use docx, pdf, markdown, json or google-docs.' }, { status: 400 })
  }

  const scope = await loadEntityScopeForUser(admin, user.id)
  const found = await getLetter(admin, fundId, scope ? scope.vehicleNames : [], params.id)
  if (!found.ok) return outcomeResponse(found)
  const letter = found.value
  if (!letter) return NextResponse.json({ error: 'Letter not found' }, { status: 404 })
  if (letter.status === 'generating') return NextResponse.json({ error: 'This letter is being generated. Try again when it finishes.' }, { status: 409 })

  if (format === 'google-docs') {
    try {
      const drive = await fundDriveToken(admin, fundId)
      if (!drive.ok) return outcomeResponse(drive)
      const { buffer, fundName } = await letterDocx(admin, fundId, letter)
      const url = await uploadLetterToGoogleDocs(buffer, `${fundName} — ${letter.period_label}`, drive.value.accessToken, drive.value.folderId)
      return NextResponse.json({ url })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to export to Google Docs'
      console.error('[lp-letters-export-gdocs]', message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  try {
    const out = await exportLetter(admin, fundId, letter, format as LetterExportFormat)
    if (!out) return NextResponse.json({ error: 'Letter not found' }, { status: 404 })
    return new NextResponse(new Uint8Array(out.body), {
      headers: {
        'Content-Type': out.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(out.fileName)}"`,
      },
    })
  } catch (err) {
    console.error(`[lp-letters-export-${format}]`, err)
    return NextResponse.json({ error: 'The export failed.' }, { status: 500 })
  }
}
