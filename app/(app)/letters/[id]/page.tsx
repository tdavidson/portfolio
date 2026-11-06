'use client'

// One view of the letter: its sections in order, each edited in place or rewritten with a prompt,
// and beside the chosen section what it was written from (the company's figures, events, KPIs and
// updates, or the fund's figures) and what the review found in it. Replaces the three tabs.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Download, ExternalLink, FileText, Loader2, Lock,
  ImageIcon, Paperclip, Pencil, RefreshCw, Save, Sparkles, Trash2, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useFeatureVisibility, useIsAdmin } from '@/components/feature-visibility-context'
import { LpShareControl } from '@/components/lp-share-control'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { fromLetter, type LetterContent, type LetterSection } from '@/lib/lp-letters/content'
import type { LetterFlag } from '@/lib/lp-letters/review'
import type { LetterChart } from '@/lib/lp-letters/document'
import { PullDialog } from './pull-dialog'
import { WordDialog } from './word-dialog'

interface Letter {
  id: string
  fund_id: string
  template_id: string | null
  period_year: number
  period_quarter: number
  is_year_end: boolean
  period_label: string
  portfolio_group: string
  portfolio_table_html: string | null
  portfolio_summary?: unknown
  company_narratives?: unknown
  content?: unknown
  full_draft: string | null
  /** The partners' "Missing information" notes: kept with the letter, never shown to investors. */
  internal_notes?: string | null
  /** The partners' notes and added documents: sources for writing, never shown to investors. */
  partner_notes?: string | null
  source_documents?: { id: string; name: string; text: string; added_at: string }[] | null
  /** Images the partners placed after a section, with captions. */
  charts?: LetterChart[] | null
  generation_prompt: string | null
  generation_error: string | null
  company_prompts: Record<string, { prompt: string; mode: 'add' | 'replace' }> | null
  status: string
  created_at: string
  updated_at: string
}

interface Review { flags: LetterFlag[]; missing_information: string[]; as_of: string }

