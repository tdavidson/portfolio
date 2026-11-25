'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useLpPortalEnabled } from '@/components/feature-visibility-context'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Loader2, Send, CheckCircle2, ArrowLeft, Paperclip, Users, FlaskConical } from 'lucide-react'

interface Investor { id: string; name: string }

type Delivery = 'link' | 'attachment' | 'both'
type SendResult = { sent: number; primaryRecipients: number; ccRecipients: number; failures: string[] }
type Recipient = { to: string; name: string | null; cc: string[]; investorCount: number; via?: 'portal' | 'contact' }
type PreviewData = { subject: string; itemTitle: string; fromName: string; html: string; attachment: boolean; recipients: Recipient[] }

const DELIVERY_OPTIONS: { value: Delivery; label: string; hint: string }[] = [
  { value: 'link', label: 'Secure portal link', hint: 'LPs sign in to view and download.' },
  { value: 'attachment', label: 'PDF attachment', hint: 'Attach the file directly to the email.' },
  { value: 'both', label: 'Both', hint: 'Include the portal link and attach the PDF.' },
]

const KIND_LABEL: Record<'snapshot' | 'letter' | 'document', string> = {
  snapshot: 'statement', letter: 'letter', document: 'document',
}

/**
 * A "Send to LPs" button + modal for emailing an already-shared item to selected LPs.
 *
 * Two steps by design, because this actually sends email to investors: first COMPOSE
 * (recipients, delivery, subject, message), then REVIEW — a no-send preview that shows the exact
 * addresses each email goes To and Cc (authorized users are Cc'd automatically), and renders the
 * email itself — before a final Send. Nothing goes out until the review step is confirmed.
 * "Send a test to me" on the review step sends the first recipient's copy to the sender only.
 *
 * LPs with no portal account are emailed too, at the contact or notice email on their record, and
 * their copy always carries the PDF: the review marks them.
 */
