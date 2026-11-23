'use client'

import { useState } from 'react'
import { Loader2, Send, CheckCircle2, ArrowLeft, Paperclip, Users, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useLpPortalEnabled } from '@/components/feature-visibility-context'

type Delivery = 'link' | 'attachment' | 'both'
type Mode = 'publish' | 'email'

interface Line { id: string; lpEntityId: string; name: string; amount: number; role?: 'lp' | 'carry' }
interface Recipient {
  lpEntityId: string; name: string; amount: number; to: string | null; cc: string[]; skipped: string | null
  published: boolean; lastSentAt: string | null
}
interface Preview { recipients: Recipient[]; portalEnabled: boolean; hasProvider: boolean; subject: string; html: string }
interface Result { count: number; published: { name: string; reused: boolean }[]; errors: string[]; sent?: number; failures?: string[]; skipped?: string[] }

const DELIVERY_OPTIONS: { value: Delivery; label: string; hint: string }[] = [
  { value: 'link', label: 'Secure portal link', hint: 'LPs sign in to view and download.' },
  { value: 'attachment', label: 'PDF attachment', hint: 'Attach the notice directly to the email.' },
  { value: 'both', label: 'Both', hint: 'Include the portal link and attach the PDF.' },
]

/**
 * Notices for a declared call or distribution: publish to each partner's portal, or publish AND
 * email in one go.
 *
 * Two steps when email is involved, because this actually sends money demands to investors:
 * COMPOSE (which partners, link or attachment, subject, message), then REVIEW — the exact To and
 * Cc for every partner, who would be skipped and why, and the email itself — before Send.
 * Publishing is idempotent: a partner whose notice already exists keeps the same document.
 */
/**
 * One row per partner: a GP's LP line and carry line go out on one notice, so they are picked
 * together and show their total, marked as including carry.
 */
export function partnerRows(lines: Line[]): (Line & { hasCarry: boolean })[] {
  const out = new Map<string, Line & { hasCarry: boolean }>()
  for (const l of lines) {
    const prev = out.get(l.lpEntityId)
    if (!prev) { out.set(l.lpEntityId, { ...l, hasCarry: l.role === 'carry' }); continue }
    out.set(l.lpEntityId, {
      ...prev,
      amount: Math.round((prev.amount + l.amount) * 100) / 100,
      role: prev.role === 'lp' || l.role === 'lp' ? 'lp' : 'carry',
      hasCarry: prev.hasCarry || l.role === 'carry',
    })
  }
  return Array.from(out.values())
}

