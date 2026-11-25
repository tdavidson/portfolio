'use client'

import { useEffect, useState } from 'react'
import { Loader2, Check, Send, Megaphone, CornerDownRight, ArrowLeft, Users, CheckCircle2, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface Reply { id: string; body: string; created_at: string }
interface Msg {
  id: string
  from_email: string | null
  subject: string | null
  body: string
  status: string
  created_at: string
  investor_name: string | null
  replies: Reply[]
}
interface Announcement { id: string; subject: string | null; body: string; created_at: string; recipients: number; investor_names: string[] }
interface Investor { id: string; name: string }

const fmtWhen = (s: string) => (s ? new Date(s).toLocaleString() : '')

/**
 * The GP's LP message inbox, both directions: questions LPs sent from their portal, the fund's
 * replies under each one (sent from here, emailed to the LP and their authorized users), and
 * announcements to chosen LPs with nothing attached.
 */
export function LpMessagesSection() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyNote, setReplyNote] = useState<string | null>(null)
  const [announceOpen, setAnnounceOpen] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/lps/messages')
      const b = r.ok ? await r.json() : { messages: [], announcements: [] }
      setMessages(b.messages ?? [])
      setAnnouncements(b.announcements ?? [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function setStatus(id: string, status: 'open' | 'resolved') {
    setBusy(id)
    try {
      const r = await fetch('/api/lps/messages', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }),
      })
      if (r.ok) setMessages(prev => prev.map(m => (m.id === id ? { ...m, status } : m)))
    } finally {
      setBusy(null)
    }
  }

  async function sendReply(id: string) {
    if (!replyText.trim()) return
    setBusy(id); setReplyNote(null)
    try {
      const r = await fetch('/api/lps/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyTo: id, body: replyText }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) { setReplyNote(b.error ?? 'Could not send the reply'); return }
      setReplyNote(b.emailed ? `Sent to ${b.to}${b.cc?.length ? `, cc ${b.cc.join(', ')}` : ''}.` : `Recorded, but the email failed: ${b.emailError ?? 'unknown error'}`)
      setReplyFor(null); setReplyText('')
      load()
    } finally {
      setBusy(null)
    }
  }

  const open = messages.filter(m => m.status !== 'resolved')
  const resolved = messages.filter(m => m.status === 'resolved')
  const shown = showResolved ? messages : open

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h4 className="text-base font-semibold flex items-center gap-2">
            Messages
            {open.length > 0 && <span className="text-xs font-normal bg-muted rounded-full px-1.5 py-0.5 text-muted-foreground">{open.length}</span>}
          </h4>
          <p className="text-xs text-muted-foreground">Questions LPs sent from their portal, and your replies. Replies are emailed to the LP and their authorized users, and appear in their portal.</p>
        </div>
        <Button variant="outline" size="sm" className="text-muted-foreground shrink-0" onClick={() => setAnnounceOpen(true)}>
          <Megaphone className="h-4 w-4 mr-1" /> Announcement
        </Button>
      </div>
      {replyNote && <p className="text-sm text-muted-foreground mb-2">{replyNote}</p>}
      {loading ? (
        <div className="text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" /> Loading…</div>
      ) : messages.length === 0 && announcements.length === 0 ? (
        <div className="text-xs text-muted-foreground rounded-card border bg-card p-4">No messages yet.</div>
      ) : (
        <>
          {messages.length > 0 && (
            <div className="rounded-md border bg-card divide-y">
              {shown.map(m => (
                <div key={m.id} className="p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground">
                        {fmtWhen(m.created_at)}
                        {m.investor_name ? ` · ${m.investor_name}` : ''}
                        {m.from_email ? ` · ${m.from_email}` : ''}
                        {m.status === 'resolved' ? ' · resolved' : ''}
                      </div>
                      {m.subject && <div className="font-medium mt-0.5">{m.subject}</div>}
                      <div className="text-sm whitespace-pre-wrap mt-0.5">{m.body}</div>
                      {m.replies.map(r => (
                        <div key={r.id} className="mt-2 flex gap-2 rounded-md bg-muted/40 px-3 py-2">
                          <CornerDownRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="text-xs text-muted-foreground">You replied · {fmtWhen(r.created_at)}</div>
                            <div className="text-sm whitespace-pre-wrap">{r.body}</div>
                          </div>
                        </div>
                      ))}
                      {replyFor === m.id && (
                        <div className="mt-2 space-y-2">
                          <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={3} autoFocus placeholder="Write your reply…" className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => sendReply(m.id)} disabled={busy === m.id || !replyText.trim()}>
                              {busy === m.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />} Send reply
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setReplyFor(null); setReplyText('') }}>Cancel</Button>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {replyFor !== m.id && (
                        <button onClick={() => { setReplyFor(m.id); setReplyText('') }} className="text-[11px] text-primary hover:underline">Reply</button>
                      )}
                      {m.status === 'resolved' ? (
                        <button onClick={() => setStatus(m.id, 'open')} disabled={busy === m.id} className="text-[11px] text-muted-foreground hover:text-foreground">Reopen</button>
                      ) : (
                        <button onClick={() => setStatus(m.id, 'resolved')} disabled={busy === m.id} className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                          {busy === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Resolve
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {shown.length === 0 && <div className="p-3 text-xs text-muted-foreground">Nothing open.</div>}
            </div>
          )}
          {resolved.length > 0 && (
            <button onClick={() => setShowResolved(s => !s)} className="text-[11px] text-muted-foreground hover:text-foreground mt-2">
              {showResolved ? 'Hide resolved' : `Show resolved (${resolved.length})`}
            </button>
          )}
          {announcements.length > 0 && (
            <div className="mt-4">
              <h5 className="text-sm font-medium mb-1.5">Announcements</h5>
              <div className="rounded-md border bg-card divide-y">
                {announcements.map(a => (
                  <div key={a.id} className="p-3 text-sm">
                    <div className="text-xs text-muted-foreground">{fmtWhen(a.created_at)} · to {a.recipients} investor{a.recipients === 1 ? '' : 's'}</div>
                    {a.subject && <div className="font-medium mt-0.5">{a.subject}</div>}
                    <div className="text-sm whitespace-pre-wrap mt-0.5 text-muted-foreground line-clamp-3">{a.body}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <AnnouncementDialog open={announceOpen} onClose={() => setAnnounceOpen(false)} onSent={load} />
    </div>
  )
}

type PreviewData = { subject: string; html: string; recipients: { to: string; name: string | null; cc: string[]; investorCount: number; via?: 'portal' | 'contact' }[]; unreachable: number }

function AnnouncementDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: () => void }) {
  const [stage, setStage] = useState<'compose' | 'review' | 'result'>('compose')
  const [investors, setInvestors] = useState<Investor[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [result, setResult] = useState<{ sent: number; ccRecipients: number; failures: string[] } | null>(null)
  const [testNote, setTestNote] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/lps/investors')
      .then(r => (r.ok ? r.json() : []))
      .then(d => {
        const list: Investor[] = (Array.isArray(d) ? d : d.investors ?? []).map((i: any) => ({ id: i.id, name: i.name }))
        setInvestors(list)
        setSelected(new Set(list.map(i => i.id)))
      })
      .catch(() => {})
  }, [open])

  function reset() { setStage('compose'); setSubject(''); setBody(''); setError(null); setPreview(null); setResult(null); setTestNote(null) }
  const allSelected = investors.length > 0 && investors.every(i => selected.has(i.id))
  const payload = () => ({ subject, body, lp_investor_ids: allSelected ? 'all' : Array.from(selected) })

  async function review() {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/lps/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload(), preview: true }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error ?? 'Could not prepare the preview.'); return }
      setPreview(d as PreviewData); setStage('review')
    } finally { setBusy(false) }
  }
  // The exact email, once, to the sender only. Nothing reaches an LP or their portal.
  async function sendTest() {
    setBusy(true); setError(null); setTestNote(null)
    try {
      const r = await fetch('/api/lps/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload(), test: true }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error ?? 'Could not send the test.'); return }
      setTestNote(`Test sent to ${d.sentTo}. Nothing went to any LP.`)
    } finally { setBusy(false) }
  }
  async function send() {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/lps/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error ?? 'Could not send.'); return }
      setResult(d); setStage('result'); onSent()
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); reset() } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{stage === 'review' ? 'Review before sending' : stage === 'result' ? 'Sent' : 'Send an announcement'}</DialogTitle>
          <DialogDescription>
            {stage === 'review' ? 'This is exactly what will be emailed, and to whom. Nothing has been sent yet.'
              : 'A plain message to your LPs. It is emailed to each LP and their authorized users, and appears in their portal.'}
          </DialogDescription>
        </DialogHeader>

        {stage === 'result' && result ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-success/50 bg-success-subtle dark:bg-success-subtle/30 px-3 py-2.5 text-sm text-success">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                Sent to {result.sent} LP{result.sent === 1 ? '' : 's'}{result.ccRecipients > 0 ? `, plus ${result.ccRecipients} authorized user${result.ccRecipients === 1 ? '' : 's'}` : ''}.
                {result.failures.length > 0 && <div className="text-warning mt-1">{result.failures.length} failed: {result.failures.join(', ')}</div>}
              </div>
            </div>
            <div className="flex justify-end"><Button size="sm" onClick={() => { onClose(); reset() }}>Done</Button></div>
          </div>
        ) : stage === 'review' && preview ? (
          <div className="space-y-4 min-w-0">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {preview.recipients.length} To{preview.recipients.reduce((a, r) => a + r.cc.length, 0) > 0 ? `, ${preview.recipients.reduce((a, r) => a + r.cc.length, 0)} Cc` : ''}</label>
              <div className="rounded-md border divide-y max-h-[24vh] overflow-y-auto text-sm">
                {preview.recipients.map((r, i) => (
                  <div key={i} className="px-3 py-2 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0"><span className="text-[10px] uppercase tracking-wide text-muted-foreground w-6 shrink-0">To</span><span className="font-mono text-xs truncate">{r.to}</span>{r.name && <span className="text-xs text-muted-foreground truncate">({r.name})</span>}</div>
                    {r.via === 'contact' && <div className="text-[11px] text-muted-foreground mt-0.5 pl-8">No portal account: contact email on file</div>}
                    {r.cc.map((c, j) => <div key={j} className="flex items-baseline gap-2 min-w-0 mt-0.5"><span className="text-[10px] uppercase tracking-wide text-muted-foreground w-6 shrink-0">Cc</span><span className="font-mono text-xs truncate text-muted-foreground">{c}</span></div>)}
                  </div>
                ))}
              </div>
              {preview.unreachable > 0 && <p className="text-sm text-warning">{preview.unreachable} selected investor{preview.unreachable === 1 ? ' has' : 's have'} no portal account, contact email or notice email (or portal access disabled) and will not receive it.</p>}
            </div>
            <div className="rounded-md border overflow-hidden">
              <div className="px-3 py-2 border-b bg-muted/40 text-xs"><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{preview.subject}</span></div>
              <iframe title="Email preview" srcDoc={preview.html} className="w-full h-56 bg-white" sandbox="" />
            </div>
            {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}
            {testNote && <div className="text-sm rounded-md border border-success/50 bg-success-subtle dark:bg-success-subtle/30 px-2.5 py-2 text-success">{testNote}</div>}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setStage('compose'); setTestNote(null) }} disabled={busy}><ArrowLeft className="h-4 w-4 mr-1" /> Edit</Button>
              <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={sendTest} disabled={busy}><FlaskConical className="h-4 w-4 mr-1" /> Send a test to me</Button>
              <Button size="sm" onClick={send} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />} Send to {preview.recipients.length} LP{preview.recipients.length === 1 ? '' : 's'}</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 min-w-0">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Recipients ({selected.size} of {investors.length})</label>
                <button onClick={() => setSelected(allSelected ? new Set() : new Set(investors.map(i => i.id)))} className="text-[11px] text-primary hover:underline">{allSelected ? 'Deselect all' : 'Select all'}</button>
              </div>
              <div className="rounded-md border divide-y max-h-[24vh] overflow-y-auto min-w-0">
                {investors.map(inv => (
                  <label key={inv.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/30 min-w-0">
                    <input type="checkbox" checked={selected.has(inv.id)} onChange={() => setSelected(prev => { const n = new Set(prev); n.has(inv.id) ? n.delete(inv.id) : n.add(inv.id); return n })} className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{inv.name}</span>
                  </label>
                ))}
                {investors.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No investors yet.</div>}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Subject</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Final close and first capital call" className="h-9 w-full px-3 rounded-md border border-input bg-background text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Message</label>
              <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="Write your announcement…" className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
            </div>
            {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-destructive">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { onClose(); reset() }} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={review} disabled={busy || selected.size === 0 || !subject.trim() || !body.trim()}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Review</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
