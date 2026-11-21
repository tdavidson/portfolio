'use client'

// The findings workflow on the review page: a status and note on each finding, the questions for
// the administrator, sign-off and export (lib/statement-review/workflow.ts, export.ts).

import { useState } from 'react'
import { Check, Copy, Download, Loader2, ShieldCheck } from 'lucide-react'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Finding, FindingStatus } from '@/lib/statement-review/types'
import { blocking, draftQuestions, findingKey } from '@/lib/statement-review/workflow'

export interface WorkflowReview {
  id: string
  current: boolean
  findings: Finding[]
  signOff: { at: string; byName?: string; note?: string } | null
}

const STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', explained: 'Explained', asked: 'Asked', accepted: 'Accepted' }

/** A finding's status, and the note a reviewer gives with it. */
export function FindingStatusControl({ review, finding, canEdit, onSaved }: {
  review: WorkflowReview
  finding: Finding
  canEdit: boolean
  onSaved: (r: any) => void
}) {
  const lf = useLedgerFetch()
  const [status, setStatus] = useState<FindingStatus>(finding.status)
  const [note, setNote] = useState(finding.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = !canEdit || !review.current || !!review.signOff
  const dirty = status !== finding.status || note !== (finding.note ?? '')

  if (locked) {
    return <span className="text-xs text-muted-foreground">{STATUS_LABEL[finding.status]}</span>
  }

  async function save() {
    setBusy(true); setError(null)
    try {
      const res = await lf('/api/accounting/statement-review/findings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_id: review.id, key: finding.key ?? findingKey(finding), status, note }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Could not save.'); return }
      onSaved(d.review)
    } finally { setBusy(false) }
  }

  const needsNote = (status === 'explained' || status === 'accepted') && !note.trim()
  return (
    <div className="space-y-1 min-w-40">
      <select value={status} onChange={e => setStatus(e.target.value as FindingStatus)} aria-label="Status"
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
        {(Object.keys(STATUS_LABEL) as FindingStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      {(status !== 'open' || note) && (
        <Input value={note} onChange={e => setNote(e.target.value)} placeholder={status === 'asked' ? 'Note (optional)' : 'Why'} className="h-8 text-xs" />
      )}
      {dirty && (
        <Button size="sm" variant="secondary" className="h-7 w-full" onClick={save} disabled={busy || needsNote}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/** The questions for the administrator, sign-off and export. */
export function ReviewWorkflowBar({ review, canEdit, onSaved }: { review: WorkflowReview; canEdit: boolean; onSaved: (r: any) => void }) {
  const lf = useLedgerFetch()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const groups = draftQuestions(review.findings)
  const open = blocking(review.findings).length
  const total = groups.reduce((n, g) => n + g.questions.length, 0)

  async function signOff() {
    setBusy(true); setError(null)
    try {
      const res = await lf('/api/accounting/statement-review/sign-off', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_id: review.id, note }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Could not sign off.'); return }
      onSaved(d)
    } finally { setBusy(false) }
  }

  async function copyQuestions() {
    let n = 0
    const text = groups.map(g => `${g.document}\n${g.questions.map(q => `${++n}. ${q.page ? `(Page ${q.page}) ` : ''}${q.text}`).join('\n')}`).join('\n\n')
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard blocked */ }
  }

  const exportUrl = (format: string) => `/api/accounting/statement-review/export?id=${encodeURIComponent(review.id)}&format=${format}`
  async function download(format: string) {
    const res = await lf(exportUrl(format))
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error ?? 'Could not export.'); return }
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `statement-review.${format === 'pdf' ? 'pdf' : 'md'}`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = name; a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {review.signOff ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <ShieldCheck className="h-4 w-4" /> Signed off {review.signOff.at.slice(0, 10)}{review.signOff.byName ? ` by ${review.signOff.byName}` : ''}
          </span>
        ) : !review.current ? (
          <span className="text-sm text-muted-foreground">An earlier run. The latest run of this period is its review.</span>
        ) : canEdit ? (
          <>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Sign-off note (optional)" className="h-9 w-64" />
            <Button size="sm" onClick={signOff} disabled={busy || open > 0} title={open ? 'Mark every open error and warning first' : undefined}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />} Sign off
            </Button>
            {open > 0 && <span className="text-xs text-muted-foreground">{open} error{open === 1 ? '' : 's'} or warning{open === 1 ? '' : 's'} still open</span>}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Not signed off.</span>
        )}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => download('pdf')}><Download className="h-4 w-4 mr-1" /> PDF</Button>
          <Button size="sm" variant="ghost" onClick={() => download('md')}><Download className="h-4 w-4 mr-1" /> Markdown</Button>
        </span>
      </div>
      {review.signOff?.note && <p className="text-xs text-muted-foreground">{review.signOff.note}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {total > 0 && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Questions for the administrator ({total})</summary>
          <div className="mt-2 space-y-3">
            {groups.map(g => (
              <div key={g.document}>
                <p className="text-xs font-medium text-muted-foreground">{g.document}</p>
                <ol className="list-decimal pl-5 text-sm space-y-1">
                  {g.questions.map(q => <li key={q.key}>{q.page ? <span className="text-muted-foreground">Page {q.page}. </span> : null}{q.text}</li>)}
                </ol>
              </div>
            ))}
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={copyQuestions}>
                {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />} {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => download('questions')}><Download className="h-4 w-4 mr-1" /> Download</Button>
            </div>
            <p className="text-xs text-muted-foreground">Mark each finding you send as Asked, so the review records it.</p>
          </div>
        </details>
      )}
    </div>
  )
}