export function NoticeAction({ kind, id, lines: registerLines, fmt }: {
  kind: 'capital_call' | 'distribution'
  id: string
  lines: Line[]
  fmt: (v: number) => string
}) {
  const lines = partnerRows(registerLines)
  const lf = useLedgerFetch()
  const lpPortalEnabled = useLpPortalEnabled()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('email')
  const [stage, setStage] = useState<'compose' | 'review' | 'result'>('compose')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [delivery, setDelivery] = useState<Delivery>('both')
  const [regenerate, setRegenerate] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  // The last-sent state per partner, loaded on open so the compose step can say "sent 3 Mar".
  const [status, setStatus] = useState<Map<string, Recipient> | null>(null)

  const noun = kind === 'capital_call' ? 'call notice' : 'distribution notice'

  function start() {
    setSelected(new Set(lines.map(l => l.lpEntityId)))
    setStage('compose'); setPreview(null); setResult(null); setError(null)
    setSubject(''); setMessage(''); setRegenerate(false)
    setMode(lpPortalEnabled ? 'email' : 'publish')
    setStatus(null)
    setOpen(true)
    lf('/api/accounting/notices/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, preview: true }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.recipients) setStatus(new Map((d.recipients as Recipient[]).map(r => [r.lpEntityId, r]))) })
      .catch(() => {})
  }

  const body = () => ({
    kind, id,
    lpEntityIds: Array.from(selected),
    regenerate,
    ...(mode === 'email' ? { email: { subject: subject || undefined, message, delivery } } : {}),
  })

  async function review() {
    setBusy(true); setError(null)
    try {
      const res = await lf('/api/accounting/notices/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body(), preview: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Could not prepare the preview.'); return }
      setPreview(d as Preview)
      setStage('review')
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    setBusy(true); setError(null)
    try {
      const res = await lf('/api/accounting/notices/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Could not publish the notices'); return }
      setResult(d as Result)
      setStage('result')
    } finally {
      setBusy(false)
    }
  }

  const allSelected = lines.length > 0 && lines.every(l => selected.has(l.lpEntityId))
  const toggle = (lpEntityId: string) => setSelected(prev => { const n = new Set(prev); n.has(lpEntityId) ? n.delete(lpEntityId) : n.add(lpEntityId); return n })
  const willSend = preview?.recipients.filter(r => selected.has(r.lpEntityId) && !r.skipped) ?? []
  const willSkip = preview?.recipients.filter(r => selected.has(r.lpEntityId) && r.skipped) ?? []
  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={start}>
        <Send className="h-3.5 w-3.5 mr-1" />Notices
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {stage === 'review' ? 'Review before sending' : stage === 'result' ? 'Done' : `Send ${noun}s`}
            </DialogTitle>
            <DialogDescription>
              {stage === 'review'
                ? 'This is exactly who will be emailed, and what. Nothing has been sent yet.'
                : `Each partner gets their own PDF stating the amount on the register. Publish it to their portal, or publish and email it in one step.`}
            </DialogDescription>
          </DialogHeader>

          {stage === 'result' && result ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-success/50 bg-success-subtle dark:bg-success-subtle/30 px-3 py-2.5 text-sm text-success">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  Published {result.count} notice{result.count === 1 ? '' : 's'} to the portal
                  {result.published.some(p => p.reused) ? ` (${result.published.filter(p => p.reused).length} already existed)` : ''}.
                  {typeof result.sent === 'number' && <div>Emailed {result.sent} partner{result.sent === 1 ? '' : 's'}.</div>}
                </div>
              </div>
              {(result.errors.length > 0 || (result.failures?.length ?? 0) > 0 || (result.skipped?.length ?? 0) > 0) && (
                <ul className="space-y-0.5 text-sm text-warning">
                  {result.errors.map((e, i) => <li key={`e${i}`}>{e}</li>)}
                  {result.failures?.map((e, i) => <li key={`f${i}`}>Email failed — {e}</li>)}
                  {result.skipped?.map((e, i) => <li key={`s${i}`}>Not emailed — {e}</li>)}
                </ul>
              )}
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>
          ) : stage === 'review' && preview ? (
            <div className="space-y-4 min-w-0">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> {willSend.length} partner{willSend.length === 1 ? '' : 's'} will be emailed
                </label>
                <div className="rounded-md border divide-y max-h-[26vh] overflow-y-auto text-sm">
                  {willSend.map(r => (
                    <div key={r.lpEntityId} className="px-3 py-2 min-w-0">
                      <div className="flex items-baseline justify-between gap-2 min-w-0">
                        <span className="truncate">{r.name}</span>
                        <span className="tabular-nums text-muted-foreground shrink-0">{fmt(r.amount)}</span>
                      </div>
                      <div className="flex items-baseline gap-2 min-w-0 mt-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-6">To</span>
                        <span className="font-mono text-xs truncate">{r.to}</span>
                      </div>
                      {r.cc.map((c, j) => (
                        <div key={j} className="flex items-baseline gap-2 min-w-0 mt-0.5">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-6">Cc</span>
                          <span className="font-mono text-xs truncate text-muted-foreground">{c}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {willSkip.map(r => (
                    <div key={r.lpEntityId} className="px-3 py-2 text-sm text-warning">{r.name}: published to the portal only — {r.skipped}</div>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <div className="rounded-md border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 text-xs space-y-0.5">
                    <div><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{subject || preview.subject}</span></div>
                    {delivery !== 'link' && <div className="flex items-center gap-1 text-muted-foreground"><Paperclip className="h-3 w-3" /> PDF attached</div>}
                  </div>
                  <iframe title="Email preview" srcDoc={preview.html} className="w-full h-56 bg-white" sandbox="" />
                </div>
                <p className="text-[11px] text-muted-foreground">Each partner&rsquo;s email shows their own amount.</p>
              </div>
              {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setStage('compose'); setError(null) }} disabled={busy}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Edit
                </Button>
                <Button size="sm" onClick={run} disabled={busy || willSend.length === 0}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                  Publish and email {willSend.length}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 min-w-0">
              <div className="inline-flex rounded border border-input overflow-hidden text-xs">
                <button type="button" onClick={() => setMode('email')} disabled={!lpPortalEnabled} className={`px-2.5 py-1.5 ${mode === 'email' ? 'bg-accent text-foreground' : 'text-muted-foreground'} disabled:opacity-50`}>Publish and email</button>
                <button type="button" onClick={() => setMode('publish')} className={`px-2.5 py-1.5 border-l border-input ${mode === 'publish' ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>Publish to portal only</button>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Partners ({selected.size} of {lines.length})</label>
                  <button onClick={() => setSelected(allSelected ? new Set() : new Set(lines.map(l => l.lpEntityId)))} className="text-[11px] text-primary hover:underline">
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="rounded-md border divide-y max-h-[28vh] overflow-y-auto min-w-0">
                  {lines.map(l => {
                    const st = status?.get(l.lpEntityId)
                    return (
                      <label key={l.lpEntityId} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/30 min-w-0">
                        <input type="checkbox" checked={selected.has(l.lpEntityId)} onChange={() => toggle(l.lpEntityId)} className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{l.name}{l.hasCarry ? <span className="text-xs text-muted-foreground"> &middot; {l.role === 'carry' ? 'carry' : 'incl. carry'}</span> : null}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {st?.lastSentAt ? `emailed ${fmtDate(st.lastSentAt)}` : st?.published ? 'in portal' : ''}
                        </span>
                        <span className="tabular-nums text-muted-foreground shrink-0">{fmt(l.amount)}</span>
                      </label>
                    )
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={regenerate} onChange={e => setRegenerate(e.target.checked)} className="h-3.5 w-3.5" />
                <FileText className="h-3.5 w-3.5" /> Render fresh PDFs even where a notice already exists
              </label>

              {mode === 'email' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Delivery</label>
                    <div className="space-y-1">
                      {DELIVERY_OPTIONS.map(o => (
                        <label key={o.value} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="notice-delivery" checked={delivery === o.value} onChange={() => setDelivery(o.value)} className="h-3.5 w-3.5" />
                          <span>{o.label}</span>
                          <span className="text-xs text-muted-foreground">{o.hint}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Subject</label>
                    <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Defaults to the fund name and the notice title" className="h-9 w-full px-3 rounded-md border border-input bg-background text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Message</label>
                    <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder={kind === 'capital_call' ? 'e.g. Please wire by the due date; details are on the attached notice.' : 'e.g. Proceeds from the Acme exit; wires go out this week.'} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                  </div>
                </>
              )}

              {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                {mode === 'email' ? (
                  <Button size="sm" onClick={review} disabled={busy || selected.size === 0}>
                    {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Review
                  </Button>
                ) : (
                  <Button size="sm" onClick={run} disabled={busy || selected.size === 0}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}Publish {selected.size}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