export function LpSendControl({ kind, id, itemTitle }: {
  kind: 'snapshot' | 'letter' | 'document'; id: string; itemTitle?: string
}) {
  const lpPortalEnabled = useLpPortalEnabled()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<'compose' | 'review' | 'result'>('compose')
  const [eligible, setEligible] = useState<Investor[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [portalEnabled, setPortalEnabled] = useState<boolean | null>(null)

  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [delivery, setDelivery] = useState<Delivery>('link')

  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<string | null>(null)

  const kindLabel = KIND_LABEL[kind]

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch(`/api/lps/send?kind=${kind}&id=${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : { investors: [], portalEnabled: null }))
      .then(data => {
        const invs = (Array.isArray(data.investors) ? data.investors : []).map((i: any) => ({ id: i.id, name: i.name }))
        setEligible(invs)
        setSelected(new Set(invs.map((i: Investor) => i.id))) // default: everyone who can see it
        setPortalEnabled(data.portalEnabled ?? null)
      })
      .finally(() => setLoading(false))
  }, [open, kind, id])

  const allSelected = eligible.length > 0 && eligible.every(i => selected.has(i.id))

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const body = () => ({ kind, id, lp_investor_ids: Array.from(selected), subject, message, delivery })

  async function goReview() {
    setPreviewing(true); setError(null)
    try {
      const res = await fetch('/api/lps/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body(), preview: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not prepare the preview.'); return }
      if (!data.recipients || data.recipients.length === 0) {
        setError('None of the selected LPs has a portal account, contact email or notice email. Add an email on the investor or entity profile.')
        return
      }
      setPreview(data as PreviewData)
      setStage('review')
    } catch {
      setError('Could not prepare the preview.')
    } finally {
      setPreviewing(false)
    }
  }

  async function sendTest() {
    setTesting(true); setError(null); setTestNote(null)
    try {
      const res = await fetch('/api/lps/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body(), test: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not send the test.'); return }
      setTestNote(`Test sent to ${data.sentTo}${data.sampleOf ? `, showing ${data.sampleOf}'s copy` : ''}. Nothing went to any LP.`)
    } catch {
      setError('Could not send the test.')
    } finally {
      setTesting(false)
    }
  }

  async function send() {
    setSending(true); setError(null)
    try {
      const res = await fetch('/api/lps/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not send.'); return }
      setResult(data as SendResult)
      setStage('result')
    } catch {
      setError('Could not send.')
    } finally {
      setSending(false)
    }
  }

  function reset() {
    setStage('compose'); setResult(null); setPreview(null); setError(null); setTestNote(null)
    setSubject(''); setMessage(''); setDelivery('link')
  }

  // With the portal off there is nobody to send to: eligible recipients ARE the investors the
  // item is shared with, and sharing is a portal action. Hooks run first, then bail.
  if (!lpPortalEnabled) return null

  const totalTo = preview?.recipients.length ?? 0
  const totalCc = preview?.recipients.reduce((a, r) => a + r.cc.length, 0) ?? 0

  return (
    <>
      <Button variant="outline" size="sm" className="text-muted-foreground" onClick={() => { reset(); setOpen(true) }}>
        <Send className="h-4 w-4 mr-1" />
        Send to LPs
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {stage === 'review' ? 'Review before sending' : stage === 'result' ? 'Sent' : 'Send to LPs'}
            </DialogTitle>
            <DialogDescription>
              {stage === 'review'
                ? 'This is exactly what will be emailed, and to whom. Nothing has been sent yet.'
                : `Email this ${kindLabel} to selected LPs. Authorized users on each LP's account are Cc'd automatically.`}
            </DialogDescription>
          </DialogHeader>

          {/* ---- RESULT ---- */}
          {stage === 'result' && result ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-success/50 bg-success-subtle dark:bg-success-subtle/30 px-3 py-2.5 text-sm text-success">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  Sent to {result.sent} LP{result.sent === 1 ? '' : 's'}
                  {result.ccRecipients > 0 && `, plus ${result.ccRecipients} authorized user${result.ccRecipients === 1 ? '' : 's'}`}.
                  {result.failures.length > 0 && (
                    <div className="text-warning mt-1">{result.failures.length} failed: {result.failures.join(', ')}</div>
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={reset}>Send another</Button>
                <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>

          /* ---- REVIEW ---- */
          ) : stage === 'review' && preview ? (
            <div className="space-y-4 min-w-0">
              {/* Recipients — the actual addresses */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Recipients — {totalTo} To{totalCc > 0 ? `, ${totalCc} Cc` : ''}
                </label>
                <div className="rounded-md border divide-y max-h-[26vh] overflow-y-auto text-sm">
                  {preview.recipients.map((r, i) => (
                    <div key={i} className="px-3 py-2 min-w-0">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-6">To</span>
                        <span className="font-mono text-xs truncate">{r.to}</span>
                        {r.name && <span className="text-xs text-muted-foreground truncate">({r.name})</span>}
                      </div>
                      {r.via === 'contact' && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 pl-8">No portal account: contact email on file, PDF attached</div>
                      )}
                      {r.cc.map((c, j) => (
                        <div key={j} className="flex items-baseline gap-2 min-w-0 mt-0.5">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 w-6">Cc</span>
                          <span className="font-mono text-xs truncate text-muted-foreground">{c}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* The email itself */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <div className="rounded-md border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 text-xs space-y-0.5">
                    <div><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{preview.subject}</span></div>
                    {preview.attachment && (
                      <div className="flex items-center gap-1 text-muted-foreground"><Paperclip className="h-3 w-3" /> PDF attached</div>
                    )}
                  </div>
                  <iframe title="Email preview" srcDoc={preview.html} className="w-full h-64 bg-white" sandbox="" />
                </div>
              </div>

              {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}
              {testNote && <div className="text-sm rounded-md border border-success/50 bg-success-subtle dark:bg-success-subtle/30 px-2.5 py-2 text-success">{testNote}</div>}

              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setStage('compose'); setError(null); setTestNote(null) }} disabled={sending || testing}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Edit
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={sendTest} disabled={sending || testing}>
                    {testing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />}
                    Send a test to me
                  </Button>
                  <Button size="sm" onClick={send} disabled={sending || testing}>
                    {sending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                    Send to {totalTo} LP{totalTo === 1 ? '' : 's'}
                  </Button>
                </div>
              </div>
            </div>

          /* ---- COMPOSE ---- */
          ) : (
            <div className="space-y-4 min-w-0">
              {portalEnabled === false && delivery !== 'attachment' && (
                <div className="text-sm rounded-md border border-warning/50 bg-warning-subtle dark:bg-warning-subtle/30 text-warning px-2.5 py-2">
                  The LP portal is off, so portal links won&apos;t work. Enable it in{' '}
                  <a href="/settings" className="underline">Settings → LP Portal</a>, or send as a PDF attachment.
                </div>
              )}

              {loading ? (
                <div className="text-xs text-muted-foreground py-4"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" /> Loading…</div>
              ) : eligible.length === 0 ? (
                <div className="text-xs text-muted-foreground py-4">
                  This {kindLabel} isn&apos;t shared with any LPs yet.{kind === 'document' ? ' Share it from the upload form above.' : ' Use “Share with LPs” first.'}
                </div>
              ) : (
                <>
                  {/* Recipients */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Recipients ({selected.size} of {eligible.length})</label>
                      <button onClick={() => setSelected(allSelected ? new Set() : new Set(eligible.map(i => i.id)))} className="text-[11px] text-primary hover:underline">
                        {allSelected ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="rounded-md border divide-y max-h-[28vh] overflow-y-auto min-w-0">
                      {eligible.map(inv => (
                        <label key={inv.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/30 min-w-0">
                          <input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggle(inv.id)} className="h-3.5 w-3.5 shrink-0" />
                          <span className="flex-1 min-w-0 truncate">{inv.name}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">You&apos;ll see the exact email addresses on the next step, before anything sends.</p>
                  </div>

                  {/* Delivery */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Delivery</label>
                    <div className="grid grid-cols-3 gap-2">
                      {DELIVERY_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setDelivery(opt.value)}
                          title={opt.hint}
                          className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${ delivery === opt.value ? 'border-primary bg-primary/5 text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/40' }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{DELIVERY_OPTIONS.find(o => o.value === delivery)?.hint}</p>
                  </div>

                  {/* Subject + message */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Subject</label>
                    <input
                      value={subject}
                      onChange={e => setSubject(e.target.value)}
                      placeholder={itemTitle ? `${itemTitle}` : 'Optional — a default is used if blank'}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Message</label>
                    <textarea
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      rows={4}
                      placeholder="Write a short note to your LPs…"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
                    />
                  </div>

                  {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={previewing}>Cancel</Button>
                    <Button size="sm" onClick={goReview} disabled={previewing || selected.size === 0}>
                      {previewing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                      Review {selected.size} recipient{selected.size === 1 ? '' : 's'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
