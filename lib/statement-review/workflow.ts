// The findings workflow (stage 5 of docs/spec/statement-review.md): what a reviewer does with a
// finding, the questions open findings turn into, and when a period can be signed off. Pure; the
// store saves what these return.
//
//   open      → nobody has looked at it yet
//   explained → the reviewer knows why (a note says so); also what a known adjustment sets
//   asked     → it's a question for the administrator
//   accepted  → the reviewer accepts the figure as stated (a note says why)
//
// Information findings never hold a sign-off. Errors and warnings do while they are open.

import { normName } from './checks/shared'
import { fmt } from './compare'
import type { Finding, FindingStatus, Severity } from './types'

export const FINDING_STATUSES: FindingStatus[] = ['open', 'explained', 'asked', 'accepted']

/** A finding's identity across runs: check, subject, and the message with its figures taken out. */
export function findingKey(f: Pick<Finding, 'check' | 'subject' | 'message'>): string {
  const subject = f.subject.id ?? normName(f.subject.label)
  const skeleton = f.message.replace(/\(?-?[\d][\d,]*(?:\.\d+)?\)?%?/g, '#').replace(/\s+/g, ' ').trim()
  return `${f.check}|${f.subject.kind}|${subject}|${skeleton}`
}

/** Give every finding its key. */
export function keyed(findings: Finding[]): Finding[] {
  return findings.map(f => (f.key ? f : { ...f, key: findingKey(f) }))
}

/**
 * Carry what a reviewer decided on the period's previous run to this run's findings with the same
 * key. Only a reviewer's own decision carries (one with statusBy); a known adjustment's is
 * recomputed every run. A finding the reviewer had closed and that is still there keeps its status.
 */
export function carryStatuses(findings: Finding[], previous: Finding[]): Finding[] {
  const decided = new Map<string, Finding>()
  for (const p of previous) {
    const k = p.key ?? findingKey(p)
    if (p.statusBy || p.question) decided.set(k, p)
  }
  if (!decided.size) return findings
  return findings.map(f => {
    const p = decided.get(f.key ?? findingKey(f))
    if (!p) return f
    // A known adjustment already explained it this run: keep that, but keep the reviewer's question.
    if (f.status === 'explained' && f.adjustedFrom && !p.statusBy) return p.question ? { ...f, question: p.question } : f
    return {
      ...f,
      ...(p.statusBy ? { status: p.status, statusBy: p.statusBy, ...(p.statusAt ? { statusAt: p.statusAt } : {}), ...(p.note ? { note: p.note } : {}) } : {}),
      ...(p.question ? { question: p.question } : {}),
    }
  })
}

export interface NoteInput {
  key?: unknown
  status?: unknown
  note?: unknown
  question?: unknown
}

/** Set one finding's status, note or question. The updated findings, or what is wrong with the input. */
export function applyNote(findings: Finding[], input: NoteInput, by: string, at = new Date().toISOString()): { findings: Finding[]; finding: Finding } | string {
  if (typeof input.key !== 'string' || !input.key) return 'key is required: the finding to change (statement_review_findings gives each finding its key).'
  const i = findings.findIndex(f => (f.key ?? findingKey(f)) === input.key)
  if (i < 0) return 'No finding with that key in this review. Run statement_review_findings for the current keys.'
  const f = findings[i]
  const status = input.status == null ? f.status : input.status
  if (!FINDING_STATUSES.includes(status as FindingStatus)) return `status must be one of ${FINDING_STATUSES.join(', ')}`
  const note = input.note === undefined ? f.note : typeof input.note === 'string' ? input.note.trim().slice(0, 2000) : ''
  const question = input.question === undefined ? f.question : typeof input.question === 'string' ? input.question.trim().slice(0, 2000) : ''
  if ((status === 'explained' || status === 'accepted') && !note) {
    return `A finding marked ${status} needs a note saying why, so the sign-off record shows it.`
  }
  const next: Finding = { ...f, key: f.key ?? findingKey(f), status: status as FindingStatus }
  if (note) next.note = note; else delete next.note
  if (question) next.question = question; else delete next.question
  if (input.status !== undefined || input.note !== undefined) {
    if (status === 'open' && !note) { delete next.statusBy; delete next.statusAt }
    else { next.statusBy = by; next.statusAt = at }
    // A reviewer reopening a finding a known adjustment explained puts its own severity back.
    if (status === 'open' && f.adjustedFrom) { next.severity = f.adjustedFrom; delete next.adjustedFrom }
  }
  const out = findings.slice()
  out[i] = next
  return { findings: out, finding: next }
}

/** Findings that hold a sign-off: errors and warnings still open. */
export function blocking(findings: Finding[]): Finding[] {
  return findings.filter(f => f.status === 'open' && (f.severity === 'error' || f.severity === 'warning'))
}

export function statusCounts(findings: Finding[]): Record<FindingStatus, number> {
  const out: Record<FindingStatus, number> = { open: 0, explained: 0, asked: 0, accepted: 0 }
  for (const f of findings) out[f.status]++
  return out
}

/** The severity counts as the findings now stand (a reopened adjustment changes them). */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) out[f.severity]++
  return out
}

/** The question a finding puts to the administrator: the reviewer's own, else one drafted from it. */
export function questionFor(f: Finding): string {
  if (f.question) return f.question
  const where = f.cites[0]
  const at = where ? ` (${where.document}${where.page ? `, page ${where.page}` : ''}${where.label ? `, "${where.label}"` : ''})` : ''
  switch (f.check) {
    case 'sources':
      return `${f.message} Please confirm the figure${at}.`
    case 'completeness':
    case 'ledger_flows':
      return `${f.message} Please confirm whether this is right, or send a corrected schedule.`
    case 'management_fee':
    case 'carry':
    case 'allocation':
      return `${f.message} Please send the calculation behind the figure${at}.`
    default:
      return f.stated != null && f.expected != null
        ? `${f.message} Please explain the difference of ${fmt((f.stated ?? 0) - (f.expected ?? 0))}${at}, or correct the figure.`
        : `${f.message} Please explain${at}.`
  }
}

export interface QuestionGroup {
  /** The document the questions are about, or "General" for those that cite none. */
  document: string
  questions: { key: string; page?: number; subject: string; severity: Severity; status: FindingStatus; text: string }[]
}

/**
 * The questions for the administrator: every error and warning still open or marked asked, grouped
 * by the document it cites and ordered by page.
 */
export function draftQuestions(findings: Finding[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>()
  for (const f of findings) {
    if (f.status !== 'open' && f.status !== 'asked') continue
    if (f.severity === 'info' && f.status !== 'asked') continue
    const cite = f.cites[0]
    const document = cite?.document ?? 'General'
    const g = groups.get(document) ?? { document, questions: [] }
    g.questions.push({
      key: f.key ?? findingKey(f), ...(cite?.page ? { page: cite.page } : {}), subject: f.subject.label,
      severity: f.severity, status: f.status, text: questionFor(f),
    })
    groups.set(document, g)
  }
  const list = [...groups.values()]
  for (const g of list) g.questions.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9))
  // Documents first, in the order they're named; the general questions last.
  return list.sort((a, b) => (a.document === 'General' ? 1 : 0) - (b.document === 'General' ? 1 : 0) || a.document.localeCompare(b.document))
}
