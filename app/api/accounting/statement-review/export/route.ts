import { NextRequest, NextResponse } from 'next/server'
// lp_capital domain, gated on the lp_tracking switch, read level (lib/access/route-domains.ts).
import { reviewRouteContext } from '@/lib/statement-review/http'
import { getReview } from '@/lib/statement-review/store'
import { questionsMarkdown, reviewFileName, reviewMarkdown } from '@/lib/statement-review/export'
import { reviewPdf } from '@/lib/statement-review/export-pdf'

// A review as a document (lib/statement-review/export.ts).
//
//   GET ?group=…&id=… | &period_end=…&format=pdf | md | questions
//     pdf       → the whole review: questions, checks, findings, sign-off
//     md        → the same, as Markdown
//     questions → only the questions for the administrator, as Markdown

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const r = await reviewRouteContext(false, sp.get('group'))
  if ('error' in r) return r.error
  const review = await getReview(r.admin, r.fundId, r.vehicle, { id: sp.get('id'), periodEnd: sp.get('period_end') })
  if (!review.ok) return NextResponse.json({ error: review.error }, { status: review.status })
  const format = sp.get('format') ?? 'pdf'
  if (format === 'md' || format === 'questions') {
    const text = format === 'md' ? reviewMarkdown(review.value) : questionsMarkdown(review.value)
    const name = reviewFileName(review.value, 'md').replace('statement-review-', format === 'md' ? 'statement-review-' : 'administrator-questions-')
    return new NextResponse(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } })
  }
  if (format !== 'pdf') return NextResponse.json({ error: 'format must be pdf, md or questions' }, { status: 400 })
  try {
    const pdf = await reviewPdf(review.value)
    return new NextResponse(new Uint8Array(pdf.body), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdf.fileName}"` } })
  } catch (e: any) {
    console.error('[statement-review-export]', e?.message)
    return NextResponse.json({ error: 'The PDF could not be made. Try the Markdown export.' }, { status: 500 })
  }
}
