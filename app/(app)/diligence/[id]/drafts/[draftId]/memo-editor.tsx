'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, FileDown, FileText, ExternalLink, Lock, AlertTriangle, AlertCircle, ChevronRight, Save, GripVertical, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/confirm-dialog'
import { formatSource, type SourceLabel } from '@/lib/memo-agent/render/source-labels'
import { memoRevisionTitle, ROUND_CHANGES_SECTION_ID, withRoundChangesFirst } from '@/lib/diligence/rounds'

interface Paragraph {
  id: string
  section_id: string
  order: number
  prose: string
  sources: Array<{ source_type: string; source_id: string; span?: string | null }>
  origin: 'agent_drafted' | 'partner_drafted' | 'partner_only_placeholder' | 'partner_edited'
  confidence: 'low' | 'medium' | 'high' | 'n/a'
  contains_projection: boolean
  contains_unverified_claim: boolean
  contains_contradiction: boolean
  hidden?: boolean
  /** In a later diligence round: kept from the prior round's memo, revised, or new. */
  round_status?: 'kept' | 'revised' | 'new'
}

interface DimensionScore {
  dimension_id: string
  mode: 'machine' | 'hybrid' | 'partner_only'
  score: number | null
  confidence: 'low' | 'medium' | 'high' | null
  rationale: string
}

interface MemoOutput {
  header?: Record<string, any>
  paragraphs: Paragraph[]
  partner_attention?: any[]
  scores?: DimensionScore[]
  revision?: { round_number: number; prior_round_number: number; title: string }
}

interface Draft {
  id: string
  draft_version: string
  agent_version: string
  is_draft: boolean
  finalized_at: string | null
  finalized_by: string | null
  created_at: string
  memo_draft_output: MemoOutput | null
  /** Who wrote it: the memo agent, Claude in a chat (assistant), a Word re-import, or a partner. */
  written_by?: 'memo_agent' | 'assistant' | 'import' | 'partner' | null
  /** The investment-memo review's flags (lib/memo-agent/review.ts). */
  review_flags?: Array<{ kind: string; severity: 'must_fix' | 'check'; message: string; paragraph_id?: string; section?: string }> | null
}

const WRITTEN_BY: Record<string, string> = {
  memo_agent: 'Written by the memo agent',
  assistant: 'Written by Claude in a chat',
  import: 'Re-imported from Word',
  partner: 'Written by a partner',
}

type ExportFormat = 'docx' | 'gdoc' | 'pdf' | 'markdown'

interface AttentionItem {
  id: string
  draft_id: string | null
  kind: string
  urgency: 'must_address' | 'should_address' | 'fyi'
  body: string
  links: Array<{ source_type: string; source_id: string }> | null
  status: 'open' | 'ignore' | 'done'
  created_at: string
}

const SECTION_ORDER: Array<{ id: string; title: string }> = [
  { id: 'executive_summary', title: 'Executive Summary' },
  { id: 'recommendation', title: 'Recommendation' },
  { id: 'company_overview', title: 'Company Overview' },
  { id: 'market', title: 'Market' },
  { id: 'team', title: 'Team' },
  { id: 'product_technology', title: 'Product & Technology' },
  { id: 'traction', title: 'Traction & Evidence' },
  { id: 'business_model', title: 'Business Model & Financials' },
  { id: 'competition_moat', title: 'Competition & Moat' },
  { id: 'deal_terms', title: 'Deal & Terms' },
  { id: 'risks_and_open_questions', title: 'Risks & Open Questions' },
]

