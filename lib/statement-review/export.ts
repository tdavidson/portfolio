// A review as a document the CFO can send or file: the questions for the administrator, grouped by
// document, then the checks, the findings with their statuses and notes, and the sign-off record.
// Markdown (for an assistant to paste or put in a document) and HTML for the PDF (export-pdf.ts).
// Pure.

import { fmt } from './compare'
import type { StoredReview } from './store'
import { CHECK_LABELS, type Finding, type FindingStatus, type Severity } from './types'
import { draftQuestions } from './workflow'

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Info' }
const STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', explained: 'Explained', asked: 'Asked', accepted: 'Accepted' }

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function signOffLine(r: StoredReview): string {
  if (!r.signOff) return 'Not signed off.'
  return `Signed off ${r.signOff.at.slice(0, 10)}${r.signOff.byName ? ` by ${r.signOff.byName}` : ''}.${r.signOff.note ? ` ${r.signOff.note}` : ''}`
}

/** The administrator's questions alone, as Markdown: what to send. */
export function questionsMarkdown(r: StoredReview): string {
  const groups = draftQuestions(r.findings)
  if (!groups.length) return `No open questions for ${r.vehicle} for the period ending ${r.periodEnd}.`
  const out = [`# Questions on ${r.vehicle}'s statements for the period ending ${r.periodEnd}`, '']
  let n = 0
  for (const g of groups) {
    out.push(`## ${g.document}`, '')
    for (const q of g.questions) out.push(`${++n}. ${q.page ? `(Page ${q.page}) ` : ''}${q.text}`)
    out.push('')
  }
  return out.join('\n').trim()
}

/** The whole review as Markdown. */
export function reviewMarkdown(r: StoredReview): string {
  const out: string[] = [
    `# Statement review: ${r.vehicle}, ${r.periodStart} to ${r.periodEnd}`,
    '',
    `Run ${r.runAt.slice(0, 16).replace('T', ' ')} UTC. Materiality ${fmt(r.threshold)}${r.nav != null ? ` against NAV of ${fmt(r.nav)}` : ''}. ${signOffLine(r)}`,
    '',
    `${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} for information.`,
    '',
  ]
  if (r.package.documents?.length) {
    out.push('Documents: ' + r.package.documents.map(d => `${d.name}${d.hash ? ` (SHA-256 ${d.hash.slice(0, 12)}…)` : ''}`).join('; ') + '.', '')
  }
  const q = questionsMarkdown(r).split('\n').slice(1).join('\n').trim()
  out.push('## Questions for the administrator', '', q.replace(/^## /gm, '### ') || 'None.', '')
  out.push('## Checks', '', '| Check | Ran | Compared | Note |', '| --- | --- | ---: | --- |')
  for (const c of r.checks) out.push(`| ${CHECK_LABELS[c.check]} | ${c.ran ? 'Yes' : 'No'} | ${c.compared} | ${md(c.note ?? '')} |`)
  out.push('', '## Findings', '')
  if (!r.findings.length) out.push('None.')
  else {
    out.push('| Severity | Status | Check | Subject | Finding | Note |', '| --- | --- | --- | --- | --- | --- |')
    for (const f of r.findings) {
      out.push(`| ${SEVERITY_LABEL[f.severity]} | ${STATUS_LABEL[f.status]} | ${CHECK_LABELS[f.check]} | ${md(f.subject.label)} | ${md(f.message)}${citeText(f) ? ` (${md(citeText(f))})` : ''} | ${md(f.note ?? '')} |`)
    }
  }
  return out.join('\n')
}

function citeText(f: Finding): string {
  return f.cites.map(c => `${c.document}${c.page ? `, p. ${c.page}` : ''}`).join('; ')
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The whole review as an HTML page for the PDF renderer. */
export function reviewHtml(r: StoredReview, fontCss = ''): string {
  const groups = draftQuestions(r.findings)
  let n = 0
  const questions = groups.length
    ? groups.map(g => `<h3>${esc(g.document)}</h3><ol start="${n + 1}">${g.questions.map(q => { n++; return `<li>${q.page ? `<span class="muted">Page ${q.page}.</span> ` : ''}${esc(q.text)}</li>` }).join('')}</ol>`).join('')
    : '<p>None.</p>'
  const checks = r.checks.map(c => `<tr><td>${esc(CHECK_LABELS[c.check])}</td><td>${c.ran ? 'Yes' : 'No'}</td><td class="num">${c.compared}</td><td>${esc(c.note ?? '')}</td></tr>`).join('')
  const findings = r.findings.length
    ? `<table><thead><tr><th>Severity</th><th>Status</th><th>Check</th><th>Subject</th><th>Finding</th><th>Note</th></tr></thead><tbody>${r.findings.map(f =>
        `<tr><td class="sev-${f.severity}">${SEVERITY_LABEL[f.severity]}</td><td>${STATUS_LABEL[f.status]}</td><td>${esc(CHECK_LABELS[f.check])}</td><td>${esc(f.subject.label)}</td><td>${esc(f.message)}${citeText(f) ? `<div class="muted">${esc(citeText(f))}</div>` : ''}</td><td>${esc(f.note ?? '')}</td></tr>`).join('')}</tbody></table>`
    : '<p>None.</p>'
  const docs = r.package.documents?.length
    ? `<p class="muted">Documents: ${r.package.documents.map(d => `${esc(d.name)}${d.hash ? ` (SHA-256 ${esc(d.hash)})` : ''}`).join('; ')}</p>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss}
body { font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; margin: 32px; }
h1 { font-size: 16pt; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 12pt; font-weight: 600; margin: 20px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
h3 { font-size: 10.5pt; font-weight: 600; margin: 12px 0 4px; }
.muted { color: #666; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th, td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #eee; }
th { font-weight: 500; color: #555; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sev-error { color: #b42318; } .sev-warning { color: #b54708; }
ol { padding-left: 20px; } li { margin: 3px 0; }
</style></head><body>
<h1>Statement review: ${esc(r.vehicle)}</h1>
<p class="muted">${esc(r.periodStart)} to ${esc(r.periodEnd)} · run ${esc(r.runAt.slice(0, 16).replace('T', ' '))} UTC · materiality ${esc(fmt(r.threshold))}${r.nav != null ? ` against NAV of ${esc(fmt(r.nav))}` : ''}</p>
<p>${esc(signOffLine(r))} ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} for information.</p>
${docs}
<h2>Questions for the administrator</h2>${questions}
<h2>Checks</h2><table><thead><tr><th>Check</th><th>Ran</th><th class="num">Compared</th><th>Note</th></tr></thead><tbody>${checks}</tbody></table>
<h2>Findings</h2>${findings}
</body></html>`
}

export function reviewFileName(r: Pick<StoredReview, 'vehicle' | 'periodEnd'>, ext: string): string {
  const safe = r.vehicle.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'vehicle'
  return `statement-review-${safe}-${r.periodEnd}.${ext}`
}