const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export default function LetterEditorPage() {
  const fv = useFeatureVisibility()
  const isAdmin = useIsAdmin()
  const params = useParams()
  const letterId = params.id as string

  const [letter, setLetter] = useState<Letter | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [rewriteOpen, setRewriteOpen] = useState<string | null>(null)
  const [rewritePrompt, setRewritePrompt] = useState('')
  const [rewriting, setRewriting] = useState<string | null>(null)
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [wholeOpen, setWholeOpen] = useState(false)
  const [wholeText, setWholeText] = useState('')
  const [tableOpen, setTableOpen] = useState(false)
  const [tableHtml, setTableHtml] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [googleDriveConnected, setGoogleDriveConnected] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [wordOpen, setWordOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [partnerNotes, setPartnerNotes] = useState('')
  const [uploading, setUploading] = useState(false)
  const [chartsOpen, setChartsOpen] = useState(false)
  const [chartCaption, setChartCaption] = useState('')
  const [chartSection, setChartSection] = useState('')
  const [chartUploading, setChartUploading] = useState(false)

  const accept = useCallback((data: Letter) => {
    setLetter(data)
    setWholeText(data.full_draft ?? '')
    setGuidance(data.generation_prompt ?? '')
    setPartnerNotes(data.partner_notes ?? '')
  }, [])

  const loadLetter = useCallback(async () => {
    const res = await fetch(`/api/lp-letters/${letterId}`)
    if (res.ok) accept(await res.json())
    setLoading(false)
  }, [letterId, accept])

  const loadReview = useCallback(async () => {
    setReviewing(true)
    try {
      const res = await fetch(`/api/lp-letters/${letterId}/review`)
      if (res.ok) setReview(await res.json())
    } finally {
      setReviewing(false)
    }
  }, [letterId])

  useEffect(() => { loadLetter() }, [loadLetter])

  // The review runs once the letter is in, and again after each change to its text.
  useEffect(() => {
    if (letter && letter.status !== 'generating') loadReview()
  }, [letter?.updated_at, letter?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // A letter being generated elsewhere (the MCP tools, another tab): follow it until it is done.
  useEffect(() => {
    if (!letter || letter.status !== 'generating') return
    const interval = setInterval(() => { loadLetter() }, 5000)
    return () => clearInterval(interval)
  }, [letter?.status, loadLetter])

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.googleDriveConnected) setGoogleDriveConnected(true) })
      .catch(() => {})
  }, [])

  const content: LetterContent = useMemo(() => (letter ? fromLetter(letter) : { version: 1, sections: [] }), [letter])
  const sections = content.sections
  const current = sections.find(s => s.id === selected) ?? sections[0] ?? null

  const flagsBySection = useMemo(() => {
    const m = new Map<string | null, LetterFlag[]>()
    for (const f of review?.flags ?? []) m.set(f.section_id, [...(m.get(f.section_id) ?? []), f])
    return m
  }, [review])
  const letterFlags = flagsBySection.get(null) ?? []

  const fail = async (res: Response, fallback: string) => {
    const err = await res.json().catch(() => ({}))
    setError(err?.error ?? fallback)
  }

  const saveSection = async (id: string) => {
    setSaving(true); setError(null)
    const res = await fetch(`/api/lp-letters/${letterId}/sections/${encodeURIComponent(id)}`, patch({ body: editText }))
    if (res.ok) { accept(await res.json()); setEditing(null) } else await fail(res, 'Saving the section failed.')
    setSaving(false)
  }

  const rewrite = async (id: string) => {
    setRewriting(id); setError(null)
    const res = await fetch(`/api/lp-letters/${letterId}/sections/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: rewritePrompt }),
    })
    if (res.ok) { accept(await res.json()); setRewriteOpen(null) } else await fail(res, 'Rewriting the section failed.')
    setRewriting(null)
  }

  const generate = async () => {
    if (sections.length && !confirm('Write the whole letter again from the current figures? Your edits to its text will be replaced.')) return
    setGenerating(true); setError(null)
    const res = await fetch(`/api/lp-letters/${letterId}/generate`, { method: 'POST' })
    if (!res.ok) await fail(res, 'Generating the letter failed.')
    await loadLetter()
    setGenerating(false)
  }

  const saveGuidance = async () => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, patch({ generation_prompt: guidance.trim() || null }))
    if (res.ok) accept(await res.json()); else await fail(res, 'Saving the guidance failed.')
    setSaving(false)
  }

  const savePartnerNotes = async () => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, patch({ partner_notes: partnerNotes.trim() || null }))
    if (res.ok) accept(await res.json()); else await fail(res, 'Saving the notes failed.')
    setSaving(false)
  }

  const addSources = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true); setError(null)
    const form = new FormData()
    for (const f of Array.from(files)) form.append('files', f)
    const res = await fetch(`/api/lp-letters/${letterId}/sources`, { method: 'POST', body: form })
    if (res.ok) {
      const data = await res.json()
      accept(data)
      if (data.unread?.length) setError(`Could not read ${data.unread.join(', ')}.`)
    } else await fail(res, 'Adding the documents failed.')
    setUploading(false)
  }

  const removeSource = async (id: string) => {
    const res = await fetch(`/api/lp-letters/${letterId}/sources?source=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) accept(await res.json()); else await fail(res, 'Removing the document failed.')
  }

  const charts = (letter?.charts ?? []) as LetterChart[]
  const withCharts = (next: LetterChart[]) => setLetter(l => (l ? { ...l, charts: next } : l))

  const addChart = async (file: File | undefined) => {
    if (!file) return
    setChartUploading(true); setError(null)
    const form = new FormData()
    form.append('file', file)
    if (chartCaption.trim()) form.append('caption', chartCaption.trim())
    if (chartSection) form.append('section_id', chartSection)
    const res = await fetch(`/api/lp-letters/${letterId}/charts`, { method: 'POST', body: form })
    if (res.ok) { withCharts((await res.json()).charts); setChartCaption('') } else await fail(res, 'Adding the chart failed.')
    setChartUploading(false)
  }

  const changeChart = async (id: string, change: { caption?: string; section_id?: string | null }) => {
    const res = await fetch(`/api/lp-letters/${letterId}/charts`, patch({ chart_id: id, ...change }))
    if (res.ok) withCharts((await res.json()).charts); else await fail(res, 'Changing the chart failed.')
  }

  const removeChart = async (id: string) => {
    const res = await fetch(`/api/lp-letters/${letterId}/charts?chart=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) withCharts((await res.json()).charts); else await fail(res, 'Removing the chart failed.')
  }

  const saveWhole = async () => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, patch({ full_draft: wholeText }))
    if (res.ok) { accept(await res.json()); setWholeOpen(false) } else await fail(res, 'Saving the letter failed.')
    setSaving(false)
  }

  // Final = a person has reviewed it; only a final letter can be shared. Regenerating puts it back to draft.
  const setStatus = async (status: 'draft' | 'final') => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, patch({ status }))
    if (res.ok) accept(await res.json()); else await fail(res, 'Changing the status failed.')
    setSaving(false)
  }

  const loadTable = async () => {
    if (!letter || tableHtml !== null) return
    const q = new URLSearchParams({
      year: String(letter.period_year), quarter: String(letter.period_quarter), group: letter.portfolio_group, yearEnd: String(letter.is_year_end),
    })
    try {
      const res = await fetch(`/api/lp-letters/preview?${q}`)
      setTableHtml(res.ok ? buildTableHtml(await res.json()) : '')
    } catch {
      setTableHtml('')
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(letter?.full_draft ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const exportLetter = async (format: 'markdown' | 'docx' | 'pdf' | 'json' | 'google-docs') => {
    setExporting(format)
    // Open the tab synchronously within the click so the browser doesn't block it as a popup.
    const docWin = format === 'google-docs' ? window.open('about:blank', '_blank') : null
    try {
      const res = await fetch(`/api/lp-letters/${letterId}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }),
      })
      if (!res.ok) { docWin?.close(); await fail(res, 'Export failed.'); return }
      if (format === 'google-docs') {
        const { url } = await res.json()
        if (docWin) docWin.location.href = url
        else window.open(url, '_blank')
      } else {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${letter?.period_label ?? 'letter'}.${format === 'markdown' ? 'md' : format}`
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch {
      docWin?.close()
      setError('Export failed.')
    } finally {
      setExporting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!letter) {
    return (
      <div className="p-8">
        <p className="text-sm text-destructive">Letter not found.</p>
        <Link href="/letters" className="text-sm underline mt-2">Back to letters</Link>
      </div>
    )
  }

  const busy = generating || letter.status === 'generating'
  const hasContent = sections.length > 0
  const isDraft = letter.status === 'draft'
  const flagCount = review?.flags.length ?? 0
  const table = sanitizeLetterHtml(tableHtml || letter.portfolio_table_html)

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <div className="space-y-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {fv.lp_letters === 'admin' && <Lock className="h-4 w-4 text-warning" />}{letter.period_label}
          </h1>
          <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>{letter.portfolio_group}</span>
            <StatusBadge status={letter.status} />
            {review && hasContent && (
              <span className={flagCount ? 'text-warning' : 'text-success'}>
                {flagCount ? `${flagCount} review ${flagCount === 1 ? 'flag' : 'flags'}` : 'No review flags'}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <Button size="sm" variant="outline" onClick={generate} disabled={busy}
            title="Write the whole letter from the current figures, in the fund's voice">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
            {hasContent ? 'Write again' : 'Generate letter'}
          </Button>
          {hasContent && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="text-muted-foreground" disabled={!!exporting}>
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
                  Export
                  <ChevronDown className="h-3.5 w-3.5 ml-1" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1">
                <MenuItem onClick={() => exportLetter('docx')} icon={<Download className="h-3.5 w-3.5" />}>Word (.docx)</MenuItem>
                <MenuItem onClick={() => exportLetter('pdf')} icon={<FileText className="h-3.5 w-3.5" />}>PDF</MenuItem>
                <MenuItem onClick={() => exportLetter('markdown')} icon={<FileText className="h-3.5 w-3.5" />}>Markdown (.md)</MenuItem>
                <MenuItem onClick={() => exportLetter('json')} icon={<FileText className="h-3.5 w-3.5" />}>JSON</MenuItem>
                {googleDriveConnected && (
                  <MenuItem onClick={() => exportLetter('google-docs')} icon={<ExternalLink className="h-3.5 w-3.5" />}>Google Docs</MenuItem>
                )}
                <MenuItem onClick={copyToClipboard} icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
                  {copied ? 'Copied' : 'Copy text'}
                </MenuItem>
              </PopoverContent>
            </Popover>
          )}
          {hasContent && isDraft && (
            <>
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setWordOpen(true)}
                title="Replace this draft with the Word file the partners edited">
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                Bring back from Word
              </Button>
              <WordDialog letterId={letterId} open={wordOpen} onOpenChange={setWordOpen} onReplaced={updated => accept(updated as Letter)} />
            </>
          )}
          {googleDriveConnected && isDraft && (
            <>
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setPullOpen(true)}
                title="Replace this draft with the Google Doc the partners edited">
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Pull from Google Doc
              </Button>
              <PullDialog letterId={letterId} open={pullOpen} onOpenChange={setPullOpen} onReplaced={updated => accept(updated as Letter)} />
            </>
          )}
          {hasContent && !busy && (
            letter.status === 'final' ? (
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setStatus('draft')} disabled={saving}
                title="Final: reviewed and ready to share. Click to put it back to draft.">
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Final
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setStatus('final')} disabled={saving}
                title="Mark the letter final once it has been reviewed. Only a final letter can be shared with LPs.">
                Mark final
              </Button>
            )
          )}
          {/* Shown on drafts too, so a share can be removed; adding one to a draft is refused with the reason. */}
          {isAdmin && (fv.lp_portal === 'everyone' || fv.lp_portal === 'admin') && (
            <LpShareControl shareEndpoint={`/api/lp-letters/${letterId}/share`} />
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-card border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="hover:text-foreground" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Guidance for this letter */}
      <div className="rounded-card border mb-4">
        <button onClick={() => setGuidanceOpen(!guidanceOpen)} className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50">
          {guidanceOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-medium">Guidance for this letter</span>
          {letter.generation_prompt && <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">set</span>}
        </button>
        {guidanceOpen && (
          <div className="px-4 pb-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              What to stress this quarter. The fund&apos;s structure, voice and house rules come from its{' '}
              <Link href="/letters" className="underline">Voice</Link>; this adds to them for this letter only.
            </p>
            <Textarea value={guidance} onChange={e => setGuidance(e.target.value)} rows={4} className="text-sm"
              placeholder="e.g. Lead with the two follow-on rounds; keep the exits section short." />
            <Button size="sm" variant="outline" onClick={saveGuidance} disabled={saving || guidance === (letter.generation_prompt ?? '')}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Save guidance
            </Button>
          </div>
        )}
      </div>

      {/* What the partners add for this letter: notes and documents, read as sources */}
      <div className="rounded-card border mb-4">
        <button onClick={() => setNotesOpen(!notesOpen)} className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50">
          {notesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-medium">Partner notes and sources</span>
          {(letter.partner_notes || letter.source_documents?.length) ? (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded tabular-nums">
              {[letter.partner_notes ? 'notes' : null, letter.source_documents?.length ? `${letter.source_documents.length} ${letter.source_documents.length === 1 ? 'document' : 'documents'}` : null].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </button>
        {notesOpen && (
          <div className="px-4 pb-3 space-y-3">
            <p className="text-[11px] text-muted-foreground">
              Facts and context only the partners have, and documents to write from (a market report, a board deck). The letter
              may draw on them like the books; they are never shown to investors.
            </p>
            <Textarea value={partnerNotes} onChange={e => setPartnerNotes(e.target.value)} rows={4} className="text-sm"
              placeholder="e.g. Acme's new CEO starts in January; we led Birch's bridge on the same terms as the seed." />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={savePartnerNotes} disabled={saving || partnerNotes === (letter.partner_notes ?? '')}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Save notes
              </Button>
              <label className={`inline-flex items-center rounded-lg border px-3 h-8 text-sm cursor-pointer hover:bg-muted ${uploading ? 'opacity-60 pointer-events-none' : ''}`}>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Paperclip className="h-3.5 w-3.5 mr-1.5" />}
                Add documents
                <input type="file" multiple className="hidden" accept=".pdf,.docx,.txt,.md,.csv,.xlsx"
                  onChange={e => { addSources(e.target.files); e.target.value = '' }} />
              </label>
            </div>
            {letter.source_documents?.length ? (
              <ul className="space-y-1">
                {letter.source_documents.map(d => (
                  <li key={d.id} className="flex items-center gap-2 text-xs">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{d.name}</span>
                    <span className="text-muted-foreground tabular-nums">{d.text.length.toLocaleString()} characters</span>
                    <button onClick={() => removeSource(d.id)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${d.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      {/* Charts: images placed after a section, with captions, in every export */}
      {hasContent && (
        <div className="rounded-card border mb-4">
          <button onClick={() => setChartsOpen(!chartsOpen)} className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50">
            {chartsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="font-medium">Charts</span>
            {charts.length > 0 && <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded tabular-nums">{charts.length}</span>}
          </button>
          {chartsOpen && (
            <div className="px-4 pb-3 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                A PNG or JPEG image, placed after the section you choose, with its caption. It appears in the Word file and the
                PDF. An image is never changed once added: to replace one, remove it and add the new one.
              </p>
              {isDraft ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input value={chartCaption} onChange={e => setChartCaption(e.target.value)} placeholder="Caption"
                    className="h-8 rounded-lg border bg-background px-2.5 text-sm flex-1 min-w-[12rem]" />
                  <select value={chartSection} onChange={e => setChartSection(e.target.value)}
                    className="h-8 rounded-lg border bg-background px-2 text-sm max-w-[16rem]" aria-label="Place after">
                    <option value="">At the end</option>
                    {sections.map(s => <option key={s.id} value={s.id}>After {s.heading ?? 'the opening'}</option>)}
                  </select>
                  <label className={`inline-flex items-center rounded-lg border px-3 h-8 text-sm cursor-pointer hover:bg-muted ${chartUploading ? 'opacity-60 pointer-events-none' : ''}`}>
                    {chartUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <ImageIcon className="h-3.5 w-3.5 mr-1.5" />}
                    Add chart
                    <input type="file" className="hidden" accept="image/png,image/jpeg"
                      onChange={e => { addChart(e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">This letter is final. Put it back to draft to change its charts.</p>
              )}
              {charts.length > 0 && (
                <ul className="space-y-2">
                  {charts.map(c => (
                    <li key={c.id} className="flex items-center gap-3 text-xs">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/lp-letters/${letterId}/charts/${encodeURIComponent(c.id)}`} alt={c.caption ?? 'Chart'}
                        className="h-12 w-20 object-contain rounded-sm border bg-background shrink-0" />
                      <div className="flex-1 min-w-0 space-y-1">
                        {isDraft ? (
                          <input defaultValue={c.caption ?? ''} placeholder="Caption"
                            onBlur={e => { if (e.target.value !== (c.caption ?? '')) changeChart(c.id, { caption: e.target.value }) }}
                            className="h-7 w-full rounded-md border bg-background px-2 text-xs" />
                        ) : <p className="truncate">{c.caption ?? 'No caption'}</p>}
                        <p className="text-muted-foreground truncate">
                          {c.section_id ? `After ${sections.find(s => s.id === c.section_id)?.heading ?? 'a section no longer in the letter (printed at the end)'}` : 'At the end'}
                        </p>
                      </div>
                      {isDraft && (
                        <button onClick={() => removeChart(c.id)} className="text-muted-foreground hover:text-destructive" aria-label="Remove chart">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {busy && (
        <div className="rounded-card border bg-muted/30 p-8 text-center space-y-3 mb-4">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Writing the letter from the brief. This can take a minute or two.</p>
          <p className="text-xs text-muted-foreground/60">This page updates when it is ready.</p>
        </div>
      )}

      {!hasContent && !busy && (
        <div className="rounded-card border border-dashed p-12 text-center space-y-3">
          <FileText className="h-8 w-8 mx-auto text-muted-foreground" />
          {letter.generation_error ? (
            <>
              <p className="text-sm text-destructive">Generation failed</p>
              <p className="text-xs text-muted-foreground">{letter.generation_error}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing written yet. Generate the letter, or draft it with an assistant connected to the app.</p>
          )}
          <Button size="sm" variant="outline" onClick={generate}>
            <Sparkles className="h-4 w-4 mr-1.5" />
            {letter.generation_error ? 'Try again' : 'Generate letter'}
          </Button>
        </div>
      )}

      {hasContent && !busy && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* The letter */}
          <div className="space-y-4 min-w-0">
            {sections.map(s => {
              const flags = flagsBySection.get(s.id) ?? []
              const isCurrent = current?.id === s.id
              return (
                <div key={s.id} onClick={() => setSelected(s.id)}
                  className={`rounded-card border p-4 cursor-pointer transition-colors ${isCurrent ? 'border-primary/60 bg-muted/20' : 'hover:bg-muted/10'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-heading font-normal flex-1 min-w-0 truncate">{s.heading ?? 'Opening'}</h3>
                    {flags.length > 0 && (
                      <span className="text-[11px] text-warning flex items-center gap-1 tabular-nums" title="Review flags in this section">
                        <AlertTriangle className="h-3 w-3" />{flags.length}
                      </span>
                    )}
                    {isDraft && editing !== s.id && (
                      <>
                        <Button size="sm" variant="outline" className="h-7 text-xs px-2.5"
                          onClick={e => { e.stopPropagation(); setEditing(s.id); setEditText(s.body); setRewriteOpen(null); setSelected(s.id) }}>
                          <Pencil className="h-3 w-3 mr-1.5" />Edit
                        </Button>
                        <Button size="sm" variant={rewriteOpen === s.id ? 'default' : 'outline'} className="h-7 text-xs px-2.5"
                          onClick={e => {
                            e.stopPropagation()
                            setSelected(s.id); setEditing(null)
                            if (rewriteOpen === s.id) { setRewriteOpen(null); return }
                            setRewritePrompt(letter.company_prompts?.[s.id]?.prompt ?? '')
                            setRewriteOpen(s.id)
                          }}>
                          <RefreshCw className="h-3 w-3 mr-1.5" />Rewrite
                          {letter.company_prompts?.[s.id] && rewriteOpen !== s.id && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary inline-block" />}
                        </Button>
                      </>
                    )}
                  </div>

                  {rewriteOpen === s.id && (
                    <div className="mb-3 space-y-2 rounded-lg border bg-muted/30 p-3" onClick={e => e.stopPropagation()}>
                      <p className="text-[11px] text-muted-foreground">
                        Rewrites this section from its sources, with the rest of the letter as context. The prompt is kept for next time.
                      </p>
                      <Textarea value={rewritePrompt} onChange={e => setRewritePrompt(e.target.value)} rows={3} className="text-xs"
                        placeholder="e.g. Shorter, and lead with the new contract." />
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => rewrite(s.id)} disabled={rewriting === s.id}>
                          {rewriting === s.id ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Sparkles className="h-3 w-3 mr-1.5" />}
                          Rewrite section
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRewriteOpen(null)}>Cancel</Button>
                      </div>
                    </div>
                  )}

                  {editing === s.id ? (
                    <div className="space-y-2" onClick={e => e.stopPropagation()}>
                      <Textarea value={editText} onChange={e => setEditText(e.target.value)}
                        rows={Math.min(24, Math.max(6, editText.split('\n').length + 2))} className="text-sm leading-relaxed" />
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => saveSection(s.id)} disabled={saving || editText === s.body}>
                          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : rewriting === s.id ? (
                    <div className="flex items-center gap-2 py-4 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /><span className="text-xs">Rewriting this section...</span>
                    </div>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap leading-relaxed">{s.body || <span className="text-muted-foreground">Empty</span>}</div>
                  )}
                  {charts.filter(c => c.section_id === s.id).map(c => (
                    <figure key={c.id} className="mt-3 text-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/lp-letters/${letterId}/charts/${encodeURIComponent(c.id)}`} alt={c.caption ?? 'Chart'}
                        className="mx-auto max-h-72 object-contain" />
                      {c.caption && <figcaption className="text-xs text-muted-foreground italic mt-1">{c.caption}</figcaption>}
                    </figure>
                  ))}
                </div>
              )
            })}

            {/* The portfolio table, as the exports carry it */}
            <div className="rounded-card border">
              <button onClick={() => { setTableOpen(!tableOpen); loadTable() }} className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50">
                {tableOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="font-medium">Portfolio table</span>
              </button>
              {tableOpen && (
                <div className="px-4 pb-4">
                  {tableHtml === null ? (
                    <div className="flex items-center gap-2 py-4 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /><span className="text-xs">Loading...</span></div>
                  ) : table ? (
                    // Sanitized HTML from buildTableHtml; tabular-nums so the figures line up.
                    <div className="overflow-x-auto tabular-nums [&_table]:w-full [&_table]:text-xs [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_td]:border [&_thead]:bg-muted/50"
                      dangerouslySetInnerHTML={{ __html: table }} />
                  ) : <p className="text-xs text-muted-foreground">No portfolio data for this period.</p>}
                </div>
              )}
            </div>

            {/* The whole letter as text, for a change across sections */}
            {isDraft && (
              <div className="rounded-card border">
                <button onClick={() => setWholeOpen(!wholeOpen)} className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50">
                  {wholeOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <span className="font-medium">Edit the whole letter as text</span>
                </button>
                {wholeOpen && (
                  <div className="px-4 pb-4 space-y-2">
                    <p className="text-[11px] text-muted-foreground">Keep each heading on its own line: the letter is split into its sections again at the headings.</p>
                    <Textarea value={wholeText} onChange={e => setWholeText(e.target.value)} rows={30} className="text-sm leading-relaxed" />
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={saveWhole} disabled={saving || wholeText === (letter.full_draft ?? '')}>
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}Save letter
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setWholeText(letter.full_draft ?? '')} disabled={wholeText === (letter.full_draft ?? '')}>Revert</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* The rail: what the chosen section was written from, and what the review found */}
          <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            {current && <SourcesCard section={current} flags={flagsBySection.get(current.id) ?? []} />}

            <div className="rounded-card border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium flex-1">Review of the whole letter</p>
                <button onClick={loadReview} className="text-muted-foreground hover:text-foreground" title="Run the review again" disabled={reviewing}>
                  {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </button>
              </div>
              {!review ? (
                <p className="text-xs text-muted-foreground">Checking the letter against the current figures...</p>
              ) : (
                <>
                  {sections.filter(s => flagsBySection.has(s.id)).map(s => (
                    <button key={s.id} onClick={() => setSelected(s.id)} className="flex w-full items-center gap-2 text-left text-xs hover:underline">
                      <span className="flex-1 truncate">{s.heading ?? 'Opening'}</span>
                      <span className="text-warning tabular-nums">{flagsBySection.get(s.id)!.length}</span>
                    </button>
                  ))}
                  {letterFlags.map((f, i) => <FlagLine key={i} flag={f} />)}
                  {flagCount === 0 && <p className="text-xs text-success">Every figure is in the sources, and every event is stated.</p>}
                  <p className="text-[10px] text-muted-foreground/70">Checked against the figures as of {review.as_of}.</p>
                </>
              )}
            </div>

            <div className="rounded-card border bg-muted/30 p-4 space-y-1.5">
              <p className="text-xs font-medium">Internal notes · never shown to investors</p>
              {letter.internal_notes ? (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{letter.internal_notes}</p>
              ) : review?.missing_information.length ? (
                <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                  {review.missing_information.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">None.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'final' ? 'bg-success-subtle text-success' : status === 'generating' ? 'bg-muted text-muted-foreground' : 'bg-warning-subtle text-warning'
  const label = status === 'final' ? 'Final' : status === 'generating' ? 'Generating' : 'Draft'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>
}

function MenuItem({ onClick, icon, children }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted">
      <span className="text-muted-foreground">{icon}</span>{children}
    </button>
  )
}

function FlagLine({ flag }: { flag: LetterFlag }) {
  return (
    <p className="text-xs flex gap-1.5">
      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-warning" />
      <span>{flag.message}</span>
    </p>
  )
}

/** What a section was written from, as stored when it was written. */
function SourcesCard({ section, flags }: { section: LetterSection; flags: LetterFlag[] }) {
  const src = section.sources
  const company = src?.company
  const fund = src?.fund
  return (
    <div className="rounded-card border p-4 space-y-3">
      <div>
        <p className="text-xs font-medium">{section.heading ?? 'Opening'}</p>
        <p className="text-[10px] text-muted-foreground">
          {src?.as_of ? `Written from the figures as of ${src.as_of}` : section.kind === 'text' ? 'Written from the letter as a whole' : 'No sources stored for this section'}
        </p>
      </div>

      {flags.length > 0 && <div className="space-y-1.5">{flags.map((f, i) => <FlagLine key={i} flag={f} />)}</div>}

      {company && (
        <>
          <p className="text-[11px] text-muted-foreground">{[company.letter_status ?? company.status, company.stage].filter(Boolean).join(' · ')}</p>
          <Figures figures={company.figures} />
          <List title="Events to state" items={company.events} />
          <List title="After quarter end" items={company.after_quarter_end ?? []} />
          <List title="KPIs this quarter" items={company.kpis_this_quarter} />
          {company.updates_this_quarter.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium">Updates this quarter</p>
              {company.updates_this_quarter.map((u, i) => (
                <details key={i} className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {u.subject || 'Update'} · {u.received}
                    {u.confidential && <span className="ml-1.5 rounded bg-warning-subtle px-1 py-0.5 text-[10px] text-warning">Confidential</span>}
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground leading-relaxed max-h-48 overflow-y-auto">{u.text}</p>
                </details>
              ))}
            </div>
          )}
          <List title="Team notes" items={company.team_notes} />
          {company.stored_business_update && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium flex items-center gap-1.5">
                Stored business update
                <span className="font-normal text-muted-foreground">{company.stored_business_update_at ? `· ${company.stored_business_update_at}` : '· undated'}</span>
                {company.stored_business_update_stale && <span className="rounded bg-warning-subtle px-1 py-0.5 text-[10px] font-normal text-warning">Stale</span>}
              </p>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{company.stored_business_update}</p>
            </div>
          )}
        </>
      )}

      {fund && (
        <>
          <Figures figures={fund.figures} />
          <List title="Basis" items={fund.basis_notes} />
        </>
      )}
    </div>
  )
}

function Figures({ figures }: { figures: { label: string; value: string; basis: string }[] }) {
  if (!figures.length) return null
  return (
    <table className="w-full text-xs">
      <tbody>
        {figures.map((f, i) => (
          <tr key={i} className="border-b last:border-0">
            <td className="py-1 pr-2 text-muted-foreground">{f.label}</td>
            <td className="py-1 text-right tabular-nums">{f.value}</td>
            <td className="py-1 pl-2 text-[10px] text-muted-foreground">{f.basis}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium">{title}</p>
      <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The portfolio table from preview data (client-side, no AI)
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toLocaleString()}`
}

function buildTableHtml(preview: {
  companies: { investment: { companyName: string; status: string; stage: string | null; totalInvested: number; fmv: number; moic: number | null } }[]
  totals: { totalInvested: number; totalFmv: number; portfolioMoic: number | null }
}): string {
  const rows = preview.companies.map(c => {
    const inv = c.investment
    return `<tr>
      <td>${escHtml(inv.companyName)}</td>
      <td style="text-transform:capitalize">${escHtml(inv.status)}</td>
      <td>${escHtml(inv.stage ?? '—')}</td>
      <td style="text-align:right">${fmtCurrency(inv.totalInvested)}</td>
      <td style="text-align:right">${fmtCurrency(inv.fmv)}</td>
      <td style="text-align:right">${inv.moic ? `${inv.moic.toFixed(2)}x` : '—'}</td>
    </tr>`
  })

  return `<table>
  <thead>
    <tr>
      <th>Company</th><th>Status</th><th>Stage</th>
      <th style="text-align:right">Invested</th>
      <th style="text-align:right">FMV</th>
      <th style="text-align:right">Gross MOIC</th>
    </tr>
  </thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="3"><strong>Total</strong></td>
      <td style="text-align:right"><strong>${fmtCurrency(preview.totals.totalInvested)}</strong></td>
      <td style="text-align:right"><strong>${fmtCurrency(preview.totals.totalFmv)}</strong></td>
      <td style="text-align:right"><strong>${preview.totals.portfolioMoic ? `${preview.totals.portfolioMoic.toFixed(2)}x` : '—'}</strong></td>
    </tr>
  </tfoot>
</table>`
}
