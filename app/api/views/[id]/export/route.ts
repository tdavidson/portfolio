import { NextRequest, NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { customViewDocument } from '@/lib/custom-views/document'
import { EXPORT_FORMATS, type ExportFormat } from '@/lib/custom-views/export'
import { ViewSpecError } from '@/lib/custom-views/spec'
import { CustomViewError } from '@/lib/custom-views/store'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/views/<id>/export?format=pdf|xlsx&vehicle=&as_of=&filter.<column>=&tz=
 *
 * The view as a PDF (opens in the tab, to print or save) or an Excel workbook (downloads), with
 * every block loaded as the caller, exactly as GET /api/views/<id> loads it. Gated at 'any' in
 * route-domains.ts; each block is checked in resolveView against its dataset's own gate.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const p = req.nextUrl.searchParams
  const format = (p.get('format') ?? 'pdf') as ExportFormat
  if (!EXPORT_FORMATS.includes(format)) return NextResponse.json({ error: 'format must be pdf or xlsx' }, { status: 400 })
  const c = await viewsContext()
  if ('error' in c) return c.error
  // A PDF starts a headless browser: keep a held-down button from starting many.
  const limited = await rateLimit({ key: `custom-view-export:${c.userId}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited
  try {
    const doc = await customViewDocument(c, {
      view: id, format,
      arguments: Object.fromEntries(Array.from(p).filter(([k]) => k !== 'format' && k !== 'tz')),
      timeZone: p.get('tz') ?? undefined,
    })
    return new NextResponse(new Uint8Array(doc.body), {
      headers: {
        'Content-Type': doc.contentType,
        'Content-Disposition': `${format === 'pdf' ? 'inline' : 'attachment'}; filename="${doc.fileName.replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    if (e instanceof CustomViewError || e instanceof ViewSpecError) return NextResponse.json({ error: e.message }, { status: 404 })
    console.error('[views/export]', e)
    return NextResponse.json({ error: 'The file could not be made. Try again.' }, { status: 500 })
  }
}
