// Handlers for the STATEMENT REVIEW tools (statement-review-tools-manifest.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { unwrap } from '@/lib/service-outcome'
import { getReview, listReviews, noteFinding, runReview, signOffReview, type StoredReview } from '@/lib/statement-review/store'
import { questionsMarkdown, reviewMarkdown } from '@/lib/statement-review/export'
import { blocking, draftQuestions, findingKey } from '@/lib/statement-review/workflow'
import { linkNote, reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'
import { loadSettings, saveSettings } from '@/lib/statement-review/settings'
import { CHECK_LABELS } from '@/lib/statement-review/types'
import { ASSISTANT_TEXT_BUDGET, EXTRACTION_RESPONSE_SHAPE, EXTRACTION_RULES, extractWithServerModel, loadSourceDocuments } from '@/lib/statement-review/extract'

async function vehicleOf(ctx: AgentToolContext): Promise<{ id: string; name: string }> {
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
  if (!id) throw new Error(`No vehicle named "${ctx.portfolioGroup}".`)
  return { id, name: ctx.portfolioGroup }
}

/** A review as the assistant reads it: the package's figures left out (the caller has them). */
function present(r: StoredReview, severity?: string) {
  const findings = severity ? r.findings.filter(f => f.severity === severity) : r.findings
  return {
    vehicle: r.vehicle,
    reviewId: r.id,
    period: { start: r.periodStart, end: r.periodEnd },
    input: r.input,
    current: r.current,
    runAt: r.runAt,
    counts: r.counts,
    signOff: r.signOff ? { at: r.signOff.at, ...(r.signOff.byName ? { by: r.signOff.byName } : {}), ...(r.signOff.note ? { note: r.signOff.note } : {}) } : null,
    openToSignOff: r.signOff ? 0 : blocking(r.findings).length,
    materiality: { ...r.materiality, threshold: r.threshold, nav: r.nav },
    checks: r.checks.map(c => ({ check: CHECK_LABELS[c.check] ?? c.check, ran: c.ran, compared: c.compared, ...(c.note ? { note: c.note } : {}) })),
    findings: findings.map(f => ({
      key: f.key ?? findingKey(f),
      check: CHECK_LABELS[f.check] ?? f.check,
      severity: f.severity,
      subject: f.subject.label,
      ...(f.stated != null ? { stated: f.stated } : {}),
      ...(f.expected != null ? { expected: f.expected } : {}),
      ...(f.difference != null ? { difference: f.difference } : {}),
      message: f.message,
      cites: f.cites,
      status: f.status,
      ...(f.note ? { note: f.note } : {}),
      ...(f.question ? { question: f.question } : {}),
    })),
  }
}

export const STATEMENT_REVIEW_HANDLERS: Record<string, AgentToolHandler> = {
  statement_review_run: async (ctx: AgentToolContext, input: Record<string, unknown>) => {
    const vehicle = await vehicleOf(ctx)
    const review = unwrap(await runReview(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId }, vehicle, {
      input: input?.input as any,
      periodEnd: input?.period_end,
      periodStart: input?.period_start,
      pullId: input?.pull_id,
      csv: input?.csv,
      fileName: input?.file_name,
      fund: input?.fund,
      cash: input?.cash,
      holdings: input?.holdings,
      package: input?.package,
      documentIds: input?.document_ids,
      materiality: input?.materiality,
    }))
    const settings = await loadSettings(ctx.admin, ctx.fundId, vehicle.id)
    return {
      ...present(review),
      ...(settings.instructions ? { instructions: settings.instructions } : {}),
      next: review.counts.error || review.counts.warning
        ? 'Show the person the errors and warnings with their citations. Each is a question for the administrator or something to explain: ' +
          'record what they decide with statement_review_note, draft the questions with statement_review_export, and sign off with ' +
          'statement_review_sign_off once nothing is open.'
        : 'Nothing above materiality. Say which checks ran and which could not, so the person knows what was covered.',
    }
  },

  statement_review_extract: async (ctx: AgentToolContext, input: { document_ids?: unknown; period_end?: string; offset?: number; use_server_model?: boolean }) => {
    const vehicle = await vehicleOf(ctx)
    const docs = await loadSourceDocuments(ctx.admin, ctx.fundId, vehicle.id, input?.document_ids)
    if (typeof docs === 'string') throw new Error(docs)
    // One stream of every document's text, handed over in parts when it is long.
    const all = docs.map(d => `===== DOCUMENT: ${d.name} =====\n${d.text}`).join('\n\n')
    const offset = Math.max(0, Math.floor(Number(input?.offset ?? 0)) || 0)
    const text = all.slice(offset, offset + ASSISTANT_TEXT_BUDGET)
    const nextOffset = offset + text.length < all.length ? offset + text.length : null
    let modelReading: Record<string, unknown> | null = null
    let modelNote: string | null = null
    if (offset === 0 && input?.use_server_model !== false) {
      const read = await extractWithServerModel(ctx.admin, ctx.fundId, ctx.userId, docs, { vehicle: vehicle.name, ...(input?.period_end ? { periodEnd: input.period_end } : {}) })
      if ('package' in read) modelReading = read.package
      else if (!read.noKey) modelNote = read.failed
    }
    const settings = await loadSettings(ctx.admin, ctx.fundId, vehicle.id)
    return {
      vehicle: vehicle.name,
      documents: docs.map(d => ({ id: d.id, name: d.name, ...(d.pages ? { pages: d.pages } : {}) })),
      ...(settings.instructions ? { instructions: settings.instructions } : {}),
      responseShape: EXTRACTION_RESPONSE_SHAPE,
      rules: EXTRACTION_RULES,
      text,
      ...(nextOffset != null ? { nextOffset, totalChars: all.length } : {}),
      ...(modelReading ? { modelReading } : {}),
      ...(modelNote ? { modelNote } : {}),
      written: false,
      next: (nextOffset != null ? `The text continues: call statement_review_extract again with offset ${nextOffset} before reading the package. ` : '') +
        (modelReading
          ? "The fund's model read the package (modelReading). Check it against the text, correct anything misread, then "
          : 'Read the package out of the text in responseShape, following rules and the reviewer\'s instructions, then ') +
        'call statement_review_run with input package, the package, and document_ids ' + JSON.stringify(docs.map(d => d.id)) + '. ' +
        'Each cited figure is checked against the documents, so cite every figure.',
    }
  },

  statement_review_findings: async (ctx: AgentToolContext, input: { period_end?: string; review_id?: string; severity?: string }) => {
    const vehicle = await vehicleOf(ctx)
    if (!input?.period_end && !input?.review_id) {
      return { vehicle: vehicle.name, reviews: await listReviews(ctx.admin, ctx.fundId, vehicle.id) }
    }
    const review = unwrap(await getReview(ctx.admin, ctx.fundId, vehicle, { id: input.review_id, periodEnd: input.period_end }))
    const settings = await loadSettings(ctx.admin, ctx.fundId, vehicle.id)
    return { ...present(review, input.severity), ...(settings.instructions ? { instructions: settings.instructions } : {}) }
  },

  statement_review_note: async (ctx: AgentToolContext, input: Record<string, unknown>) => {
    const vehicle = await vehicleOf(ctx)
    const r = unwrap(await noteFinding(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId }, vehicle, input?.review_id, {
      key: input?.key, status: input?.status, note: input?.note, question: input?.question,
    }))
    const open = blocking(r.review.findings).length
    return {
      vehicle: vehicle.name, reviewId: r.review.id, saved: true,
      finding: { key: r.finding.key, status: r.finding.status, ...(r.finding.note ? { note: r.finding.note } : {}), message: r.finding.message },
      openToSignOff: open,
      next: open ? `${open} error${open === 1 ? '' : 's'} or warning${open === 1 ? '' : 's'} still open before the period can be signed off.` : 'Nothing is open: the period can be signed off when the person is ready (statement_review_sign_off).',
    }
  },

  statement_review_sign_off: async (ctx: AgentToolContext, input: Record<string, unknown>) => {
    const vehicle = await vehicleOf(ctx)
    const r = unwrap(await signOffReview(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId }, vehicle, input?.review_id, input?.note))
    return { vehicle: vehicle.name, reviewId: r.id, period: { start: r.periodStart, end: r.periodEnd }, signOff: r.signOff }
  },

  statement_review_export: async (ctx: AgentToolContext, input: { period_end?: string; review_id?: string; content?: string }) => {
    const vehicle = await vehicleOf(ctx)
    const review = unwrap(await getReview(ctx.admin, ctx.fundId, vehicle, { id: input?.review_id, periodEnd: input?.period_end }))
    const content = input?.content === 'review' ? 'review' : 'questions'
    let pdf: { url: string; expires_at: string; note: string } | null = null
    if (ctx.userId) {
      const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId: ctx.userId, kind: 'statement_review', args: { vehicle: vehicle.name, review: review.id } })
      pdf = { url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt, note: linkNote('It opens the review PDF for an hour, and only for this member.') }
    }
    return {
      vehicle: vehicle.name, reviewId: review.id, period: { start: review.periodStart, end: review.periodEnd },
      questions: draftQuestions(review.findings).reduce((n, g) => n + g.questions.length, 0),
      markdown: content === 'review' ? reviewMarkdown(review) : questionsMarkdown(review),
      ...(pdf ? { pdf } : {}),
      next: content === 'questions'
        ? 'Show the person the questions. Mark each finding they send as asked (statement_review_note) so the review records it.'
        : 'Share the review as the person asks: the Markdown as is, or the PDF link.',
    }
  },

  statement_review_settings: async (ctx: AgentToolContext) => {
    const vehicle = await vehicleOf(ctx)
    return { vehicle: vehicle.name, ...(await loadSettings(ctx.admin, ctx.fundId, vehicle.id)) }
  },

  statement_review_settings_save: async (ctx: AgentToolContext, input: Record<string, unknown>) => {
    const vehicle = await vehicleOf(ctx)
    const saved = unwrap(await saveSettings(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId }, vehicle.id, input ?? {}))
    return { vehicle: vehicle.name, saved: true, ...saved, next: 'The settings apply from the next statement_review_run.' }
  },
}
