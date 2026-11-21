// The review as a PDF, through the shared headless-Chrome renderer. Its own module so only the
// routes that render it pull Chromium in (lib/pdf-routes.mjs, tests/pdf-routes.test.ts).

import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss } from '@/lib/pdf-fonts'
import { reviewFileName, reviewHtml } from './export'
import type { StoredReview } from './store'

/** The review as a PDF. */
export async function reviewPdf(r: StoredReview): Promise<{ body: Buffer; fileName: string }> {
  const body = await renderHtmlToPdf(reviewHtml(r, pdfFontCss()))
  return { body, fileName: reviewFileName(r, 'pdf') }
}

