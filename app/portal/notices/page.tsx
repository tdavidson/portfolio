'use client'

import { useEffect, useState } from 'react'
import { Loader2, FileText, Check, Landmark, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import { DocumentViewer, type ViewerDoc } from '@/components/portal/document-viewer'

interface Notice {
  kind: 'capital_call' | 'distribution'
  lineId: string
  vehicle: string
  date: string
  number: number | null
  description: string | null
  dueDate: string | null
  amount: number
  settled: number
  outstanding: number
  status: 'open' | 'partial' | 'settled'
  settledOn: string | null
  documentId: string | null
  documentViewedAt: string | null
  ack: { at: string; wiredOn: string | null; reference: string | null; note: string | null } | null
  receipts: { documentId: string; title: string; date: string | null }[]
  currency: string
}

function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(v)
  } catch {
    return `${currency} ${v.toFixed(2)}`
  }
}
function fmtDate(s: string | null): string {
  if (!s) return ''
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusLabel(n: Notice, today: string): { label: string; tone: string } {
  if (n.kind === 'capital_call') {
    if (n.status === 'settled') return { label: `Funded${n.settledOn ? ` ${fmtDate(n.settledOn)}` : ''}`, tone: 'bg-success text-success-foreground' }
    if (n.status === 'partial') return { label: 'Partly funded', tone: 'bg-warning text-warning-foreground' }
    if (n.ack) return { label: 'Wire sent', tone: 'bg-muted text-muted-foreground' }
    if (n.dueDate && n.dueDate < today) return { label: 'Overdue', tone: 'bg-destructive text-destructive-foreground' }
    return { label: 'Due', tone: 'bg-muted text-muted-foreground' }
  }
  if (n.status === 'settled') return { label: `Paid${n.settledOn ? ` ${fmtDate(n.settledOn)}` : ''}`, tone: 'bg-success text-success-foreground' }
  if (n.status === 'partial') return { label: 'Partly paid', tone: 'bg-warning text-warning-foreground' }
  return { label: 'Declared', tone: 'bg-muted text-muted-foreground' }
}

export default function PortalNoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewerDoc, setViewerDoc] = useState<ViewerDoc | null>(null)
  const [ackFor, setAckFor] = useState<string | null>(null)
  const [wiredOn, setWiredOn] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const today = new Date().toISOString().slice(0, 10)

  function load() {
    setLoading(true)
    fetch('/api/portal/notices')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then(d => setNotices(d.notices ?? []))
      .catch(() => setError('Could not load your notices.'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])
  // Arriving from the Activity tab (#notice-<line id>): the cards render after the fetch, so the
  // browser's own jump to the anchor has already missed them.
  useEffect(() => {
    if (loading || !window.location.hash.startsWith('#notice-')) return
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [loading])

  function openDoc(documentId: string, title: string) {
    setViewerDoc({ id: documentId, title, file_name: `${title}.pdf`, mime_type: 'application/pdf' })
    setNotices(prev => prev.map(n => (n.documentId === documentId && !n.documentViewedAt ? { ...n, documentViewedAt: new Date().toISOString() } : n)))
  }

  async function submitAck(lineId: string) {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/portal/notices/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId, wiredOn: wiredOn || undefined, reference, note }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save')
      setAckFor(null); setWiredOn(''); setReference(''); setNote('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const open = notices.filter(n => n.status !== 'settled')
  const done = notices.filter(n => n.status === 'settled')

  function Card({ n }: { n: Notice }) {
    const isCall = n.kind === 'capital_call'
    const st = statusLabel(n, today)
    const title = isCall ? `Capital call${n.number ? ` No. ${n.number}` : ''}` : 'Distribution'
    return (
      <div id={`notice-${n.lineId}`} className="rounded-card border bg-card p-4 space-y-3 scroll-mt-4 target:ring-2 target:ring-primary">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="mt-0.5 shrink-0 text-muted-foreground">{isCall ? <ArrowUpFromLine className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{title}</span>
                <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${st.tone}`}>{st.label}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{n.vehicle} · {fmtDate(n.date)}{isCall && n.dueDate ? ` · due ${fmtDate(n.dueDate)}` : ''}</div>
              {n.description && <div className="text-sm text-muted-foreground mt-1">{n.description}</div>}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-normal tabular-nums">{money(n.amount, n.currency)}</div>
            <div className="text-xs text-muted-foreground">{isCall ? 'amount due' : 'payable to you'}</div>
            {n.status === 'partial' && <div className="text-xs text-muted-foreground tabular-nums">{money(n.outstanding, n.currency)} outstanding</div>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {n.documentId ? (
            <button onClick={() => openDoc(n.documentId!, `${title} — ${n.vehicle}`)} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/40">
              <FileText className="h-3.5 w-3.5" /> View notice
              {!n.documentViewedAt && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-warning" title="Not opened yet" />}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">Notice not yet published.</span>
          )}
          {n.receipts.map(r => (
            <button key={r.documentId} onClick={() => openDoc(r.documentId, r.title)} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/40">
              <Check className="h-3.5 w-3.5 text-success" /> Receipt{r.date ? ` ${fmtDate(r.date)}` : ''}
            </button>
          ))}
          {isCall && n.status !== 'settled' && !n.ack && ackFor !== n.lineId && (
            <button onClick={() => { setAckFor(n.lineId); setWiredOn(today); setReference(''); setNote('') }} className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-2.5 py-1.5 text-xs font-medium">
              <Landmark className="h-3.5 w-3.5" /> We&rsquo;ve wired
            </button>
          )}
        </div>

        {isCall && n.ack && (
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            You told the fund you wired{n.ack.wiredOn ? ` on ${fmtDate(n.ack.wiredOn)}` : ''}{n.ack.reference ? ` with reference ${n.ack.reference}` : ''} ({fmtDate(n.ack.at)}).
            {n.status !== 'settled' && ' The fund will confirm once it is received.'}
          </div>
        )}

        {ackFor === n.lineId && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-sm">Tell the fund your wire is on its way. The reference helps them match it to this call.</p>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-muted-foreground">Wired on
                <input type="date" value={wiredOn} onChange={e => setWiredOn(e.target.value)} className="block mt-1 h-9 rounded-md border border-input bg-background px-3 text-sm" />
              </label>
              <label className="text-xs text-muted-foreground flex-1 min-w-[180px]">Wire reference (optional)
                <input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. ACME-CALL4" className="block mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </label>
            </div>
            <label className="text-xs text-muted-foreground block">Note (optional)
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="block mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAckFor(null)} disabled={saving} className="rounded-md border px-3 py-1.5 text-xs">Cancel</button>
              <button onClick={() => submitAck(n.lineId)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Send
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notices</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Capital calls to fund and distributions coming to you, with each notice and receipt.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : notices.length === 0 ? (
        <div className="rounded-card border bg-card p-8 text-center text-sm text-muted-foreground">No capital calls or distributions yet.</div>
      ) : (
        <>
          {error && <div className="rounded-card border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
          {open.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">Open</h2>
              {open.map(n => <Card key={n.lineId} n={n} />)}
            </section>
          )}
          {done.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">Completed</h2>
              {done.map(n => <Card key={n.lineId} n={n} />)}
            </section>
          )}
        </>
      )}

      {viewerDoc && <DocumentViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />}
    </div>
  )
}