// Title for a section_id not covered by the deal's section config (e.g. an
// older draft's section). Mirrors the renderers' humanizer.
function humanizeSectionId(id: string): string {
  return id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function MemoEditor({ dealId, dealName, draft: initial, initialAttention, sourceLabels, isAdmin, embedded, round }: {
  dealId: string
  dealName: string
  draft: Draft
  initialAttention: AttentionItem[]
  /**
   * `"<source_type>:<source_id>"` → the data-room document (or research source) behind
   * that citation. Resolved on the server, where the ingestion output and the document
   * names both live. Absent keys fall back to the raw id.
   */
  sourceLabels?: Record<string, SourceLabel>
  isAdmin: boolean
  /** When true, drop the page wrapper + back link so this can render inside the
   *  deal-detail Memo tab without extra chrome. */
  embedded?: boolean
  /** The diligence round this draft belongs to. A closed round's memo is read only (it can still be finalized). */
  round?: { round_number: number; label: string; status: 'open' | 'closed' } | null
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [draft, setDraft] = useState(initial)
  const [attention, setAttention] = useState(initialAttention)
  // Serialized as a plain object across the server boundary; a Map is what the
  // renderers want.
  const labels = useMemo(
    () => new Map<string, SourceLabel>(Object.entries(sourceLabels ?? {})),
    [sourceLabels]
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [proseDraft, setProseDraft] = useState<string>('')
  const [showAttention, setShowAttention] = useState(false)
  const [savingPara, setSavingPara] = useState(false)
  const [exporting, setExporting] = useState<null | ExportFormat>(null)
  const [importing, setImporting] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<null | { url: string | null; format: string; note?: string | null }>(null)
  // The deal's user-managed section config (order + titles + custom sections).
  const [sectionCfg, setSectionCfg] = useState<Array<{ id: string; title: string; included?: boolean }> | null>(null)

  const memo = draft.memo_draft_output ?? { paragraphs: [], scores: [] }
  const roundClosed = round?.status === 'closed'
  const isReadOnly = !draft.is_draft || roundClosed

  useEffect(() => {
    let cancelled = false
    fetch(`/api/diligence/${dealId}/memo-config`)
      .then(r => (r.ok ? r.json() : null))
      .then(body => {
        if (cancelled || !body) return
        const secs = body.memo_template_config?.sections
        if (Array.isArray(secs) && secs.length > 0) setSectionCfg(secs)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dealId])

  const paragraphsBySection = useMemo(() => {
    const map = new Map<string, Paragraph[]>()
    for (const p of memo.paragraphs ?? []) {
      if (!map.has(p.section_id)) map.set(p.section_id, [])
      map.get(p.section_id)!.push(p)
    }
    return map
  }, [memo.paragraphs])

  // Section order + titles for rendering: the deal's section config when set
  // (authoritative, includes custom sections), else the built-in order. Any
  // section_ids present on paragraphs but not in that list are appended so no
  // content is ever hidden.
  const usingConfig = !!(sectionCfg && sectionCfg.length > 0)
  const renderSections = useMemo(() => {
    const base = usingConfig
      ? sectionCfg!.filter(s => s.included !== false).map(s => ({ id: s.id, title: s.title }))
      : SECTION_ORDER
    const known = new Set(base.map(s => s.id))
    const extras = Array.from(new Set((memo.paragraphs ?? []).map(p => p.section_id)))
      .filter(id => !known.has(id))
      .map(id => ({ id, title: id === ROUND_CHANGES_SECTION_ID ? (memoRevisionTitle(memo) ?? humanizeSectionId(id)) : humanizeSectionId(id) }))
    // A later round's "What changed since Round N" opens the memo.
    return withRoundChangesFirst([...base, ...extras])
  }, [usingConfig, sectionCfg, memo])

  const selectedPara = useMemo(() => (memo.paragraphs ?? []).find(p => p.id === selected) ?? null, [memo.paragraphs, selected])

  // Initialize editing draft when selecting a paragraph.
  useEffect(() => {
    if (selectedPara) setProseDraft(selectedPara.prose)
  }, [selectedPara?.id])

  async function saveParagraph() {
    if (!selectedPara) return
    setSavingPara(true)
    setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paragraph_edits: [{ id: selectedPara.id, prose: proseDraft }] }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Save failed')
      }
      setDraft(prev => ({
        ...prev,
        memo_draft_output: prev.memo_draft_output ? {
          ...prev.memo_draft_output,
          paragraphs: prev.memo_draft_output.paragraphs.map(p =>
            p.id === selectedPara.id ? { ...p, prose: proseDraft, origin: 'partner_edited' as const } : p),
        } : prev.memo_draft_output,
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingPara(false)
    }
  }

  // Apply a draft mutation via PATCH and re-sync local state from the
  // returned memo_draft_output (the server is authoritative — needed for
  // inserts, whose ids are server-generated).
  async function patchDraft(body: Record<string, unknown>): Promise<MemoOutput | null> {
    setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Update failed')
      if (data.memo_draft_output) {
        setDraft(prev => ({ ...prev, memo_draft_output: data.memo_draft_output }))
        return data.memo_draft_output as MemoOutput
      }
      return null
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
      return null
    }
  }

  // Move a paragraph up/down within its section. Orders are renormalized to
  // 0,1,2,… for the whole section so they stay clean.
  async function moveParagraph(id: string, dir: 'up' | 'down') {
    const para = (memo.paragraphs ?? []).find(p => p.id === id)
    if (!para) return
    const inSection = (memo.paragraphs ?? [])
      .filter(p => p.section_id === para.section_id)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const idx = inSection.findIndex(p => p.id === id)
    const swapWith = dir === 'up' ? idx - 1 : idx + 1
    if (swapWith < 0 || swapWith >= inSection.length) return
    const reordered = inSection.slice()
    ;[reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]]
    await patchDraft({
      paragraph_order: reordered.map((p, i) => ({ id: p.id, section_id: p.section_id, order: i })),
    })
  }

  // Drag-and-drop reorder within a section. Paragraphs cannot cross sections,
  // mirroring moveParagraph — drops onto a different section are ignored.
  async function dropParagraphOnto(dragId: string, targetId: string) {
    if (dragId === targetId) return
    const all = memo.paragraphs ?? []
    const dragPara = all.find(p => p.id === dragId)
    const targetPara = all.find(p => p.id === targetId)
    if (!dragPara || !targetPara || dragPara.section_id !== targetPara.section_id) return
    const inSection = all
      .filter(p => p.section_id === dragPara.section_id)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const from = inSection.findIndex(p => p.id === dragId)
    const to = inSection.findIndex(p => p.id === targetId)
    if (from === -1 || to === -1) return
    const [moved] = inSection.splice(from, 1)
    inSection.splice(to, 0, moved)
    await patchDraft({
      paragraph_order: inSection.map((p, i) => ({ id: p.id, section_id: p.section_id, order: i })),
    })
  }

  async function toggleHidden(id: string) {
    const para = (memo.paragraphs ?? []).find(p => p.id === id)
    if (!para) return
    await patchDraft({ paragraph_visibility: [{ id, hidden: !para.hidden }] })
  }

  async function insertParagraph(sectionId: string) {
    const inSection = (memo.paragraphs ?? []).filter(p => p.section_id === sectionId)
    const nextOrder = inSection.reduce((max, p) => Math.max(max, p.order ?? 0), -1) + 1
    const updated = await patchDraft({
      paragraph_inserts: [{ section_id: sectionId, order: nextOrder, prose: 'New paragraph. Write your content here.' }],
    })
    if (updated) {
      // Select the newest partner-drafted paragraph in this section for editing.
      const fresh = updated.paragraphs
        .filter(p => p.section_id === sectionId && p.origin === 'partner_drafted')
        .sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0]
      if (fresh) setSelected(fresh.id)
    }
  }

  async function exportTo(format: ExportFormat) {
    setExporting(format)
    setError(null)
    setExportResult(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/agent/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, draft_id: draft.id }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Render failed')
      if (format === 'markdown' && typeof body.content === 'string') {
        const url = URL.createObjectURL(new Blob([body.content], { type: 'text/markdown' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `${dealName.replace(/[\\/:*?"<>|]/g, '_')} memo (${draft.draft_version}).md`
        a.click()
        URL.revokeObjectURL(url)
        return
      }
      setExportResult({
        format,
        url: body.download_url ?? body.web_view_link ?? null,
        note: body.design_note ?? null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Render failed')
    } finally {
      setExporting(null)
    }
  }

  // A partner's edited Word file back in: a new draft version with the edits, and the changes listed.
  async function importWord(file: File) {
    setImporting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('draft_id', draft.id)
      const res = await fetch(`/api/diligence/${dealId}/drafts/import`, { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Import failed')
      window.location.href = `/diligence/${dealId}/drafts/${body.draft_id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function finalize() {
    const ok = await confirm({
      title: 'Mark as final?',
      description: 'Finalizing locks the draft. Edits after this require running a new draft. The recommendation section must be filled in.',
      confirmLabel: 'Finalize',
    })
    if (!ok) return
    setFinalizing(true)
    setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draft.id}/finalize`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Finalize failed')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Finalize failed')
    } finally {
      setFinalizing(false)
    }
  }

  async function updateAttentionStatus(itemId: string, status: 'open' | 'ignore' | 'done') {
    setAttention(prev => prev.map(a => a.id === itemId ? { ...a, status } : a))
    await fetch(`/api/diligence/${dealId}/attention/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
  }

  const openAttention = attention.filter(a => a.status === 'open')
  const dismissedAttention = attention.filter(a => a.status !== 'open')

  return (
    <div className={embedded ? '' : 'p-4 md:py-8 md:pl-8 md:pr-4 max-w-[1400px]'}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          {!embedded && (
            <Link href={`/diligence/${dealId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to deal
            </Link>
          )}
          <h1 className={`${embedded ? 'text-base' : 'text-xl'} font-semibold tracking-tight truncate flex items-center gap-2`}>
            {embedded ? 'Memo draft' : `${dealName} memo`}
            {!draft.is_draft && (
              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-success-subtle dark:bg-success-subtle/30 text-success">
                <Lock className="h-3 w-3 inline mr-0.5" /> Final
              </span>
            )}
          </h1>
          <div className="text-xs text-muted-foreground mt-0.5">
            {round && (
              <span className="mr-1">
                Diligence round {round.round_number}{round.label ? ` · ${round.label}` : ''}
                {roundClosed && <span> · <Lock className="h-3 w-3 inline -mt-0.5" /> closed, read only</span>}
                {' · '}
              </span>
            )}
            <span className="font-mono">{draft.draft_version} · {draft.agent_version}</span>
            {draft.written_by && WRITTEN_BY[draft.written_by] && <span> · {WRITTEN_BY[draft.written_by]}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dismissedAttention.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShowAttention(s => !s)}>
              {showAttention ? 'Hide dismissed' : `Dismissed (${dismissedAttention.length})`}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => exportTo('docx')} disabled={exporting !== null}>
            {exporting === 'docx' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1" />}
            Word Doc
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportTo('gdoc')} disabled={exporting !== null}>
            {exporting === 'gdoc' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            Google Doc
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportTo('pdf')} disabled={exporting !== null}>
            {exporting === 'pdf' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1" />}
            PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportTo('markdown')} disabled={exporting !== null}>
            {exporting === 'markdown' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            Markdown
          </Button>
          {!isReadOnly && (
            <label className={`inline-flex items-center h-8 px-3 rounded-md border border-input text-sm cursor-pointer hover:bg-muted ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
              {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
              Import Word
              <input
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importWord(f) }}
              />
            </label>
          )}
          {isAdmin && draft.is_draft && (
            <Button variant="outline" size="sm" onClick={finalize} disabled={finalizing}>
              {finalizing && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Mark as final
            </Button>
          )}
        </div>
      </div>

      {error && <div className="rounded-card border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive mb-4">{error}</div>}
      {exportResult?.url && (
        <div className="rounded-card border border-success/40 bg-success-subtle/50 dark:bg-success-subtle/10 p-3 text-sm mb-4 flex items-center justify-between gap-2">
          <span>
            Export ready ({exportResult.format})
            {exportResult.note && <span className="block text-xs text-muted-foreground mt-0.5">{exportResult.note}</span>}
          </span>
          <a href={exportResult.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            Open <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      <div className="max-w-3xl">
        {/* The review's flags: what the investment-memo checklist found, for whoever wrote the draft. */}
        {draft.is_draft && (draft.review_flags?.length ?? 0) > 0 && (
          <details className="rounded-card border p-3 text-sm mb-4" open={draft.review_flags!.some(f => f.severity === 'must_fix')}>
            <summary className="cursor-pointer text-xs font-medium">
              Review: {draft.review_flags!.filter(f => f.severity === 'must_fix').length} to fix, {draft.review_flags!.filter(f => f.severity === 'check').length} to check
            </summary>
            <ul className="mt-2 space-y-1">
              {draft.review_flags!.map((f, i) => (
                <li key={i} className="text-xs flex gap-2">
                  <span className={f.severity === 'must_fix' ? 'text-destructive' : 'text-warning'}>{f.severity === 'must_fix' ? 'Fix' : 'Check'}</span>
                  <span className="text-muted-foreground">
                    {f.paragraph_id ? (
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSelected(f.paragraph_id!)}>{f.section ?? f.paragraph_id}</button>
                    ) : f.section}
                    {(f.paragraph_id || f.section) ? ': ' : ''}{f.message}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Warnings surfaced inline at the top of the memo; dismiss to clear. */}
        {openAttention.length > 0 && (
          <div className="space-y-2 mb-6">
            {openAttention.map(item => (
              <div
                key={item.id}
                className={`rounded-card border p-3 text-sm flex items-start gap-2 ${item.urgency === 'must_address' ? 'border-destructive/40 bg-destructive/5' : item.urgency === 'should_address' ? 'border-warning/40 bg-warning-subtle/50 dark:bg-warning-subtle/10' : 'bg-muted/30'}`}
              >
                <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${item.urgency === 'must_address' ? 'text-destructive' : item.urgency === 'should_address' ? 'text-warning dark:text-warning' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium capitalize">
                    {item.kind.replace(/_/g, ' ')}
                    <span className="text-[10px] font-normal text-muted-foreground"> · {item.urgency.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{item.body}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => updateAttentionStatus(item.id, 'done')} className="text-[11px] text-muted-foreground hover:text-foreground">Mark done</button>
                  <button onClick={() => updateAttentionStatus(item.id, 'ignore')} className="text-muted-foreground hover:text-foreground" title="Dismiss" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
        {showAttention && dismissedAttention.length > 0 && (
          <div className="space-y-2 mb-6">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Dismissed warnings</div>
            {dismissedAttention.map(item => (
              <div key={item.id} className="rounded-card border p-3 text-sm flex items-start gap-2 opacity-60">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium capitalize">{item.kind.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 line-through">{item.body}</div>
                </div>
                <button onClick={() => updateAttentionStatus(item.id, 'open')} className="text-[11px] text-muted-foreground hover:text-foreground shrink-0">Reopen ({item.status})</button>
              </div>
            ))}
          </div>
        )}
        <div>
          {renderSections.map(section => {
            const paragraphs = (paragraphsBySection.get(section.id) ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            // Hide empty sections only in the default (non-config) view. When the
            // partner has defined a section list, show every included section so
            // the structure is visible and paragraphs can be added.
            if (!usingConfig && paragraphs.length === 0 && section.id !== 'recommendation') return null
            return (
              <section key={section.id} className="mb-6" id={`sec-${section.id}`}>
                <h2 className="text-base font-semibold tracking-tight mb-2">{section.title}</h2>
                {paragraphs.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">[No content yet for this section.]</p>
                ) : (
                  paragraphs.map((p, i) => (
                    <div
                      key={p.id}
                      onDragOver={dragId && dragId !== p.id ? (e) => { e.preventDefault(); if (overId !== p.id) setOverId(p.id) } : undefined}
                      onDrop={dragId ? (e) => { e.preventDefault(); const d = dragId; setDragId(null); setOverId(null); if (d) dropParagraphOnto(d, p.id) } : undefined}
                      className={dragId && dragId !== p.id && overId === p.id ? 'border-t-2 border-primary' : ''}
                    >
                      <ParagraphView
                        paragraph={p}
                        roundNumber={memo.revision?.round_number ?? null}
                        sourceLabels={labels}
                        isSelected={selected === p.id}
                        onSelect={() => setSelected(p.id)}
                        editing={selected === p.id && !isReadOnly}
                        proseDraft={proseDraft}
                        onProseChange={setProseDraft}
                        onSave={saveParagraph}
                        onCancel={() => setSelected(null)}
                        saving={savingPara}
                        readOnly={isReadOnly}
                        canMoveUp={i > 0}
                        canMoveDown={i < paragraphs.length - 1}
                        onMoveUp={() => moveParagraph(p.id, 'up')}
                        onMoveDown={() => moveParagraph(p.id, 'down')}
                        onToggleHidden={() => toggleHidden(p.id)}
                        dragHandle={!isReadOnly ? (
                          <span
                            draggable
                            onClick={e => e.stopPropagation()}
                            onDragStart={(e) => { e.stopPropagation(); setDragId(p.id); e.dataTransfer.effectAllowed = 'move' }}
                            onDragEnd={() => { setDragId(null); setOverId(null) }}
                            className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground"
                            title="Drag to reorder"
                            aria-label="Drag to reorder"
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </span>
                        ) : null}
                      />
                    </div>
                  ))
                )}
                {!isReadOnly && (
                  <button
                    onClick={() => insertParagraph(section.id)}
                    className="text-xs text-muted-foreground hover:text-foreground mt-1"
                  >
                    + Add paragraph
                  </button>
                )}
              </section>
            )
          })}

          {/* Scoring lives on the Scoring tab (and in the exported memo output) —
              not duplicated inline here. */}
        </div>
      </div>
    </div>
  )
}

function ParagraphView({
  paragraph, editing, proseDraft, onProseChange, onSave, onCancel, saving, onSelect, readOnly, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onToggleHidden, dragHandle, sourceLabels, roundNumber,
}: {
  paragraph: Paragraph
  sourceLabels: Map<string, SourceLabel>
  editing: boolean
  proseDraft: string
  onProseChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  isSelected: boolean
  onSelect: () => void
  readOnly: boolean
  roundNumber?: number | null
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleHidden: () => void
  dragHandle?: React.ReactNode
}) {
  const isPlaceholder = paragraph.origin === 'partner_only_placeholder'
  const stop = (e: React.MouseEvent, fn: () => void) => { e.stopPropagation(); fn() }
  const realSources = paragraph.sources.filter(s => s.source_type !== 'partner_only')

  // Inline edit — the prose becomes an editable field in place; no sidebar.
  if (editing) {
    return (
      <div className="rounded-md p-3 mb-2 text-sm bg-muted/30 ring-1 ring-primary/30">
        {isPlaceholder ? (
          <div className="rounded-md border border-warning/40 bg-warning-subtle/50 dark:bg-warning-subtle/10 p-2 text-xs">
            Partner-only section. Use “+ Add paragraph” to write the partner-drafted content for this section.
          </div>
        ) : (
          <textarea
            value={proseDraft}
            onChange={e => onProseChange(e.target.value)}
            rows={6}
            autoFocus
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave()
              if (e.key === 'Escape') onCancel()
            }}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}
        <div className="flex items-center gap-2 mt-2">
          {!isPlaceholder && (
            <Button variant="outline" size="sm" onClick={onSave} disabled={saving || proseDraft === paragraph.prose}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              Save
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>Done</Button>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Badge tone="muted">{paragraph.origin.replace(/_/g, ' ')}</Badge>
            <RoundBadge status={paragraph.round_status} roundNumber={roundNumber} />
            {paragraph.contains_projection && <Badge tone="amber">projection</Badge>}
            {paragraph.contains_unverified_claim && <Badge tone="amber">⚠ unverified</Badge>}
            {paragraph.contains_contradiction && <Badge tone="red">contradiction</Badge>}
          </span>
        </div>
        {realSources.length > 0 && <SourceList sources={realSources} labels={sourceLabels} />}
      </div>
    )
  }

  return (
    <div
      className={`group rounded-md p-3 mb-2 transition-colors text-sm ${readOnly ? '' : 'hover:bg-muted/30'} ${paragraph.hidden ? 'opacity-50' : ''}`}
    >
      <p className={isPlaceholder ? 'italic text-muted-foreground' : ''}>
        {paragraph.prose}
        {!paragraph.hidden && realSources.length > 0 && (
          <sup className="ml-1 text-[10px] text-muted-foreground">
            {realSources.slice(0, 5).map((s, i) => (
              // The marker names its document on hover, so a reader can check a sentence
              // without leaving the prose.
              <span key={i} title={formatSource(s, sourceLabels)} className="cursor-help">[{i + 1}]</span>
            ))}
          </sup>
        )}
      </p>
      {!paragraph.hidden && realSources.length > 0 && (
        <SourceList sources={realSources} labels={sourceLabels} />
      )}
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {dragHandle}
        {!readOnly && !isPlaceholder && (
          <button onClick={e => stop(e, onSelect)} className="text-[11px] text-muted-foreground hover:text-foreground">Edit</button>
        )}
        <Badge tone="muted">{paragraph.origin.replace(/_/g, ' ')}</Badge>
        <RoundBadge status={paragraph.round_status} roundNumber={roundNumber} />
        {paragraph.hidden && <Badge tone="amber">hidden · excluded from export</Badge>}
        {paragraph.contains_projection && <Badge tone="amber">projection</Badge>}
        {paragraph.contains_unverified_claim && <Badge tone="amber">⚠ unverified</Badge>}
        {paragraph.contains_contradiction && <Badge tone="red">contradiction</Badge>}
        {!readOnly && (
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={e => stop(e, onMoveUp)}
              disabled={!canMoveUp}
              className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30"
              title="Move up"
            >↑</button>
            <button
              onClick={e => stop(e, onMoveDown)}
              disabled={!canMoveDown}
              className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30"
              title="Move down"
            >↓</button>
            <button
              onClick={e => stop(e, onToggleHidden)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
              title={paragraph.hidden ? 'Show in export' : 'Hide from export'}
            >{paragraph.hidden ? 'Show' : 'Hide'}</button>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The sources behind a paragraph, named.
 *
 * This used to print `[1] claim:c_4f2a` — the id of the claim, which tells a reader
 * nothing they can check. What they need is the document in the data room that backs
 * the sentence, so that is what leads; the raw id is kept only as a hover title for
 * tracing back to the ingestion output.
 */
function SourceList({ sources, labels }: { sources: Array<{ source_type: string; source_id: string }>; labels: Map<string, SourceLabel> }) {
  return (
    <div className="text-[11px] text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1">
      <span className="font-medium">Sources:</span>
      {sources.slice(0, 8).map((s, i) => {
        const hit = labels.get(`${s.source_type}:${s.source_id}`)
        return (
          <span key={i} title={`${s.source_type}:${s.source_id}`} className="inline-flex items-center gap-1">
            <span className="tabular-nums">[{i + 1}]</span>
            {hit?.url ? (
              <a href={hit.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
                {hit.label}
              </a>
            ) : (
              <span className="text-foreground/80">{hit?.label ?? `${s.source_type}:${s.source_id}`}</span>
            )}
            {hit?.detail && <span className="text-muted-foreground/70">— {hit.detail}</span>}
          </span>
        )
      })}
      {sources.length > 8 && <span className="text-muted-foreground/60">+{sources.length - 8} more</span>}
    </div>
  )
}

/** Whether a later round kept, revised or added the paragraph. Kept paragraphs need no mark. */
function RoundBadge({ status, roundNumber }: { status?: Paragraph['round_status']; roundNumber?: number | null }) {
  if (!status || status === 'kept') return null
  const r = roundNumber ? ` in R${roundNumber}` : ''
  return <Badge tone={status === 'revised' ? 'amber' : 'muted'}>{status === 'revised' ? `revised${r}` : `new${r}`}</Badge>
}

function Badge({ tone = 'muted', children }: { tone?: 'muted' | 'amber' | 'red'; children: React.ReactNode }) {
  const cls = tone === 'red'
    ? 'bg-destructive-subtle dark:bg-destructive-subtle/30 text-destructive'
    : tone === 'amber'
      ? 'bg-warning-subtle dark:bg-warning-subtle/30 text-warning'
      : 'bg-muted text-muted-foreground'
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{children}</span>
}
