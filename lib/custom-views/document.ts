// A saved view as a PDF or Excel file, loaded as the member asking for it. Shared by the app's
// download route (app/api/views/[id]/export) and the link an assistant hands over
// (export_custom_view → app/api/agent/reports/[token]), so both give the same document.
//
// The view is opened exactly as the page opens it (getView + resolveView), so every block is
// checked against this member's own access as it loads: a shared view never exports its author's.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { resolveView } from './resolve'
import { getView, viewPath } from './store'
import { exportFileName, viewPdfHtml, viewWorkbook, XLSX_CONTENT_TYPE, type ExportFormat } from './export'

export interface ViewDocument {
  body: Buffer
  fileName: string
  contentType: string
}

/** A time zone the reader's browser named, or UTC when it is missing or not a real zone. */
export function readerTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw })
    return raw
  } catch {
    return 'UTC'
  }
}

export async function customViewDocument(
  deps: { admin: SupabaseClient; fundId: string; userId: string; access: AccessContext },
  input: { view: string; format: ExportFormat; arguments?: Record<string, string | null | undefined>; timeZone?: string },
): Promise<ViewDocument> {
  const view = await getView(deps.admin, deps.fundId, deps.userId, input.view)
  const payload = await resolveView(
    { admin: deps.admin, fundId: deps.fundId, userId: deps.userId, access: deps.access },
    view.spec,
    // vehicle, as_of and the view's own filter.* values; anything else is ignored.
    input.arguments ?? {},
    { id: view.id, name: view.name, url: viewPath(view.id) },
  )
  const timeZone = readerTimeZone(input.timeZone)
  const at = new Date(payload.generatedAt)
  const readAt = at.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' })
  const date = at.toLocaleDateString('en-CA', { timeZone })
  const meta = { readAt }
  const fileName = exportFileName(view.name, date, input.format)
  if (input.format === 'xlsx') return { body: viewWorkbook(payload, meta), fileName, contentType: XLSX_CONTENT_TYPE }
  return { body: await renderHtmlToPdf(viewPdfHtml(payload, meta)), fileName, contentType: 'application/pdf' }
}
