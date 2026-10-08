'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Trash2, Upload, FolderInput, Check, Play, RefreshCw, AlertCircle, Lock, ChevronDown, GripVertical, Pencil, Plus, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useConfirm } from '@/components/confirm-dialog'
import { IngestionSummary } from '@/components/diligence/ingestion-summary'
import { StageHeader, DiligenceStageBar } from '@/components/diligence/stage-header'
import { DataRoomBar } from '@/components/diligence/progress-bars'
import { countDocuments } from '@/lib/diligence/progress'
import { SchemaViewer } from '@/components/diligence/schema-viewer'
import { AffinityPanel } from '@/components/diligence/affinity-panel'
import { EmailIntakeTray } from '@/components/diligence/email-intake-tray'
import type { IngestionOutput } from '@/lib/memo-agent/stages/ingest'
import type { ResearchOutput } from '@/lib/memo-agent/stages/research'
import { uploadDiligenceDocument } from '@/lib/diligence/upload-document'
import { MemoEditor } from './drafts/[draftId]/memo-editor'
import { MemoConfigPanel } from '@/components/diligence/memo-config-panel'
import { EntityPicker } from '@/components/entity-picker'

interface Deal {
  id: string
  fund_id: string
  name: string
  sector: string | null
  stage_at_consideration: string | null
  deal_status: 'active' | 'passed' | 'invested' | 'won' | 'lost' | 'on_hold'
  current_memo_stage: string
  lead_partner_id: string | null
  vehicle_id?: string | null
  promoted_company_id: string | null
  drive_folder_url: string | null
  created_at: string
  updated_at: string
}

interface DiligenceDocument {
  id: string
  file_name: string
  file_format: string
  file_size_bytes: number | null
  detected_type: string | null
  type_confidence: string | null
  parse_status: string
  parse_notes: string | null
  drive_source_url: string | null
  uploaded_at: string
}

type LatestDraft = {
  id: string
  draft_version: string
  agent_version: string
  is_draft: boolean
  created_at: string
  finalized_at: string | null
} | null

// Tabs follow the actual workflow: Overview is the partner-facing landing
// (DDP status, details, finalize/promote), then the pipeline goes Data Room →
// Diligence (external research) → Partner Q&A → Memo. Notes live in a
// right-side slide-in panel, mirroring the Companies notes UX.
const TABS = ['Checklist', 'Data Room', 'Research', 'Founders', 'Scoring', 'Memo', 'Settings'] as const
type Tab = typeof TABS[number]

// Deal stages: Invested, Active, Passed. No color accents — the label alone
// communicates state. Legacy values (won/lost/on_hold) map onto the current
// three so existing rows still render.
const STATUS_LABEL: Record<string, string> = {
  invested: 'Invested',
  active:   'Active',
  passed:   'Passed',
  won:      'Invested',
  lost:     'Passed',
  on_hold:  'Active',
}

const STATUS_OPTIONS: Deal['deal_status'][] = ['invested', 'active', 'passed']
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s

export function DealDetail({ deal: initial, initialDocuments, latestDraft, isAdmin, currentUserId, initialTab = 'Checklist' }: {
  deal: Deal
  initialDocuments: DiligenceDocument[]
  latestDraft: LatestDraft
  isAdmin: boolean
  currentUserId: string
  initialTab?: Tab
}) {
  const router = useRouter()
  const [deal, setDeal] = useState(initial)
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  // Documents live here (not inside Data Room) so the Checklist tab's
  // doc-count gate and the Data Room list stay in sync after an import/upload.
  const [documents, setDocuments] = useState(initialDocuments)
  // Cross-tab doc focus: clicking evidence on the Checklist tab sets this id,
  // switches to Data Room, and the room scrolls/highlights the matching row.
  const [focusDocId, setFocusDocId] = useState<string | null>(null)
  const jumpToDoc = (docId: string) => { setActiveTab('Data Room'); setFocusDocId(docId) }

  // Refresh the doc list whenever the Checklist or Data Room tab is shown, so a
  // Drive import / upload made on one tab is reflected on the other without a
  // manual page refresh (fixes the stale "nothing uploaded yet" gate).
  useEffect(() => {
    if (activeTab !== 'Checklist' && activeTab !== 'Data Room') return
    let cancelled = false
    fetch(`/api/diligence/${deal.id}/documents`)
      .then(r => (r.ok ? r.json() : null))
      .then(rows => { if (!cancelled && Array.isArray(rows)) setDocuments(rows) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeTab, deal.id])

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(deal.name)
  const [editingMeta, setEditingMeta] = useState(false)
  const [sectorDraft, setSectorDraft] = useState(deal.sector ?? '')
  const [stageDraft, setStageDraft] = useState(deal.stage_at_consideration ?? '')

  function cancelMeta() {
    setEditingMeta(false)
    setSectorDraft(deal.sector ?? '')
    setStageDraft(deal.stage_at_consideration ?? '')
  }
  async function saveMeta() {
    setEditingMeta(false)
    const sector = sectorDraft.trim()
    const stage = stageDraft.trim()
    if (sector === (deal.sector ?? '') && stage === (deal.stage_at_consideration ?? '')) return
    setDeal(d => ({ ...d, sector: sector || null, stage_at_consideration: stage || null }))
    await fetch(`/api/diligence/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sector, stage_at_consideration: stage }),
    })
    router.refresh()
  }

  async function updateEntity(vehicle_id: string | null) {
    const previous = deal.vehicle_id ?? null
    setDeal(d => ({ ...d, vehicle_id }))
    const res = await fetch(`/api/diligence/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id }),
    })
    if (!res.ok) setDeal(d => ({ ...d, vehicle_id: previous }))
    router.refresh()
  }

  async function updateStatus(deal_status: Deal['deal_status']) {
    setDeal(d => ({ ...d, deal_status }))
    await fetch(`/api/diligence/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deal_status }),
    })
    router.refresh()
  }

  async function saveName() {
    setEditingName(false)
    const name = nameDraft.trim()
    if (!name || name === deal.name) { setNameDraft(deal.name); return }
    setDeal(d => ({ ...d, name }))
    await fetch(`/api/diligence/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    router.refresh()
  }

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <Link href="/diligence" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to diligence
      </Link>

      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          {editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') { setNameDraft(deal.name); setEditingName(false) }
              }}
              className="text-2xl font-semibold h-10 max-w-xl"
            />
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 group min-w-0">
              <span className="truncate">{deal.name}</span>
              <button
                type="button"
                onClick={() => { setNameDraft(deal.name); setEditingName(true) }}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                title="Rename deal"
                aria-label="Rename deal"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </h1>
          )}
          {editingMeta ? (
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Input
                autoFocus
                value={sectorDraft}
                onChange={e => setSectorDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveMeta(); if (e.key === 'Escape') cancelMeta() }}
                placeholder="Sector / type"
                className="h-7 text-sm w-44"
              />
              <Input
                value={stageDraft}
                onChange={e => setStageDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveMeta(); if (e.key === 'Escape') cancelMeta() }}
                placeholder="Stage"
                className="h-7 text-sm w-44"
              />
              <Button size="sm" variant="outline" className="h-7" onClick={saveMeta}>Save</Button>
              <button type="button" onClick={cancelMeta} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2 group/meta">
              <span>{[
                deal.sector,
                deal.stage_at_consideration,
                `Created ${new Date(deal.created_at).toLocaleDateString()}`,
              ].filter(Boolean).join(' · ')}</span>
              <button
                type="button"
                onClick={() => { setSectorDraft(deal.sector ?? ''); setStageDraft(deal.stage_at_consideration ?? ''); setEditingMeta(true) }}
                className="opacity-0 group-hover/meta:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                title="Edit sector & stage"
                aria-label="Edit sector and stage"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-44" title="The entity this diligence is for — its team can see it">
            <EntityPicker value={deal.vehicle_id ?? null} onChange={updateEntity} allowUnassigned />
          </div>
          <StatusDropdown value={deal.deal_status} onPick={updateStatus} />
        </div>
      </div>

      {/* Where the deal is in the pipeline, and what's left. Clicking a stage jumps
          to the tab that runs it. */}
      <DiligenceStageBar dealId={deal.id} onJump={tab => setActiveTab(tab as Tab)} />

      <div className="border-b mb-4">
        <nav className="flex gap-4 -mb-px">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`pb-2 px-1 text-sm border-b-2 ${activeTab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-5xl w-full">
          {activeTab === 'Checklist' && (
            <ChecklistTab deal={deal} documentCount={documents.length} latestDraft={latestDraft} isAdmin={isAdmin} onJumpToTab={setActiveTab} onJumpToDoc={jumpToDoc} />
          )}
          {activeTab === 'Data Room' && (
            <DealRoomTab dealId={deal.id} dealName={deal.name} documents={documents} setDocuments={setDocuments} initialDriveFolderUrl={deal.drive_folder_url} focusDocId={focusDocId} onFocusConsumed={() => setFocusDocId(null)} />
          )}
          {activeTab === 'Research' && <ResearchTab dealId={deal.id} userId={currentUserId} isAdmin={isAdmin} />}
          {activeTab === 'Founders' && <FoundersTab dealId={deal.id} />}
          {activeTab === 'Scoring' && <ScoringTab dealId={deal.id} />}
          {activeTab === 'Memo' && <MemoTab dealId={deal.id} dealName={deal.name} isAdmin={isAdmin} />}
          {activeTab === 'Settings' && <SettingsTab dealId={deal.id} dealName={deal.name} isAdmin={isAdmin} />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Checklist — partner-facing landing. Surfaces the partner's diligence
// checklist with found/missing status from the data room, inline edit, and
// the promote action.
// ---------------------------------------------------------------------------

type ChecklistItem = {
  id: string
  parent_id: string | null
  kind: 'section' | 'item'
  label: string
  status: 'unknown' | 'found' | 'partial' | 'missing' | 'not_applicable'
  evidence: Array<{ document_id?: string; summary?: string }>
  agent_notes: string | null
  partner_notes: string | null
  partner_facts: Array<{ id: string; text: string }> | null
  order_index: number
  source: 'template' | 'partner_added' | 'imported' | 'agent_added'
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
}

function formatJobTiming(status: string, startedAt: string | null, enqueuedAt: string | null, itemCount: number): string {
  if (status === 'pending') {
    if (enqueuedAt) {
      return `Queued ${formatDuration((Date.now() - new Date(enqueuedAt).getTime()) / 1000)} ago`
    }
    return 'Queued'
  }
  if (status === 'running' && startedAt) {
    const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000
    // Rough ETA from item count: ~15s baseline + ~0.4s per item, clamped 20–180s.
    const etaSeconds = Math.max(20, Math.min(180, 15 + Math.floor(itemCount * 0.4)))
    return `Elapsed ${formatDuration(elapsed)} · typical run ~${formatDuration(etaSeconds)}`
  }
  return ''
}

const STATUS_PILL: Record<ChecklistItem['status'], { label: string; cls: string }> = {
  unknown:        { label: 'Not yet assessed', cls: 'bg-muted text-muted-foreground' },
  found:          { label: 'Found',            cls: 'bg-success-subtle dark:bg-success-subtle/30 text-success' },
  partial:        { label: 'Partial',          cls: 'bg-warning-subtle dark:bg-warning-subtle/30 text-warning' },
  missing:        { label: 'Missing',          cls: 'bg-destructive-subtle dark:bg-destructive-subtle/30 text-destructive' },
  not_applicable: { label: 'N/A',              cls: 'bg-muted text-muted-foreground' },
}

function ChecklistTab({ deal, documentCount, isAdmin, onJumpToDoc }: {
  deal: Deal
  documentCount: number
  latestDraft: LatestDraft
  isAdmin: boolean
  onJumpToTab: (tab: Tab) => void
  onJumpToDoc: (docId: string) => void
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [items, setItems] = useState<ChecklistItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [savePasteAsDefault, setSavePasteAsDefault] = useState(false)
  const [assessmentJob, setAssessmentJob] = useState<{ id: string; status: string; progress: string | null; started_at: string | null; enqueued_at: string | null; error: string | null } | null>(null)
  // Findings tagged to checklist items, indexed by checklist_item_id. Loaded
  // from the latest draft's ingestion_output. Refreshes when ingest finishes.
  const [findingsByItem, setFindingsByItem] = useState<Record<string, Array<{ doc_id: string; doc_name: string; field: string; value: string; criticality: string }>>>({})
  // Latest draft + doc-name map drive the collapsible "Data-room findings"
  // section rendered below the checklist (gaps + per-document extraction).
  const [ingestionDraft, setIngestionDraft] = useState<any>(null)
  const [fileNamesById, setFileNamesById] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/diligence/${deal.id}/drafts`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/diligence/${deal.id}/documents`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([drafts, docs]) => {
      if (cancelled) return
      const latest = Array.isArray(drafts) ? drafts[0] : null
      const nameById: Record<string, string> = {}
      for (const d of (docs ?? [])) nameById[d.id] = d.file_name
      setFileNamesById(nameById)
      setIngestionDraft(latest)
      const ingest = latest?.ingestion_output
      if (!ingest?.documents) { setFindingsByItem({}); return }
      const grouped: Record<string, Array<{ doc_id: string; doc_name: string; field: string; value: string; criticality: string }>> = {}
      for (const doc of ingest.documents) {
        for (const c of (doc.claims ?? [])) {
          if (!c.checklist_item_id) continue
          if (!grouped[c.checklist_item_id]) grouped[c.checklist_item_id] = []
          grouped[c.checklist_item_id].push({
            doc_id: doc.document_id,
            doc_name: nameById[doc.document_id] ?? doc.document_id,
            field: c.field,
            value: c.value,
            criticality: c.criticality,
          })
        }
      }
      setFindingsByItem(grouped)
    })
    return () => { cancelled = true }
  }, [deal.id, assessmentJob?.status])
  const [, forceTick] = useState(0)
  // Tick every second while a job is in flight so the elapsed-time label
  // re-renders. Cheap (no fetches) and only runs while a job is active.
  useEffect(() => {
    if (!assessmentJob || assessmentJob.status === 'success' || assessmentJob.status === 'failed') return
    const t = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [assessmentJob])
  const [hideCompleted, setHideCompleted] = useState(false)
  // Per-section collapse state. Persisted in localStorage so partners returning
  // to a deal aren't scrolling through the same expansions every time.
  const collapseKey = `diligence-checklist-collapsed-${deal.id}`
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(collapseKey)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(collapseKey, JSON.stringify(collapsed)) } catch {}
  }, [collapsed, collapseKey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/diligence/${deal.id}/checklist`)
        if (!res.ok) throw new Error(await res.text())
        const json = await res.json()
        if (!cancelled) setItems(json.items as ChecklistItem[])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [deal.id])

  async function applyFundDefault() {
    setError(null)
    setBusy(true)
    try {
      const tpl = await fetch('/api/diligence/checklist-template').then(r => r.json())
      const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'replace', text: tpl.template ?? '' }),
      })
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json()
      setItems(json.items as ChecklistItem[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function applyPasted() {
    if (!pasteText.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'replace', text: pasteText }),
      })
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json()
      setItems(json.items as ChecklistItem[])
      // Optionally promote this checklist to the fund-wide default (the single
      // place to set it now that the Diligence Settings page is gone).
      if (savePasteAsDefault) {
        await fetch('/api/diligence/checklist-template', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template: pasteText }),
        }).catch(() => {})
      }
      setPasteOpen(false)
      setPasteText('')
      setSavePasteAsDefault(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function deleteItem(itemId: string) {
    const target = items?.find(i => i.id === itemId)
    const isSection = target?.kind === 'section'
    const childCount = isSection ? (items ?? []).filter(i => i.parent_id === itemId).length : 0
    const ok = await confirm({
      title: isSection ? `Delete section?` : 'Delete item?',
      description: isSection
        ? (childCount > 0
          ? `Removes the section and its ${childCount} item${childCount === 1 ? '' : 's'} from this deal.`
          : 'Removes the section from this deal.')
        : 'This removes the row from this deal only.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/diligence/${deal.id}/checklist?itemId=${itemId}`, { method: 'DELETE' })
    if (res.ok) setItems(prev => prev?.filter(i => i.id !== itemId && i.parent_id !== itemId) ?? null)
  }

  async function addSection(label: string) {
    if (!label.trim()) return
    setError(null)
    const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'add_section', label: label.trim() }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to add section')
      return
    }
    const { item } = await res.json()
    setItems(prev => (prev ? [...prev, item] : [item]))
  }

  async function patchItem(itemId: string, patch: Partial<Pick<ChecklistItem, 'label' | 'status' | 'partner_notes' | 'partner_facts'>>) {
    const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, ...patch }),
    })
    if (!res.ok) return
    const { item } = await res.json()
    setItems(prev => prev?.map(i => (i.id === itemId ? item : i)) ?? null)
  }

  async function addItem(label: string, sectionLabel: string | null) {
    const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'add', label, sectionLabel: sectionLabel ?? '' }),
    })
    if (!res.ok) return
    const { item } = await res.json()
    setItems(prev => (prev ? [...prev, item] : [item]))
  }

  // Persist a drag-and-drop reorder of sibling items. `orderedIds` is the new
  // order of a set of items that share a parent. We permute their own
  // order_index slots, then re-sort, so the change is local to that group.
  async function reorderItems(orderedIds: string[]) {
    if (orderedIds.length < 2) return
    setItems(prev => {
      if (!prev) return prev
      const slots = prev
        .filter(i => orderedIds.includes(i.id))
        .map(i => i.order_index)
        .sort((a, b) => a - b)
      const newOrder: Record<string, number> = {}
      orderedIds.forEach((id, i) => { newOrder[id] = slots[i] })
      return prev
        .map(i => (i.id in newOrder ? { ...i, order_index: newOrder[i.id] } : i))
        .sort((a, b) => a.order_index - b.order_index)
    })
    const res = await fetch(`/api/diligence/${deal.id}/checklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'reorder', itemIds: orderedIds }),
    })
    if (!res.ok) {
      // Resync from the server if the persist failed.
      const reload = await fetch(`/api/diligence/${deal.id}/checklist`)
      if (reload.ok) setItems((await reload.json()).items as ChecklistItem[])
    }
  }


  async function runAssessment() {
    setError(null)
    const res = await fetch(`/api/diligence/${deal.id}/agent/checklist-assessment`, { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(json.error ?? 'Assessment failed to enqueue')
      return
    }
    setAssessmentJob({ id: json.job_id, status: 'pending', progress: 'Queued…', started_at: null, enqueued_at: new Date().toISOString(), error: null })
  }

  // Poll for any in-flight checklist_assessment job — covers both partner-
  // triggered runs and the auto-enqueued one after ingest_synthesis. Refresh
  // the checklist rows when the job completes so the new statuses land.
  useEffect(() => {
    let cancelled = false
    let lastSeenSuccessId: string | null = null

    const tick = async () => {
      try {
        const res = await fetch(`/api/diligence/${deal.id}/agent/status`)
        if (!res.ok || cancelled) return
        const j = await res.json()
        const latest = j.latest_job as { id: string; kind: string; status: string; progress_message: string | null; started_at: string | null; enqueued_at: string | null; error: string | null } | null
        if (!latest || latest.kind !== 'checklist_assessment') return

        // Discover an in-flight job we didn't enqueue ourselves (e.g. the
        // auto-trigger after ingest_synthesis).
        if ((latest.status === 'pending' || latest.status === 'running') && (!assessmentJob || assessmentJob.id !== latest.id)) {
          setAssessmentJob({ id: latest.id, status: latest.status, progress: latest.progress_message, started_at: latest.started_at, enqueued_at: latest.enqueued_at, error: null })
          return
        }
        if (assessmentJob && latest.id === assessmentJob.id) {
          setAssessmentJob(prev => prev ? { ...prev, status: latest.status, progress: latest.progress_message, started_at: latest.started_at ?? prev.started_at, error: latest.error ?? prev.error } : prev)
          if (latest.status === 'success' && lastSeenSuccessId !== latest.id) {
            lastSeenSuccessId = latest.id
            const itemsRes = await fetch(`/api/diligence/${deal.id}/checklist`)
            if (itemsRes.ok && !cancelled) {
              const j2 = await itemsRes.json()
              setItems(j2.items as ChecklistItem[])
            }
          }
        }
      } catch {
        // network blip — try again next tick
      }
    }

    tick()
    const t = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [deal.id, assessmentJob?.id])

  if (loading) return <div className="text-sm text-muted-foreground py-8">Loading checklist…</div>

  const sections = (items ?? []).filter(i => i.kind === 'section')
  const itemsBySection: Record<string, ChecklistItem[]> = {}
  for (const it of items ?? []) {
    if (it.kind !== 'item') continue
    const key = it.parent_id ?? '__root__'
    if (!itemsBySection[key]) itemsBySection[key] = []
    itemsBySection[key].push(it)
  }
  const orphanItems = itemsBySection['__root__'] ?? []
  const allItems = (items ?? []).filter(i => i.kind === 'item')
  const counts = {
    found: allItems.filter(i => i.status === 'found').length,
    partial: allItems.filter(i => i.status === 'partial').length,
    missing: allItems.filter(i => i.status === 'missing').length,
    unknown: allItems.filter(i => i.status === 'unknown' || i.status === 'not_applicable').length,
  }
  const isEmpty = (items ?? []).length === 0

  return (
    <div className="space-y-4">
      {/* The checklist assessment had no button at all before — you could only reach it
          through a failure banner or as a side effect of analyzing the data room. */}
      <StageHeader dealId={deal.id} stageKey="checklist" />

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {isEmpty && <>No checklist yet for this deal.</>}
        </div>
        <div className="flex items-center gap-2">
          {!isEmpty && (
            <label className="text-xs text-muted-foreground inline-flex items-center gap-1.5 mr-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideCompleted}
                onChange={e => setHideCompleted(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Hide completed
            </label>
          )}
          <Button variant="outline" size="sm" onClick={applyFundDefault} disabled={busy}>
            {isEmpty ? 'Apply fund default' : 'Reset from fund default'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPasteOpen(true)} disabled={busy}>
            Paste checklist
          </Button>
        </div>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      {assessmentJob && assessmentJob.status !== 'success' && assessmentJob.status !== 'failed' && (
        <div className="flex items-start gap-2 text-sm rounded-md border border-info dark:border-info/40 bg-info-subtle dark:bg-info-subtle/30 px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-info mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-info font-medium">
              {assessmentJob.status === 'pending' ? 'Queued, worker picks up within ~1 minute' : 'AI assessment in progress'}
            </div>
            <div className="text-xs text-info mt-0.5 flex flex-wrap gap-x-3">
              {assessmentJob.progress && <span className="truncate">{assessmentJob.progress}</span>}
              <span>{formatJobTiming(assessmentJob.status, assessmentJob.started_at, assessmentJob.enqueued_at, allItems.length)}</span>
            </div>
          </div>
        </div>
      )}
      {assessmentJob && assessmentJob.status === 'failed' && (
        <div className="text-sm rounded-md border border-destructive bg-destructive-subtle dark:bg-destructive-subtle/30 px-3 py-2 text-destructive">
          <div className="font-medium">AI assessment failed</div>
          {assessmentJob.error ? (
            <div className="text-xs mt-1 break-words whitespace-pre-wrap">{assessmentJob.error}</div>
          ) : (
            <div className="text-xs mt-1 opacity-80">No error detail was recorded. Check the cron worker logs.</div>
          )}
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={runAssessment}>Try again</Button>
          </div>
        </div>
      )}

      {pasteOpen && (
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="text-sm font-medium">Paste a checklist</div>
            <div className="text-xs text-muted-foreground">
              Section headers on their own line; items below. Replaces any existing checklist on this deal.
            </div>
            <textarea
              className="w-full min-h-[200px] rounded border bg-background p-2 text-sm font-mono"
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder={`Business Summary\nUpdated pitch deck\nProduct demo\n\nMarket\nTAM analysis\n...`}
            />
            <div className="flex items-center justify-between gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input type="checkbox" checked={savePasteAsDefault} onChange={e => setSavePasteAsDefault(e.target.checked)} className="h-3.5 w-3.5" />
                Also save as fund default
              </label>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setPasteOpen(false); setPasteText(''); setSavePasteAsDefault(false) }}>Cancel</Button>
                <Button size="sm" onClick={applyPasted} disabled={busy || !pasteText.trim()}>Apply</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {isEmpty && !pasteOpen && (
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <div className="text-sm text-muted-foreground">
              Start by applying your fund's default diligence checklist, or paste your own.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sections */}
      {sections.map(sec => (
        <ChecklistSection
          key={sec.id}
          section={sec}
          items={itemsBySection[sec.id] ?? []}
          findingsByItem={findingsByItem}
          hideCompleted={hideCompleted}
          collapsed={!!collapsed[sec.id]}
          onToggleCollapsed={() => setCollapsed(prev => ({ ...prev, [sec.id]: !prev[sec.id] }))}
          onDelete={deleteItem}
          onPatch={patchItem}
          onAdd={(label) => addItem(label, sec.label)}
          onReorder={reorderItems}
          onJumpToDoc={onJumpToDoc}
        />
      ))}

      {orphanItems.length > 0 && (
        <ChecklistSection
          section={null}
          items={orphanItems}
          findingsByItem={findingsByItem}
          hideCompleted={hideCompleted}
          collapsed={!!collapsed['__orphan__']}
          onToggleCollapsed={() => setCollapsed(prev => ({ ...prev, __orphan__: !prev.__orphan__ }))}
          onDelete={deleteItem}
          onPatch={patchItem}
          onAdd={(label) => addItem(label, '')}
          onReorder={reorderItems}
          onJumpToDoc={onJumpToDoc}
        />
      )}

      {!isEmpty && <AddSectionRow onAdd={addSection} />}

      {/* Data-room findings, gaps + per-document extraction from the latest
          ingestion, tucked into a collapsible below the checklist so the
          checklist itself stays front-and-center. */}
      {ingestionDraft?.ingestion_output && (
        <Accordion title="Data-room findings" subtitle="Missing docs & per-document extraction">
          <IngestionSummary
            output={ingestionDraft.ingestion_output as IngestionOutput}
            fileNamesById={fileNamesById}
            dealId={deal.id}
            draftId={ingestionDraft.id}
            editable={ingestionDraft.is_draft !== false}
          />
        </Accordion>
      )}

      <SchemaViewer
        schemaName="data_room_ingestion"
        title="How the agent works"
        subtitle="checklist analysis"
        guidanceStage="ingest"
        description="How the analysis reads your documents and checks them against this checklist: the document types, extraction rules, and how findings are tagged to checklist items."
        defaultOpen={!ingestionDraft?.ingestion_output}
      />
    </div>
  )
}

function ChecklistSection({ section, items, findingsByItem, hideCompleted, collapsed, onToggleCollapsed, onDelete, onPatch, onAdd, onReorder, onJumpToDoc }: {
  section: ChecklistItem | null
  items: ChecklistItem[]
  findingsByItem: Record<string, Array<{ doc_id: string; doc_name: string; field: string; value: string; criticality: string }>>
  hideCompleted: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onDelete: (itemId: string) => void
  onPatch: (itemId: string, patch: Partial<Pick<ChecklistItem, 'label' | 'status' | 'partner_notes' | 'partner_facts'>>) => void
  onAdd: (label: string) => void
  onReorder: (orderedIds: string[]) => void
  onJumpToDoc: (docId: string) => void
}) {
  const [adding, setAdding] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const visibleItems = hideCompleted
    ? items.filter(it => it.status !== 'found' && it.status !== 'not_applicable')
    : items
  const hiddenCount = items.length - visibleItems.length
  // Per-section status mini-counts for the collapsed header.
  const counts = {
    found: items.filter(i => i.status === 'found').length,
    partial: items.filter(i => i.status === 'partial').length,
    missing: items.filter(i => i.status === 'missing').length,
  }
  const [editingSection, setEditingSection] = useState(false)
  const [sectionDraft, setSectionDraft] = useState(section?.label ?? '')
  useEffect(() => { setSectionDraft(section?.label ?? '') }, [section?.label])

  function handleDrop(targetId: string) {
    const from = visibleItems.findIndex(i => i.id === dragId)
    const to = visibleItems.findIndex(i => i.id === targetId)
    setDragId(null)
    setOverId(null)
    if (from === -1 || to === -1 || from === to) return
    const next = visibleItems.map(i => i.id)
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  return (
    <div className="rounded-lg border bg-card group/section">
      <div className={`flex items-center gap-2 px-4 py-3 text-sm font-medium ${collapsed ? '' : 'border-b'}`}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform shrink-0 ${collapsed ? '-rotate-90' : ''}`} />
          {section && editingSection ? (
            <Input
              autoFocus
              value={sectionDraft}
              onChange={e => setSectionDraft(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={() => {
                if (sectionDraft.trim() && sectionDraft !== section.label) onPatch(section.id, { label: sectionDraft.trim() })
                setEditingSection(false)
              }}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') { setSectionDraft(section.label); setEditingSection(false) }
              }}
              className="h-6 text-sm font-medium"
            />
          ) : (
            <span className="truncate">{section?.label ?? 'Other'}</span>
          )}
        </button>
        <span className="text-xs font-normal text-muted-foreground shrink-0">
          {items.length} item{items.length === 1 ? '' : 's'}
          {counts.found > 0 && <span className="ml-1.5">· {counts.found} found</span>}
          {counts.partial > 0 && <span className="ml-1.5">· {counts.partial} partial</span>}
          {counts.missing > 0 && <span className="ml-1.5">· {counts.missing} missing</span>}
        </span>
        {section && !editingSection && (
          <span className="flex items-center gap-2 shrink-0 opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => setEditingSection(true)}
              className="text-muted-foreground hover:text-foreground text-xs"
              title="Rename section"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => onDelete(section.id)}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete section"
              title="Delete section"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {!collapsed && (
      <div className="divide-y">
        {visibleItems.map(it => (
          <div
            key={it.id}
            onDragOver={dragId ? (e) => { e.preventDefault(); if (overId !== it.id) setOverId(it.id) } : undefined}
            onDrop={dragId ? (e) => { e.preventDefault(); handleDrop(it.id) } : undefined}
            className={dragId && dragId !== it.id && overId === it.id ? 'border-t-2 border-primary' : ''}
          >
            <ChecklistRow
              item={it}
              findings={findingsByItem[it.id] ?? []}
              onDelete={onDelete}
              onPatch={onPatch}
              onJumpToDoc={onJumpToDoc}
              dragHandle={
                <span
                  draggable
                  onDragStart={(e) => { setDragId(it.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => { setDragId(null); setOverId(null) }}
                  className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground"
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
              }
            />
          </div>
        ))}
        {visibleItems.length === 0 && items.length === 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground">No items in this section yet.</div>
        )}
        {visibleItems.length === 0 && items.length > 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground italic">All {hiddenCount} items completed.</div>
        )}
        <div className="flex items-center gap-2 px-4 py-3">
          <Input
            value={adding}
            onChange={e => setAdding(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && adding.trim()) {
                onAdd(adding.trim())
                setAdding('')
              }
            }}
            placeholder="Add item (press Enter)"
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!adding.trim()}
            onClick={() => { onAdd(adding.trim()); setAdding('') }}
          >
            Add
          </Button>
        </div>
      </div>
      )}
    </div>
  )
}

function AddSectionRow({ onAdd }: { onAdd: (label: string) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-dashed border rounded-lg bg-muted/20">
      <Input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && draft.trim()) {
            onAdd(draft.trim())
            setDraft('')
          }
        }}
        placeholder="Add a new section (press Enter)"
        className="h-8 text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!draft.trim()}
        onClick={() => { onAdd(draft.trim()); setDraft('') }}
      >
        Add section
      </Button>
    </div>
  )
}

function ChecklistRow({ item, findings, onDelete, onPatch, onJumpToDoc, dragHandle }: {
  item: ChecklistItem
  findings: Array<{ doc_id: string; doc_name: string; field: string; value: string; criticality: string }>
  onDelete: (itemId: string) => void
  onPatch: (itemId: string, patch: Partial<Pick<ChecklistItem, 'label' | 'status' | 'partner_notes' | 'partner_facts'>>) => void
  onJumpToDoc: (docId: string) => void
  dragHandle?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.label)
  const [findingsOpen, setFindingsOpen] = useState(false)
  const [addingFact, setAddingFact] = useState(false)
  const [factDraft, setFactDraft] = useState('')
  const [editingFactId, setEditingFactId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const pill = STATUS_PILL[item.status]

  // Partner-entered data points, rendered in the same format as analysis
  // evidence. Fall back to the legacy single `partner_notes` value until the
  // first edit folds it into the list (and clears the old column).
  const storedFacts = Array.isArray(item.partner_facts) ? item.partner_facts : []
  const partnerFacts: Array<{ id: string; text: string }> = storedFacts.length > 0
    ? storedFacts
    : (item.partner_notes ? [{ id: 'legacy', text: item.partner_notes }] : [])

  // Give every entry a stable id (legacy/blank → fresh) before persisting, and
  // clear the deprecated partner_notes column once we've written the list.
  const commitFacts = (next: Array<{ id: string; text: string }>) => {
    const normalized = next
      .map(f => ({ id: f.id && f.id !== 'legacy' ? f.id : `fact_${Math.random().toString(36).slice(2, 9)}`, text: f.text.trim() }))
      .filter(f => f.text.length > 0)
    onPatch(item.id, { partner_facts: normalized, ...(item.partner_notes ? { partner_notes: '' } : {}) })
  }
  const addFact = () => {
    const text = factDraft.trim()
    if (!text) { setAddingFact(false); return }
    commitFacts([...partnerFacts, { id: '', text }])
    setFactDraft(''); setAddingFact(false)
  }
  const saveFactEdit = (id: string) => {
    commitFacts(partnerFacts.map(f => (f.id === id ? { ...f, text: editDraft } : f)))
    setEditingFactId(null); setEditDraft('')
  }
  const deleteFact = (id: string) => commitFacts(partnerFacts.filter(f => f.id !== id))
  return (
    <div className="group/row flex items-start gap-2 px-4 py-2">
      {dragHandle}
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim() && draft !== item.label) onPatch(item.id, { label: draft.trim() })
              setEditing(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') { setDraft(item.label); setEditing(false) }
            }}
            className="h-7 text-sm"
          />
        ) : (
          <button
            type="button"
            className="text-sm text-left hover:underline truncate w-full"
            onClick={() => setEditing(true)}
          >
            {item.label}
          </button>
        )}
        {item.agent_notes && (
          <div className="text-xs text-muted-foreground mt-1">{item.agent_notes}</div>
        )}
        {/* Partner data points, manually-entered facts, same format as the
            analysis evidence below. These survive re-analysis. */}
        {(partnerFacts.length > 0 || addingFact) && (
          <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
            {partnerFacts.map(f => (
              <div key={f.id} className="group flex items-start gap-1">
                {editingFactId === f.id ? (
                  <div className="flex-1 flex items-center gap-1">
                    <Input
                      value={editDraft}
                      onChange={e => setEditDraft(e.target.value)}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); saveFactEdit(f.id) }
                        if (e.key === 'Escape') { setEditingFactId(null); setEditDraft('') }
                      }}
                      className="h-6 text-xs flex-1"
                    />
                    <button type="button" onClick={() => saveFactEdit(f.id)} className="text-[11px] text-foreground hover:underline">Save</button>
                    <button type="button" onClick={() => { setEditingFactId(null); setEditDraft('') }} className="text-[11px] hover:underline">Cancel</button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1">
                      <span className="text-foreground/70">↳</span> {f.text} <span className="text-foreground/40">· you</span>
                    </span>
                    <button type="button" onClick={() => { setEditingFactId(f.id); setEditDraft(f.text) }} className="opacity-0 group-hover:opacity-100 text-[11px] hover:text-foreground">Edit</button>
                    <button type="button" onClick={() => deleteFact(f.id)} className="opacity-0 group-hover:opacity-100 text-[11px] hover:text-destructive">Delete</button>
                  </>
                )}
              </div>
            ))}
            {addingFact && (
              <div className="flex items-center gap-1">
                <Input
                  value={factDraft}
                  onChange={e => setFactDraft(e.target.value)}
                  autoFocus
                  placeholder="A fact or data point you know, e.g. 'Reference call with CTO confirmed 18-mo runway'"
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); addFact() }
                    if (e.key === 'Escape') { setAddingFact(false); setFactDraft('') }
                  }}
                  className="h-6 text-xs flex-1"
                />
                <button type="button" onClick={addFact} className="text-[11px] text-foreground hover:underline">Save</button>
                <button type="button" onClick={() => { setAddingFact(false); setFactDraft('') }} className="text-[11px] hover:underline">Cancel</button>
              </div>
            )}
          </div>
        )}
        {!addingFact && (
          <button
            type="button"
            onClick={() => setAddingFact(true)}
            className="text-[11px] text-muted-foreground hover:text-foreground mt-1"
          >
            + Add data point
          </button>
        )}
        {item.evidence?.length > 0 && (
          <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
            {item.evidence.slice(0, 3).map((e, i) => (
              <button
                key={i}
                type="button"
                onClick={() => e.document_id && onJumpToDoc(e.document_id)}
                disabled={!e.document_id}
                className="block truncate text-left w-full hover:text-foreground hover:underline disabled:hover:no-underline disabled:cursor-default"
                title={e.document_id ? 'Jump to document in Data Room' : undefined}
              >
                <span className="text-foreground/70">↳</span> {e.summary || e.document_id}
              </button>
            ))}
          </div>
        )}
        {findings.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setFindingsOpen(o => !o)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              {findingsOpen ? '▾' : '▸'} {findings.length} finding{findings.length === 1 ? '' : 's'} from ingestion
            </button>
            {findingsOpen && (
              <div className="mt-1 space-y-0.5 pl-3 text-[11px] text-muted-foreground">
                {findings.map((f, i) => (
                  <div key={i} className="truncate">
                    <button
                      type="button"
                      onClick={() => onJumpToDoc(f.doc_id)}
                      className="hover:text-foreground hover:underline"
                      title="Jump to source document"
                    >
                      <span className="text-foreground/70">·</span>{' '}
                      <span className="font-mono">{f.field}</span>: {f.value}
                      <span className="text-foreground/40 ml-1">— {f.doc_name}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <select
        value={item.status}
        onChange={e => onPatch(item.id, { status: e.target.value as ChecklistItem['status'] })}
        className={`text-[11px] rounded px-1.5 py-0.5 border-0 outline-none focus:ring-1 focus:ring-primary ${pill.cls}`}
      >
        {(Object.keys(STATUS_PILL) as ChecklistItem['status'][]).map(s => (
          <option key={s} value={s}>{STATUS_PILL[s].label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="shrink-0 text-muted-foreground hover:text-destructive p-1 opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity"
        aria-label="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v ?? '—'}</span>
    </div>
  )
}

function StatusDropdown({ value, onPick }: { value: Deal['deal_status']; onPick: (s: Deal['deal_status']) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center h-8 px-3 rounded-md text-xs font-medium border bg-background hover:bg-muted"
        >
          {statusLabel(value)}
          <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        {STATUS_OPTIONS.map(s => (
          <button
            key={s}
            onClick={() => { setOpen(false); onPick(s) }}
            className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted ${s === value ? 'bg-muted font-medium' : ''}`}
          >
            {statusLabel(s)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Deal Room
// ---------------------------------------------------------------------------

const DOC_TYPE_OPTIONS = [
  { value: '', label: '— uncategorized —' },
  { value: 'pitch_deck', label: 'Pitch deck' },
  { value: 'financial_model', label: 'Financial model' },
  { value: 'cap_table', label: 'Cap table' },
  { value: 'data_room_summary', label: 'Data room summary' },
  { value: 'memo', label: 'Memo' },
  { value: 'product_overview', label: 'Product overview' },
  { value: 'customer_references', label: 'Customer references' },
  { value: 'legal', label: 'Legal' },
  { value: 'market_research', label: 'Market research' },
  { value: 'team_bio', label: 'Team bio' },
  { value: 'press', label: 'Press' },
  { value: 'industry_expert', label: 'Industry expert' },
  { value: 'sales', label: 'Sales' },
  { value: 'call_recording', label: 'Call recording (audio/video)' },
  { value: 'call_transcript', label: 'Call transcript' },
  { value: 'other', label: 'Other' },
]

function DealRoomTab({ dealId, dealName, documents, setDocuments, initialDriveFolderUrl, focusDocId, onFocusConsumed }: { dealId: string; dealName: string; documents: DiligenceDocument[]; setDocuments: React.Dispatch<React.SetStateAction<DiligenceDocument[]>>; initialDriveFolderUrl: string | null; focusDocId: string | null; onFocusConsumed: () => void }) {
  const confirm = useConfirm()
  // When the partner jumps from a checklist evidence row, scroll to and
  // briefly highlight the target document so the connection is obvious.
  const [highlightedDocId, setHighlightedDocId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusDocId) return
    const el = document.getElementById(`doc-row-${focusDocId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedDocId(focusDocId)
      const t = setTimeout(() => setHighlightedDocId(null), 2500)
      onFocusConsumed()
      return () => clearTimeout(t)
    }
    // If the doc isn't in the current list (e.g. deleted), just clear the focus.
    onFocusConsumed()
  }, [focusDocId, onFocusConsumed])
  const [uploading, setUploading] = useState(false)
  const [driveOpen, setDriveOpen] = useState(false)
  // Docs with an in-flight process/transcribe job. Held from click until the
  // doc reaches a terminal parse_status — the polling effect below clears it.
  const [processing, setProcessing] = useState<Set<string>>(new Set())
  const [reprocessError, setReprocessError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Poll the documents list while anything is processing, so the row reflects
  // the actual job lifecycle (not just the brief enqueue call) and updates
  // when the worker finishes — no manual refresh needed.
  const anyProcessing = processing.size > 0
  useEffect(() => {
    if (!anyProcessing) return
    const TERMINAL = ['parsed', 'failed', 'partial', 'transcribed', 'skipped']
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/diligence/${dealId}/documents`)
        if (!res.ok) return
        const rows = await res.json() as DiligenceDocument[]
        setDocuments(rows)
        setProcessing(prev => {
          const next = new Set(prev)
          for (const id of Array.from(prev)) {
            const row = rows.find(r => r.id === id)
            if (!row || TERMINAL.includes(row.parse_status)) next.delete(id)
          }
          return next
        })
      } catch { /* transient, try again next tick */ }
    }, 5000)
    return () => clearInterval(interval)
  }, [anyProcessing, dealId])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        // Direct-to-storage upload via signed URL — bypasses Vercel's
        // ~4.5 MB serverless body limit. Bucket caps each file at 100 MB.
        const row: DiligenceDocument = await uploadDiligenceDocument(dealId, file)
        setDocuments(prev => [row, ...prev])
      } catch {
        // continue with other files
      }
    }
    setUploading(false)
  }

  async function reclassify(id: string, detected_type: string) {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, detected_type: detected_type || null, type_confidence: 'high' } : d))
    await fetch(`/api/diligence/${dealId}/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detected_type: detected_type || null }),
    })
  }

  async function setSkipped(id: string) {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, parse_status: 'skipped' } : d))
    await fetch(`/api/diligence/${dealId}/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parse_status: 'skipped' }),
    })
  }

  // Ingest a single document on its own. Works for a brand-new (pending)
  // upload, a re-run of an already-processed doc, or a previously-skipped
  // doc. The ingest API treats a one-document request as a partial run: the
  // result is merged into the deal's existing ingestion output (other docs
  // untouched) and a synthesis refresh is auto-enqueued — additive, not a reset.
  //
  // On success the doc stays in `processing` — the polling effect clears it
  // once the worker drives it to a terminal status, so the button reflects
  // the real job lifecycle rather than just the enqueue call.
  async function processDocument(id: string) {
    setProcessing(prev => { const next = new Set(prev); next.add(id); return next })
    setReprocessError(null)
    try {
      // A skipped doc is filtered out by loadDealDocuments, so it must be
      // un-skipped (back to pending) before the ingest will pick it up.
      const current = documents.find(d => d.id === id)
      if (current?.parse_status === 'skipped') {
        const unskipRes = await fetch(`/api/diligence/${dealId}/documents/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parse_status: 'pending' }),
        })
        if (!unskipRes.ok) {
          const b = await unskipRes.json().catch(() => ({}))
          throw new Error(b?.error ?? 'Failed to un-skip document')
        }
      }

      const res = await fetch(`/api/diligence/${dealId}/agent/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: [id] }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? 'Failed to enqueue processing')
      // Optimistic — mark pending; the doc stays in `processing` until polled done.
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, parse_status: 'pending', parse_notes: null } : d))
    } catch (err) {
      setReprocessError(err instanceof Error ? err.message : 'Failed to enqueue processing')
      // Failed to even enqueue — release the in-flight state immediately.
      setProcessing(prev => { const next = new Set(prev); next.delete(id); return next })
    }
  }

  // Transcribe a call recording. Standalone — produces a transcript document
  // (left pending) without auto-running memo ingest.
  async function transcribe(id: string) {
    setProcessing(prev => { const next = new Set(prev); next.add(id); return next })
    setReprocessError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/agent/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? 'Failed to enqueue transcription')
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, parse_status: 'pending' } : d))
    } catch (err) {
      setReprocessError(err instanceof Error ? err.message : 'Failed to enqueue transcription')
      setProcessing(prev => { const next = new Set(prev); next.delete(id); return next })
    }
  }

  async function remove(id: string) {
    const ok = await confirm({
      title: 'Delete document?',
      description: 'This removes the file from storage. Cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    })
    if (!ok) return
    setDocuments(prev => prev.filter(d => d.id !== id))
    await fetch(`/api/diligence/${dealId}/documents/${id}`, { method: 'DELETE' })
  }

  // Pull the documents list fresh after an external import (Affinity, accepted
  // email) so the new rows show up without a page reload.
  const refreshDocuments = async () => {
    try {
      const res = await fetch(`/api/diligence/${dealId}/documents`)
      if (res.ok) setDocuments(await res.json() as DiligenceDocument[])
    } catch { /* the next poll or reload will catch up */ }
  }

  return (
    <div className="space-y-6">
      {/* Inbound emails matched to this deal, waiting on a human. Sits at the top
          because it's the only thing here that's a queue — everything below is
          reference. */}
      <EmailIntakeTray dealId={dealId} onAccepted={refreshDocuments} />

      {/* Analyze-the-data-room used to live on the CHECKLIST tab — which is why it was
          so hard to find. It belongs here, with the documents it reads. */}
      <IngestionPanel dealId={dealId} documents={documents} />

      <div>
      {/* Affinity link + import. Its own block rather than a toolbar button:
          it streams a progress log and carries link/sync status underneath. */}
      <div className="mb-3">
        <AffinityPanel dealId={dealId} dealName={dealName} onImported={refreshDocuments} />
      </div>

      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-sm font-medium text-muted-foreground">Documents</span>
        <div className="flex items-center gap-2">
        <label className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border bg-card text-sm hover:bg-muted/50 cursor-pointer">
          <Upload className="h-3.5 w-3.5" />
          {uploading ? 'Uploading…' : 'Upload files'}
          <input
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={e => handleFiles(e.target.files)}
          />
        </label>
        {!initialDriveFolderUrl ? (
          <Button variant="outline" size="sm" onClick={() => setDriveOpen(true)}>
            <FolderInput className="h-3.5 w-3.5 mr-1" /> Import from Drive
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDriveOpen(true)}
              title="Re-walk the linked Drive folder and import any files not already in the data room"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Pull new files from Drive
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <FolderInput className="h-3.5 w-3.5 mr-1" /> Add specific file
            </Button>
          </>
        )}
        </div>
      </div>

      {reprocessError && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {reprocessError}
        </div>
      )}

      {documents.length === 0 ? (
        <div className="rounded-card border bg-card p-12 text-center text-sm text-muted-foreground">
          No documents yet. Upload files or import a Drive folder to populate the deal room.
        </div>
      ) : (
        <div className="rounded-md border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr
                  key={d.id}
                  id={`doc-row-${d.id}`}
                  className={`border-t transition-colors ${highlightedDocId === d.id ? 'bg-warning-subtle dark:bg-warning-subtle/30' : ''}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium truncate max-w-[280px]">{d.file_name}</div>
                    {d.drive_source_url && (
                      <a href={d.drive_source_url} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:underline">Drive source ↗</a>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={d.detected_type ?? ''}
                      onChange={e => reclassify(d.id, e.target.value)}
                      className="h-7 px-1.5 rounded border border-input bg-background text-xs"
                    >
                      {DOC_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {d.type_confidence && (
                      <span className="ml-1 text-[10px] text-muted-foreground">({d.type_confidence})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {d.file_size_bytes ? `${(d.file_size_bytes / 1024 / 1024).toFixed(1)}MB` : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className="capitalize">{d.parse_status}</span>
                    {d.parse_status === 'failed' && d.parse_notes && (
                      <div className="text-[10px] text-destructive/80 mt-0.5 max-w-[280px]" title={d.parse_notes}>
                        {d.parse_notes.length > 80 ? `${d.parse_notes.slice(0, 80)}…` : d.parse_notes}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {(() => {
                        const inFlight = processing.has(d.id)
                        const isRecording = d.detected_type === 'call_recording'
                        if (isRecording) {
                          // Recordings can't be ingested directly — they're
                          // transcribed, and the transcript is what gets ingested.
                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2.5 text-muted-foreground hover:text-foreground"
                              onClick={() => transcribe(d.id)}
                              disabled={inFlight}
                              title="Transcribe this recording via Deepgram, produces a transcript document"
                            >
                              {inFlight
                                ? 'Transcribing…'
                                : d.parse_status === 'transcribed' ? 'Re-transcribe' : 'Transcribe'}
                            </Button>
                          )
                        }
                        const notYetProcessed = d.parse_status === 'pending' || d.parse_status === 'skipped'
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs px-2.5 text-muted-foreground hover:text-foreground"
                            onClick={() => processDocument(d.id)}
                            disabled={inFlight}
                            title={d.parse_status === 'skipped'
                              ? 'Un-skip and ingest this document, adds it to the existing ingestion output'
                              : d.parse_status === 'pending'
                                ? 'Ingest just this document, adds it to the existing ingestion output'
                                : 'Re-run ingest on just this document, replaces its entry, keeps the rest'}
                          >
                            {inFlight
                              ? 'Processing…'
                              : notYetProcessed ? 'Process' : 'Reprocess'}
                          </Button>
                        )
                      })()}
                      {d.parse_status !== 'skipped' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2.5 text-muted-foreground hover:text-foreground"
                          onClick={() => setSkipped(d.id)}
                        >
                          Skip
                        </Button>
                      )}
                      <button
                        onClick={() => remove(d.id)}
                        className="text-muted-foreground hover:text-destructive ml-0.5"
                        title="Delete document"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DriveImportDialog
        open={driveOpen}
        onOpenChange={setDriveOpen}
        dealId={dealId}
        initialFolderUrl={initialDriveFolderUrl}
        onImported={imported => {
          // Refresh documents list — easier than appending each.
          fetch(`/api/diligence/${dealId}/documents`).then(r => r.ok ? r.json() : []).then(setDocuments)
        }}
      />

      <DriveFilePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        dealId={dealId}
        folderUrl={initialDriveFolderUrl}
        onImported={() => {
          fetch(`/api/diligence/${dealId}/documents`).then(r => r.ok ? r.json() : []).then(setDocuments)
        }}
      />
      </div>
    </div>
  )
}

interface DriveFile {
  id: string
  name: string
  relative_path: string
  mime_type: string
  google_native: boolean
  already_imported: boolean
}

/**
 * Lists the deal's Drive folder and lets a partner import one or more
 * specific files — without re-walking and re-importing the whole folder.
 */
function DriveFilePicker({ open, onOpenChange, dealId, folderUrl, onImported }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  dealId: string
  folderUrl: string | null
  onImported: () => void
}) {
  const [files, setFiles] = useState<DriveFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true); setError(null); setFiles([]); setSelected(new Set()); setDoneMsg(null)
    fetch(`/api/diligence/${dealId}/documents/drive-files`)
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? 'Failed to list Drive files'); return b })
      .then(b => setFiles(Array.isArray(b.files) ? b.files : []))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to list Drive files'))
      .finally(() => setLoading(false))
  }, [open, dealId])

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function importSelected() {
    if (selected.size === 0) return
    setImporting(true); setError(null); setDoneMsg(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/documents/from-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_url: folderUrl ?? '', file_ids: Array.from(selected) }),
      })
      if (!res.ok || !res.body) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Import failed')
      }
      // Drain the NDJSON progress stream to completion.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let imported = 0
      let fatal: string | null = null
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const evt = JSON.parse(line)
          if (evt.type === 'done') imported = evt.imported
          if (evt.type === 'fatal') fatal = evt.error
        }
      }
      if (fatal) throw new Error(fatal)
      setDoneMsg(`Imported ${imported} file${imported === 1 ? '' : 's'}.`)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  if (!open) return null

  const importable = files.filter(f => !f.already_imported && !f.google_native)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !importing && onOpenChange(false)}>
      <div className="bg-card rounded-lg border shadow-lg w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b">
          <h3 className="text-base font-medium">Add a file from Drive</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Pick specific files to import; the rest of the data room is untouched.</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {loading && <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Listing Drive folder…</div>}
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}
          {doneMsg && <div className="rounded-md border border-success/40 bg-success-subtle dark:bg-success-subtle/30 p-2 text-xs text-success">{doneMsg}</div>}
          {!loading && !error && files.length === 0 && <div className="text-sm text-muted-foreground">No files in the Drive folder.</div>}
          {files.map(f => (
            <label
              key={f.id}
              className={`flex items-start gap-2 rounded-md p-2 text-sm ${f.already_imported || f.google_native ? 'opacity-50' : 'hover:bg-muted/40 cursor-pointer'}`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={f.already_imported || f.google_native || importing}
                checked={selected.has(f.id)}
                onChange={() => toggle(f.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{f.relative_path ? `${f.relative_path}/${f.name}` : f.name}</span>
                {f.already_imported && <span className="text-[10px] text-muted-foreground">already imported</span>}
                {f.google_native && <span className="text-[10px] text-muted-foreground">Google-native file (not importable)</span>}
              </span>
            </label>
          ))}
        </div>

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {selected.size} selected · {importable.length} importable
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>Close</Button>
            <Button size="sm" onClick={importSelected} disabled={importing || selected.size === 0}>
              {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              Import selected
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function DriveImportDialog({ open, onOpenChange, dealId, initialFolderUrl, onImported }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  dealId: string
  initialFolderUrl: string | null
  onImported: (count: number) => void
}) {
  const [folderUrl, setFolderUrl] = useState(initialFolderUrl ?? '')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Live progress state populated from the streamed import events.
  const [progress, setProgress] = useState<{ current: number; total: number; file: string; relativePath: string } | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])

  function appendLog(line: string) {
    setLogLines(prev => {
      const next = [...prev, line]
      return next.slice(-50)  // cap the visible tail
    })
  }

  async function submit() {
    if (!folderUrl.trim()) return
    setImporting(true)
    setError(null)
    setResult(null)
    setProgress(null)
    setLogLines([])
    try {
      const res = await fetch(`/api/diligence/${dealId}/documents/from-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_url: folderUrl }),
      })
      // Validation/auth errors come back as plain JSON, not a stream.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Import failed')
      }
      if (!res.body) throw new Error('Import stream not available')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const errorList: string[] = []
      let final: { imported: number; skipped: number; errors: number } | null = null
      let fatal: string | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let event: any
          try { event = JSON.parse(line) } catch { continue }
          switch (event.type) {
            case 'log':
              appendLog(event.message)
              break
            case 'listed':
              appendLog(`Listed ${event.count} file${event.count === 1 ? '' : 's'}.`)
              break
            case 'progress':
              setProgress({ current: event.current, total: event.total, file: event.file, relativePath: event.relativePath ?? '' })
              break
            case 'file_imported':
              appendLog(`✓ ${event.file}`)
              break
            case 'file_skipped':
              appendLog(`↷ ${event.file} (${event.reason})`)
              break
            case 'file_error':
              appendLog(`✗ ${event.file}: ${event.error}`)
              errorList.push(`${event.file}: ${event.error}`)
              break
            case 'done':
              final = { imported: event.imported, skipped: event.skipped, errors: event.errors }
              break
            case 'fatal':
              fatal = event.error
              break
          }
        }
      }

      if (fatal) throw new Error(fatal)
      if (final) {
        setResult({ imported: final.imported, skipped: final.skipped, errors: errorList })
        onImported(final.imported)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
      <div className="rounded-card border bg-card p-5 w-full max-w-lg">
        <h3 className="text-base font-semibold mb-2">Import from Drive folder</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Paste a Google Drive folder URL. Every file in the folder and its subfolders is imported. Files already imported (matched by Drive ID) are skipped.
        </p>
        <Input
          value={folderUrl}
          onChange={e => setFolderUrl(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/..."
          disabled={importing}
        />
        <ul className="mt-3 text-[11px] text-muted-foreground space-y-1 list-disc pl-4">
          <li>Walks subfolders up to <strong>5 levels deep</strong>. The imported filename shows the subfolder path (e.g. <code className="font-mono">Financials/Q1/model.xlsx</code>).</li>
          <li>Imports up to <strong>500 files</strong> per run, larger data rooms need to be split.</li>
          <li><strong>Google Docs, Sheets, and Slides are imported</strong> by exporting them (Docs &amp; Slides to PDF, Sheets to Excel). Other Google-native types (Forms, Drawings) and files over 100&nbsp;MB are skipped.</li>
          <li>Only files the connected Google account can access are visible. Shared folders work if your account has at least view access.</li>
        </ul>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        {/* Live progress while the import streams. */}
        {importing && progress && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-mono truncate min-w-0 mr-2">
                {progress.relativePath ? `${progress.relativePath}/` : ''}{progress.file}
              </span>
              <span className="text-muted-foreground shrink-0">{progress.current} / {progress.total}</span>
            </div>
            <div className="h-1.5 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(progress.current / Math.max(progress.total, 1)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Streaming log tail, shows the most recent ~10 lines while importing. */}
        {(importing || logLines.length > 0) && (
          <div className="mt-3 rounded-md border bg-muted/30 p-2 max-h-40 overflow-y-auto text-[11px] font-mono space-y-0.5">
            {logLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Connecting…</p>
            ) : (
              logLines.map((l, i) => <div key={i} className="truncate">{l}</div>)
            )}
          </div>
        )}

        {result && (
          <div className="mt-3 text-sm">
            <p>Imported: <span className="font-medium">{result.imported}</span> · Skipped: <span className="font-medium">{result.skipped}</span></p>
            {result.errors.length > 0 && (
              <details className="mt-1 text-xs text-muted-foreground">
                <summary>{result.errors.length} error{result.errors.length === 1 ? '' : 's'}</summary>
                <ul className="mt-1 space-y-0.5">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </details>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={() => { onOpenChange(false); setFolderUrl(''); setResult(null); setError(null); setLogLines([]); setProgress(null) }} disabled={importing}>
            Close
          </Button>
          <Button variant="outline" size="sm" onClick={submit} disabled={importing || !folderUrl.trim()}>
            {importing && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Import
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Placeholder
// ---------------------------------------------------------------------------

function PlaceholderTab({ phase }: { phase: string }) {
  return (
    <div className="rounded-card border bg-card p-12 text-center">
      <p className="text-sm text-muted-foreground">Coming in {phase}.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memo Agent — status polling + stage panels
// ---------------------------------------------------------------------------

interface AgentStatus {
  deal: { current_memo_stage: string }
  latest_job: {
    id: string
    kind: 'ingest' | 'ingest_synthesis' | 'research' | 'qa' | 'draft' | 'draft_review' | 'score' | 'render' | 'transcribe' | 'checklist_assessment'
    status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
    progress_message: string | null
    error: string | null
    enqueued_at: string
    started_at: string | null
    finished_at: string | null
    result: any
  } | null
  latest_draft: {
    id: string
    draft_version: string
    has_ingestion: boolean
    has_research: boolean
    has_qa: boolean
    has_memo_draft: boolean
  } | null
  /** True when ingestion has run more recently than the memo draft. */
  memo_stale?: boolean
  /** Documents uploaded since the memo was last drafted. */
  documents_added_since_draft?: number
}

function useAgentStatus(dealId: string) {
  const [status, setStatus] = useState<AgentStatus | null>(null)

  async function refresh() {
    try {
      const res = await fetch(`/api/diligence/${dealId}/agent/status`)
      if (res.ok) setStatus(await res.json())
    } catch { /* ignore */ }
  }

  useEffect(() => {
    refresh()
    // Poll every 5 seconds while a job is in flight; back off otherwise.
    const id = setInterval(() => {
      const j = status?.latest_job
      const inFlight = j && (j.status === 'pending' || j.status === 'running')
      if (inFlight) refresh()
    }, 5_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, status?.latest_job?.id, status?.latest_job?.status])

  return { status, refresh }
}

function IngestionPanel({ dealId, documents }: { dealId: string; documents: DiligenceDocument[] }) {
  const documentCount = documents.length
  const docCounts = countDocuments(documents)
  const { status, refresh } = useAgentStatus(dealId)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [failedDocIds, setFailedDocIds] = useState<string[]>([])

  // Refresh the failed-doc list, which drives the "Reprocess failed" button,
  // after every ingest run (not just on mount). The findings summary itself
  // now renders below the checklist in the Checklist tab.
  useEffect(() => {
    fetch(`/api/diligence/${dealId}/documents`).then(r => r.ok ? r.json() : []).then(docs => {
      const failed: string[] = []
      for (const d of docs ?? []) {
        if (d.parse_status === 'failed') failed.push(d.id)
      }
      setFailedDocIds(failed)
    }).catch(() => {})
  }, [dealId, status?.latest_draft?.id, status?.latest_draft?.has_ingestion, status?.latest_job?.status])

  const job = status?.latest_job
  // Treat the auto-enqueued synthesis job as part of the ingest workflow for
  // status display + button disabling, so the user sees continuous feedback
  // across the two-job pipeline rather than a misleading "complete" gap.
  const isIngestWorkflowJob = job?.kind === 'ingest' || job?.kind === 'ingest_synthesis' || job?.kind === 'checklist_assessment'
  const isInFlight = job && (job.status === 'pending' || job.status === 'running') && isIngestWorkflowJob

  async function runIngest(documentIds?: string[], opts?: { full?: boolean }) {
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      const payload: Record<string, unknown> = {}
      if (documentIds) payload.document_ids = documentIds
      if (opts?.full) payload.full = true
      const hasBody = Object.keys(payload).length > 0
      const res = await fetch(`/api/diligence/${dealId}/agent/ingest`, {
        method: 'POST',
        headers: hasBody ? { 'content-type': 'application/json' } : {},
        body: hasBody ? JSON.stringify(payload) : undefined,
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to enqueue ingest')
      // Incremental re-analyze may skip ingestion entirely (nothing new) or run
      // just the checklist checks — surface that so the user isn't left wondering.
      if (body.skipped || body.message) setNotice(body.message ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enqueue ingest')
    } finally {
      setSubmitting(false)
      await refresh()
    }
  }

  return (
    <Section
      title="Data room analysis"
      help="Reads your documents, checks them against this checklist (marking found / partial / missing), and surfaces gaps and cross-document inconsistencies. Re-analyzing only processes new or unparsed files and re-checks open items."
      action={
        <div className="flex items-center gap-2">
          {status?.latest_draft?.has_ingestion ? (
            // Split button: incremental re-analyze by default, with a menu for a
            // full re-analysis (re-ingest every file + re-check every item).
            <div className="flex items-center">
              <Button variant="outline" size="sm" className="rounded-r-none" onClick={() => runIngest()} disabled={submitting || !!isInFlight || documentCount === 0}>
                {isInFlight || submitting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                Re-analyze data room
              </Button>
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="rounded-l-none border-l-0 px-1.5" disabled={submitting || !!isInFlight || documentCount === 0} aria-label="Re-analyze options">
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1">
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); runIngest() }}
                    className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted"
                  >
                    <div className="font-medium">Re-analyze new &amp; open</div>
                    <div className="text-[11px] text-muted-foreground">Default: only new/unparsed files and open checklist items.</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); runIngest(undefined, { full: true }) }}
                    className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted"
                  >
                    <div className="font-medium">Re-analyze everything</div>
                    <div className="text-[11px] text-muted-foreground">Re-ingest all files and re-check every item (slower, costs more).</div>
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => runIngest()} disabled={submitting || !!isInFlight || documentCount === 0}>
              {isInFlight || submitting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
              Analyze data room
            </Button>
          )}
        </div>
      }
    >
      {/* How much of the room has actually been read. "12 documents" says nothing
          about whether the agent could parse them. */}
      <div className="mt-3">
        <DataRoomBar counts={docCounts.counts} total={docCounts.total} />
      </div>

      {documentCount === 0 && (
        <p className="text-xs text-muted-foreground italic mt-2">Upload at least one document to enable ingestion.</p>
      )}

      {notice && <p className="text-xs text-muted-foreground mt-2">{notice}</p>}

      {failedDocIds.length > 0 && !isInFlight && (
        <p className="text-xs text-muted-foreground mt-2">
          {failedDocIds.length} file{failedDocIds.length === 1 ? '' : 's'} failed to parse in the last run. Re-analyze to retry {failedDocIds.length === 1 ? 'it' : 'them'} (already-analyzed files are skipped).
        </p>
      )}

      <JobStatusLine job={job ?? null} kind={['ingest', 'ingest_synthesis', 'checklist_assessment']} error={error} />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Accordion helper — used by the Diligence tab to organize Internal /
// External / Q&A library so the partner can scan it without scrolling
// through every section at once.
// ---------------------------------------------------------------------------
function Accordion({ title, subtitle, defaultOpen, children }: { title: string; subtitle?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="border rounded-md bg-card">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="flex items-center gap-2">
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className="font-medium">{title}</span>
        </span>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t">{children}</div>}
    </div>
  )
}

// House-style section card (matches the Companies detail page): exactly one
// border level. Header = muted label (+ optional count) on the left, a single
// action slot on the right. Content inside is borderless — separated by
// dividers and whitespace, never another box.
// Dependency-free hover tooltip — an info icon that reveals a short note. Used
// to tuck away action descriptions so they don't take permanent vertical space.
function InfoHint({ text }: { text: string }) {
  return (
    <span className="relative inline-flex group/hint align-middle">
      <Info className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help" />
      <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-64 rounded-md border bg-popover px-3 py-2 text-xs leading-snug font-normal text-popover-foreground shadow-md opacity-0 group-hover/hint:opacity-100 transition-opacity">
        {text}
      </span>
    </span>
  )
}

function Section({ title, count, action, help, children, className }: {
  title?: string
  count?: number
  action?: React.ReactNode
  /** Optional explanation shown behind an info-icon tooltip next to the title. */
  help?: string
  children?: React.ReactNode
  className?: string
}) {
  // space-y-3 (not a header margin) so an empty/condition-only body collapses
  // and the header stays vertically centred in the card.
  return (
    <div className={`rounded-card border bg-card p-5 space-y-3 ${className ?? ''}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {title && <span className="text-sm font-medium text-muted-foreground truncate">{title}</span>}
            {help && <InfoHint text={help} />}
            {typeof count === 'number' && count > 0 && <span className="text-xs bg-muted rounded-full px-1.5 py-0.5 text-muted-foreground">{count}</span>}
          </div>
          {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

// Lightweight inline disclosure for secondary / long-tail content (Dismissed,
// reference material). No bordered box — just a chevron + muted label, the way
// the Companies page reveals collapsible sections.
function Disclosure({ title, subtitle, defaultOpen, children }: { title: string; subtitle?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        {title}
        {subtitle && <span className="text-xs font-normal text-muted-foreground">· {subtitle}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diligence tab — Internal (contradictions, founders), External (web research),
// and the Q&A library, all in accordions for easier scanning.
// ---------------------------------------------------------------------------
function ResearchTab({ dealId, userId, isAdmin }: { dealId: string; userId: string; isAdmin: boolean }) {
  const { status } = useAgentStatus(dealId)
  const [draft, setDraft] = useState<any>(null)
  // Doc-name map so cross-document inconsistencies can render "Across: <file>, <file>".
  const [fileNamesById, setFileNamesById] = useState<Record<string, string>>({})

  useEffect(() => {
    fetch(`/api/diligence/${dealId}/drafts`).then(r => r.ok ? r.json() : []).then(rows => {
      setDraft((rows ?? [])[0] ?? null)
    }).catch(() => {})
    fetch(`/api/diligence/${dealId}/documents`).then(r => r.ok ? r.json() : []).then(docs => {
      const map: Record<string, string> = {}
      for (const d of docs ?? []) map[d.id] = d.file_name
      setFileNamesById(map)
    }).catch(() => {})
  }, [dealId, status?.latest_draft?.id, status?.latest_job?.status])

  const job = status?.latest_job
  const isResearchInFlight = job && (job.status === 'pending' || job.status === 'running') && job.kind === 'research'
  const ingestReady = !!status?.latest_draft?.has_ingestion
  const research: ResearchOutput | null = draft?.research_output ?? null
  const draftId: string | undefined = draft?.id
  const editable = draft?.is_draft !== false
  const crossDocFlags: IngestionOutput['cross_doc_flags'] = draft?.ingestion_output?.cross_doc_flags ?? []

  // Persist a research_output edit (dismiss flags), optimistically.
  async function patchResearch(partial: Record<string, unknown>) {
    if (!draftId) return
    setDraft((d: any) => (d ? { ...d, research_output: { ...d.research_output, ...partial } } : d))
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ research_output: partial }),
      })
      if (res.ok) {
        const body = await res.json()
        if (body.research_output) setDraft((d: any) => (d ? { ...d, research_output: body.research_output } : d))
      }
    } catch { /* keep optimistic value */ }
  }

  async function patchCrossFlags(next: IngestionOutput['cross_doc_flags']) {
    if (!draftId) return
    setDraft((d: any) => (d ? { ...d, ingestion_output: { ...d.ingestion_output, cross_doc_flags: next } } : d))
    try {
      await fetch(`/api/diligence/${dealId}/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingestion_cross_doc_flags: next }),
      })
    } catch { /* keep optimistic value */ }
  }

  function toggleResearchDismiss(field: 'findings' | 'contradictions' | 'research_gaps', index: number) {
    if (!research) return
    const arr = (research[field] as any[]).map((it, i) => (i === index ? { ...it, dismissed: !it.dismissed } : it))
    patchResearch({ [field]: arr })
  }
  function toggleCompetitorDismiss(group: 'named_by_company' | 'named_by_research', index: number) {
    if (!research) return
    const cm = research.competitive_map
    patchResearch({ competitive_map: { ...cm, [group]: (cm[group] as any[]).map((it, i) => (i === index ? { ...it, dismissed: !it.dismissed } : it)) } })
  }
  function toggleCrossFlagDismiss(index: number) {
    patchCrossFlags(crossDocFlags.map((f, i) => (i === index ? { ...f, dismissed: !f.dismissed } : f)))
  }

  const contradictions = research?.contradictions ?? []
  const findings = research?.findings ?? []
  const gaps = research?.research_gaps ?? []
  const cm = research?.competitive_map ?? { named_by_company: [], named_by_research: [] }
  const activeInconsistencies = contradictions.filter(c => !c.dismissed).length + crossDocFlags.filter(f => !f.dismissed).length
  const activeGaps = gaps.filter(g => !g.dismissed).length
  const activeFindings = findings.filter(f => !f.dismissed).length
  const activeCompetitors = cm.named_by_company.filter(c => !c.dismissed).length + cm.named_by_research.filter(c => !c.dismissed).length
  const internalCounts = `${activeInconsistencies} inconsistenc${activeInconsistencies === 1 ? 'y' : 'ies'} · ${activeGaps} gap${activeGaps === 1 ? '' : 's'}`
  const externalCounts = research ? `${activeFindings} finding${activeFindings === 1 ? '' : 's'}` : 'Not run'

  // Everything currently dismissed, aggregated for the hidden accordion.
  const dismissedItems: Array<{ key: string; kind: string; title: string; detail?: string; restore: () => void }> = []
  contradictions.forEach((c, i) => { if (c.dismissed) dismissedItems.push({ key: `con-${i}`, kind: 'Contradiction', title: c.topic, detail: c.description, restore: () => toggleResearchDismiss('contradictions', i) }) })
  crossDocFlags.forEach((f, i) => { if (f.dismissed) dismissedItems.push({ key: `xdf-${i}`, kind: 'Cross-doc flag', title: f.description, restore: () => toggleCrossFlagDismiss(i) }) })
  gaps.forEach((g, i) => { if (g.dismissed) dismissedItems.push({ key: `gap-${i}`, kind: 'Research gap', title: g.topic, detail: g.rationale, restore: () => toggleResearchDismiss('research_gaps', i) }) })
  findings.forEach((f, i) => { if (f.dismissed) dismissedItems.push({ key: `fnd-${i}`, kind: 'Finding', title: f.topic, detail: f.evidence, restore: () => toggleResearchDismiss('findings', i) }) })
  cm.named_by_company.forEach((c, i) => { if (c.dismissed) dismissedItems.push({ key: `cmc-${i}`, kind: 'Competitor', title: c.name, detail: c.note, restore: () => toggleCompetitorDismiss('named_by_company', i) }) })
  cm.named_by_research.forEach((c, i) => { if (c.dismissed) dismissedItems.push({ key: `cmr-${i}`, kind: 'Competitor', title: c.name, detail: c.rationale, restore: () => toggleCompetitorDismiss('named_by_research', i) }) })

  return (
    <div className="space-y-6 max-w-page">
      {/* The one action this tab is FOR, at the top of it. It's the only run button on
          the tab — the header knows if it's blocked and says why, and it reports the
          last run, so a second button and status line in the section below would only
          disagree with it. */}
      <StageHeader dealId={dealId} stageKey="research" />

      {/* Ask anything, moved here from its own tab so questions sit alongside the evidence. */}
      <QATab dealId={dealId} />

      <Section title="Notes" help="Your own notes and research on this deal, separate from the data-room analysis. Shared with your fund.">
        <NotesPanel dealId={dealId} userId={userId} isAdmin={isAdmin} />
      </Section>

      {!ingestReady && (
        <div className="rounded-card border border-warning/40 bg-warning-subtle/50 dark:bg-warning-subtle/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 inline mr-1" />
          Run the data analysis on Checklist first.
        </div>
      )}

      <Section title="Internal diligence" count={activeInconsistencies + activeGaps}>
        <InternalDiligenceView
          research={research}
          crossDocFlags={crossDocFlags}
          fileNamesById={fileNamesById}
          editable={editable}
          onToggleContradiction={(i) => toggleResearchDismiss('contradictions', i)}
          onToggleCrossFlag={toggleCrossFlagDismiss}
          onToggleGap={(i) => toggleResearchDismiss('research_gaps', i)}
        />
      </Section>

      <Section
        title="External research"
        count={activeFindings}
        help="Verifies findings via web search, surfaces competitors, builds founder dossiers, and lists gaps. Web search runs only when it's enabled in Settings → Memo agent and the research stage uses an Anthropic model. Run it from the header above."
      >
        {research?.research_mode === 'no_web_search' && <p className="text-[11px] text-warning">Last run: web search was off.</p>}
        {research?.research_mode === 'with_web_search' && <p className="text-[11px] text-success">Last run: web search was on.</p>}
        {research && !isResearchInFlight && (
          <ExternalResearchView
            research={research}
            editable={editable}
            onToggleFinding={(i) => toggleResearchDismiss('findings', i)}
            onToggleGap={(i) => toggleResearchDismiss('research_gaps', i)}
          />
        )}
      </Section>

      <Section title="Competitive landscape" count={activeCompetitors}>
        <CompetitiveLandscape competitiveMap={cm} editable={editable} onToggle={toggleCompetitorDismiss} />
      </Section>

      {dismissedItems.length > 0 && (
        <Disclosure title="Dismissed" subtitle={`${dismissedItems.length} hidden`}>
          <div className="divide-y rounded-md border">
            {dismissedItems.map(d => (
              <div key={d.key} className="p-3 text-sm flex items-start gap-2 opacity-70">
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">{d.kind}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium line-through">{d.title}</div>
                  {d.detail && <div className="text-xs text-muted-foreground mt-0.5">{d.detail}</div>}
                </div>
                {editable && (
                  <button onClick={d.restore} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">Restore</button>
                )}
              </div>
            ))}
          </div>
        </Disclosure>
      )}

      <SchemaViewer
        schemaName="research_dossier"
        title="How the agent works"
        subtitle="research"
        guidanceStage="research"
        description="What the external-research stage sources, verifies, and how it rates evidence quality."
        defaultOpen={!research}
      />
    </div>
  )
}

// Small severity badge spanning the contradiction (material/minor), cross-doc
// (high/medium/low), and gap (blocker/important/nice_to_have) scales.
function SevBadge({ level }: { level: string }) {
  const cls = level === 'blocker' || level === 'high' || level === 'material'
    ? 'bg-destructive-subtle text-destructive dark:bg-destructive-subtle/40'
    : level === 'important' || level === 'medium' || level === 'minor'
      ? 'bg-warning-subtle text-warning dark:bg-warning-subtle/40'
      : 'bg-muted text-muted-foreground'
  return <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{level.replace(/_/g, ' ')}</span>
}

// One dismissable diligence row (contradiction, cross-doc flag, or gap).
function DiligenceRow({ badge, title, detail, editable, onDismiss }: { badge?: string; title: string; detail?: string; editable?: boolean; onDismiss: () => void }) {
  return (
    <div className="p-3 text-sm flex items-start gap-2">
      {badge && <SevBadge level={badge} />}
      <div className="flex-1 min-w-0">
        <div>{title}</div>
        {detail && <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>}
      </div>
      {editable && (
        <button onClick={onDismiss} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
      )}
    </div>
  )
}

// Internal diligence — inconsistencies (contradictions + cross-doc flags) and
// the material/important research gaps. Founder dossiers moved to the Founders
// tab; nice-to-have gaps live under External research.
function InternalDiligenceView({ research, crossDocFlags, fileNamesById, editable, onToggleContradiction, onToggleCrossFlag, onToggleGap }: {
  research: ResearchOutput | null
  crossDocFlags: IngestionOutput['cross_doc_flags']
  fileNamesById: Record<string, string>
  editable?: boolean
  onToggleContradiction: (index: number) => void
  onToggleCrossFlag: (index: number) => void
  onToggleGap: (index: number) => void
}) {
  const activeContradictions = (research?.contradictions ?? []).map((c, i) => ({ c, i })).filter(x => !x.c.dismissed)
  const activeFlags = crossDocFlags.map((f, i) => ({ f, i })).filter(x => !x.f.dismissed)
  const internalGaps = (research?.research_gaps ?? []).map((g, i) => ({ g, i })).filter(x => !x.g.dismissed && x.g.criticality !== 'nice_to_have')
  const noInconsistencies = activeContradictions.length === 0 && activeFlags.length === 0
  return (
    <div className="space-y-4">
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Inconsistencies &amp; contradictions</h4>
        {noInconsistencies ? (
          <p className="text-sm text-muted-foreground">No contradictions or cross-document inconsistencies found.</p>
        ) : (
          <div className="divide-y">
            {activeContradictions.map(({ c, i }) => (
              <DiligenceRow key={`c-${i}`} badge={c.severity} title={c.topic} detail={c.description} editable={editable} onDismiss={() => onToggleContradiction(i)} />
            ))}
            {activeFlags.map(({ f, i }) => (
              <DiligenceRow key={`f-${i}`} badge={f.severity ?? 'medium'} title={f.description} detail={`Across: ${f.doc_ids.map(id => fileNamesById[id] ?? id).join(', ')}`} editable={editable} onDismiss={() => onToggleCrossFlag(i)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Research gaps &amp; open questions</h4>
        {internalGaps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No material gaps. Nice-to-have follow-ups, if any, are under External research.</p>
        ) : (
          <div className="divide-y">
            {internalGaps.map(({ g, i }) => (
              <DiligenceRow key={`g-${i}`} badge={g.criticality} title={g.topic} detail={g.rationale} editable={editable} onDismiss={() => onToggleGap(i)} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ExternalResearchView({ research, editable, onToggleFinding, onToggleGap }: {
  research: ResearchOutput
  editable?: boolean
  onToggleFinding: (index: number) => void
  onToggleGap: (index: number) => void
}) {
  const sourcedFindings = research.findings.filter(f => f.sources.some(s => !!s.url)).length
  const searchCount = research.web_search_count ?? null
  const webSources = research.web_sources ?? []
  const activeFindings = research.findings.map((f, i) => ({ f, i })).filter(x => !x.f.dismissed).slice(0, 50)
  const followUpGaps = research.research_gaps.map((g, i) => ({ g, i })).filter(x => !x.g.dismissed && x.g.criticality === 'nice_to_have')
  return (
    <div className="space-y-4">
      {research.research_mode === 'with_web_search' && (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs space-y-1">
          <div className="font-medium">Web search diagnostic</div>
          <div className="text-muted-foreground">
            {searchCount !== null && <>Searches performed: <span className="text-foreground font-medium">{searchCount}</span> · </>}
            URLs cited: <span className="text-foreground font-medium">{webSources.length}</span> ·
            Findings with a URL in sources: <span className="text-foreground font-medium">{sourcedFindings} / {research.findings.length}</span>
          </div>
          {searchCount !== null && searchCount > 0 && webSources.length === 0 && sourcedFindings === 0 && (
            <div className="text-warning text-[11px]">Searches ran but no URLs landed in the output. Re-run, the prompt was tightened to require URL echoing into JSON sources.</div>
          )}
          {webSources.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Sources consulted ({webSources.length})</summary>
              <ul className="mt-1 space-y-0.5 pl-3">
                {webSources.slice(0, 30).map((s, i) => (
                  <li key={i} className="truncate"><a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title || s.url}</a></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {activeFindings.length > 0 && (
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Findings</h4>
          <div className="divide-y">
            {activeFindings.map(({ f, i }) => (
              <div key={f.id} className="p-3 text-sm">
                <div className="flex items-start gap-2">
                  <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${f.verification_status === 'verified' ? 'bg-success-subtle text-success dark:bg-success-subtle/40 dark:text-success' : f.verification_status === 'contradicted' ? 'bg-destructive-subtle text-destructive dark:bg-destructive-subtle/40 dark:text-destructive' : f.verification_status === 'company_stated' ? 'bg-info-subtle text-info dark:bg-info-subtle/40 dark:text-info' : 'bg-warning-subtle text-warning dark:bg-warning-subtle/40 dark:text-warning'}`}>
                    {f.verification_status.replace(/_/g, ' ')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{f.topic}</div>
                    <div className="text-xs mt-0.5">{f.evidence}</div>
                    {f.sources.length > 0 && (
                      <div className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
                        {f.sources.map((s, j) => (
                          <div key={j} className="truncate">
                            <span className="mr-1">[{s.tier.replace('tier_', 'T')}]</span>
                            {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title}</a> : <span>{s.title}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {editable && (
                    <button onClick={() => onToggleFinding(i)} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {followUpGaps.length > 0 && (
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Follow-up research gaps</h4>
          <div className="divide-y">
            {followUpGaps.map(({ g, i }) => (
              <DiligenceRow key={`g-${i}`} badge={g.criticality} title={g.topic} detail={g.rationale} editable={editable} onDismiss={() => onToggleGap(i)} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// Competitive landscape — pulled up to a top-level accordion and rendered as a
// single column (company-named and research-found competitors stacked, each
// tagged by source) instead of the old two-column grid.
function CompetitiveLandscape({ competitiveMap, editable, onToggle }: {
  competitiveMap: ResearchOutput['competitive_map']
  editable?: boolean
  onToggle: (group: 'named_by_company' | 'named_by_research', index: number) => void
}) {
  const byCompany = competitiveMap.named_by_company.map((c, i) => ({ c, i })).filter(x => !x.c.dismissed)
  const byResearch = competitiveMap.named_by_research.map((c, i) => ({ c, i })).filter(x => !x.c.dismissed)
  if (byCompany.length === 0 && byResearch.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No competitors mapped yet. Run external research to populate.</p>
  }
  return (
    <div className="divide-y [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
      {byCompany.map(({ c, i }) => (
        <CompetitorRow key={`co-${i}`} name={c.name} detail={c.note} tag="named by company" editable={editable} onDismiss={() => onToggle('named_by_company', i)} />
      ))}
      {byResearch.map(({ c, i }) => (
        <CompetitorRow key={`re-${i}`} name={c.name} detail={c.rationale} tag="found by research" sources={c.sources} editable={editable} onDismiss={() => onToggle('named_by_research', i)} />
      ))}
    </div>
  )
}

function CompetitorRow({ name, detail, tag, sources, editable, onDismiss }: {
  name: string
  detail?: string
  tag: string
  sources?: Array<{ title: string; url: string | null }>
  editable?: boolean
  onDismiss: () => void
}) {
  return (
    <div className="py-3 text-sm flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{name}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{tag}</span>
        </div>
        {detail && <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>}
        {sources && sources.length > 0 && (
          <div className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
            {sources.map((s, i) => (
              <div key={i} className="truncate">{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title}</a> : <span>{s.title}</span>}</div>
            ))}
          </div>
        )}
      </div>
      {editable && (
        <button onClick={onDismiss} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
      )}
    </div>
  )
}

function QALibraryPanel({ dealId, qaAnswers, onAdded }: { dealId: string; qaAnswers: any[]; onAdded: () => void }) {
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [localAnswers, setLocalAnswers] = useState(qaAnswers)
  useEffect(() => { setLocalAnswers(qaAnswers) }, [qaAnswers])

  async function toggleExclude(entry: any, excluded: boolean) {
    setLocalAnswers(prev => prev.map(e => (e.question_id === entry.question_id ? { ...e, excluded } : e)))
    const res = await fetch(`/api/diligence/${dealId}/agent/qa/entry`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: entry.question_id, excluded }),
    })
    if (!res.ok) {
      // Revert on failure.
      setLocalAnswers(prev => prev.map(e => (e.question_id === entry.question_id ? { ...e, excluded: !excluded } : e)))
    } else {
      onAdded()
    }
  }

  async function removeEntry(entry: any) {
    const ok = await confirm({
      title: 'Delete Q&A entry?',
      description: 'Removes this question and answer from the deal. This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    })
    if (!ok) return
    const prev = localAnswers
    setLocalAnswers(p => p.filter(e => e.question_id !== entry.question_id))
    const res = await fetch(`/api/diligence/${dealId}/agent/qa/entry?question_id=${encodeURIComponent(entry.question_id)}`, { method: 'DELETE' })
    if (!res.ok) setLocalAnswers(prev)
    else onAdded()
  }

  async function add() {
    if (!q.trim() || !a.trim()) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/agent/qa/add-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_text: q.trim(), answer_text: a.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to add Q&A')
      setLocalAnswers(prev => [...prev, { question_id: body.question_id, question_text: q.trim(), answer_text: a.trim(), category: 'partner_question', answered_at: new Date().toISOString() }])
      setQ(''); setA('')
      onAdded()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add Q&A')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="rounded-card border p-3 space-y-2">
        <div className="text-xs font-medium">Add a Q&amp;A entry</div>
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Question (your or the founder's)"
          className="h-8 text-sm"
        />
        <textarea
          value={a}
          onChange={e => setA(e.target.value)}
          rows={3}
          placeholder="Answer / your judgment / conversation notes"
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex justify-end gap-2">
          {err && <span className="text-sm text-destructive mr-auto self-center">{err}</span>}
          <Button size="sm" disabled={busy || !q.trim() || !a.trim()} onClick={add}>
            {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Add Q&amp;A
          </Button>
        </div>
      </div>

      {localAnswers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Q&amp;A entries yet. Add one above, or run the agent Q&amp;A flow once the structured library is back in place.</p>
      ) : (
        <div className="rounded-md border divide-y">
          {localAnswers.map((entry, i) => (
            <div key={entry.question_id ?? i} className={`p-3 text-sm ${entry.excluded ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-2">
                <span className="shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground capitalize">
                  {(entry.category ?? 'q&a').replace(/_/g, ' ')}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={`font-medium ${entry.excluded ? 'line-through' : ''}`}>{entry.question_text ?? entry.question_id}</div>
                  <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{entry.answer_text ?? '—'}</div>
                  {entry.excluded && (
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">Excluded from evaluation</div>
                  )}
                </div>
                {entry.question_id && (
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExclude(entry, !entry.excluded)}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      title={entry.excluded ? 'Include in the memo + scoring' : 'Exclude from the memo + scoring'}
                    >
                      {entry.excluded ? 'Include' : 'Exclude'}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeEntry(entry)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete entry"
                      title="Delete entry"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function JobStatusLine({ job, kind, error }: { job: AgentStatus['latest_job']; kind: string | string[]; error: string | null }) {
  // Tick every second so the elapsed-time label updates live.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return
    const t = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [job?.id, job?.status])

  if (error) {
    return (
      <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
        {error}
      </div>
    )
  }
  const kinds = Array.isArray(kind) ? kind : [kind]
  if (!job || !kinds.includes(job.kind)) return null
  // For multi-kind families (ingest + ingest_synthesis), surface a friendly
  // label rather than the raw enum value in the success line.
  const displayLabel = kinds.length > 1 ? kinds[0] : kind as string

  const pretty = (s: string | null) => s?.replace(/^[a-z]/, c => c.toUpperCase()) ?? ''

  if (job.status === 'pending' || job.status === 'running') {
    const elapsedFrom = job.started_at ?? job.enqueued_at ?? null
    const elapsedLabel = elapsedFrom
      ? `${formatDuration((Date.now() - new Date(elapsedFrom).getTime()) / 1000)} ${job.started_at ? 'running' : 'queued'}`
      : null
    return (
      <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="flex-1">{job.status === 'pending' ? 'Queued, worker picks up within ~1 minute.' : (pretty(job.progress_message) || 'Running…')}</span>
        {elapsedLabel && <span className="text-muted-foreground tabular-nums">{elapsedLabel}</span>}
      </div>
    )
  }
  if (job.status === 'failed') {
    return (
      <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
        <div className="font-medium text-destructive">Job failed.</div>
        {job.error && <div className="text-destructive opacity-80 mt-0.5">{job.error}</div>}
      </div>
    )
  }
  if (job.status === 'success') {
    return (
      <div className="mt-3 text-xs text-muted-foreground">
        <Check className="h-3 w-3 inline mr-1" /> Last {displayLabel} run finished {job.finished_at ? new Date(job.finished_at).toLocaleString() : 'just now'}.
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Memo Agent overview card — mirrors the Analyst card on Company detail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Q&A tab launcher — points at /diligence/[id]/qa
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Q&A tab — free-form chat. Partner asks questions; the agent answers from
// the data room, ingestion findings, research output, the Q&A library, and
// the diligence checklist, citing documents where it relied on them.
// ---------------------------------------------------------------------------
interface QAChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Array<{ document_id: string; summary: string }>
  created_at: string
}

function QATab({ dealId }: { dealId: string }) {
  const confirm = useConfirm()
  const [messages, setMessages] = useState<QAChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/diligence/${dealId}/qa-chat`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Load failed')))
      .then(j => { if (!cancelled) setMessages(j.messages ?? []) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Load failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dealId])

  // Auto-scroll to the newest message — but NOT when the history first loads. Opening
  // the Research tab hydrates this chat, which used to fire this effect (messages 0→N)
  // and scroll the whole page down to the bottom of the conversation, past everything
  // above it. Only a message arriving after the initial load should move the view.
  const hydrated = useRef(false)
  useEffect(() => {
    if (loading) return
    if (!hydrated.current) { hydrated.current = true; return }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length, sending, loading])

  async function send() {
    const q = input.trim()
    if (!q || sending) return
    setSending(true)
    setError(null)
    // Optimistic user message — replaced by the server's persisted copy on response.
    const tempId = `tmp-${Date.now()}`
    setMessages(prev => [...prev, { id: tempId, role: 'user', content: q, citations: [], created_at: new Date().toISOString() }])
    setInput('')
    try {
      const res = await fetch(`/api/diligence/${dealId}/qa-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Chat failed')
      setMessages(prev => {
        const trimmed = prev.filter(m => m.id !== tempId)
        const next = [...trimmed]
        if (body.user_message) next.push(body.user_message as QAChatMessage)
        if (body.assistant_message) next.push(body.assistant_message as QAChatMessage)
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chat failed')
      setMessages(prev => prev.filter(m => m.id !== tempId))
    } finally {
      setSending(false)
    }
  }

  async function clearAll() {
    if (messages.length === 0) return
    const ok = await confirm({
      title: 'Clear conversation?',
      description: 'Deletes every message in this Q&A. The deal\'s evidence (data room, research, checklist) is unaffected.',
      confirmLabel: 'Clear',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/diligence/${dealId}/qa-chat`, { method: 'DELETE' })
    if (res.ok) setMessages([])
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">Ask anything about this deal</h3>
          <p className="text-xs text-muted-foreground">
            The agent answers from the data room, research output, Q&amp;A library, and checklist. Citations link to the document.
          </p>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAll}>Clear</Button>
        )}
      </div>

      <div className="overflow-y-auto rounded-card border bg-card p-4 space-y-4 max-h-[calc(100vh-260px)]">
        {loading ? (
          <div className="text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" /> Loading conversation…</div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-muted-foreground italic">No questions yet. Try: <em className="not-italic">&ldquo;What's the company's ARR growth?&rdquo;</em> or <em className="not-italic">&ldquo;What did research say about the founders?&rdquo;</em></div>
        ) : (
          messages.map(m => <QAChatBubble key={m.id} message={m} />)
        )}
        {sending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</div>}

      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Ask a question. ⏎ to send, ⇧⏎ for newline"
          rows={2}
          className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          disabled={sending}
        />
        <Button onClick={send} disabled={sending || !input.trim()}>
          {sending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
          Send
        </Button>
      </div>
    </div>
  )
}

function QAChatBubble({ message }: { message: QAChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${isUser ? 'bg-primary/10 border border-primary/20' : 'bg-muted/40 border'}`}>
        <div className="whitespace-pre-wrap">{message.content}</div>
        {message.citations && message.citations.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border/60 text-[11px] text-muted-foreground space-y-0.5">
            {message.citations.map((c, i) => (
              <div key={i} className="truncate">
                <span className="text-foreground/70">↳</span> {c.summary || c.document_id}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Founders tab — founder dossiers from research, editable like the Scoring tab.
// ---------------------------------------------------------------------------
function FoundersTab({ dealId }: { dealId: string }) {
  const { status } = useAgentStatus(dealId)
  const [draft, setDraft] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/diligence/${dealId}/drafts`).then(r => r.ok ? r.json() : []).then(rows => {
      setDraft((rows ?? [])[0] ?? null)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [dealId, status?.latest_draft?.id, status?.latest_job?.status])

  const research: ResearchOutput | null = draft?.research_output ?? null
  const draftId: string | undefined = draft?.id
  const editable = draft?.is_draft !== false
  const dossiers: ResearchOutput['founder_dossiers'] = research?.founder_dossiers ?? []

  async function persist(next: ResearchOutput['founder_dossiers']) {
    if (!draftId) return
    setDraft((d: any) => (d ? { ...d, research_output: { ...(d.research_output ?? {}), founder_dossiers: next } } : d))
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ research_output: { founder_dossiers: next } }),
      })
      if (res.ok) {
        const body = await res.json()
        if (body.research_output) setDraft((d: any) => (d ? { ...d, research_output: body.research_output } : d))
      }
    } catch { /* keep optimistic value */ }
  }

  const saveDossier = (index: number, patch: Partial<ResearchOutput['founder_dossiers'][number]>) =>
    persist(dossiers.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  const addFounder = () => persist([...dossiers, { founder_name: 'New founder', role: '', background_summary: '', sources: [], open_questions: [] }])
  const removeFounder = (index: number) => persist(dossiers.filter((_, i) => i !== index))

  if (loading) return <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-1" /> Loading…</div>

  return (
    <div className="space-y-6 max-w-page">
      <Section
        title="Founders"
        count={dossiers.length}
        help="Founder dossiers from external research. Edit any field, add founders, or capture open questions; changes save to the deal."
        action={editable && draftId ? (
          <Button variant="outline" size="sm" onClick={addFounder}><Plus className="h-3.5 w-3.5 mr-1" /> Add founder</Button>
        ) : undefined}
      >
        {!draftId ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No research draft yet. Run external research from the Diligence tab to build founder dossiers.
          </p>
        ) : dossiers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No founder dossiers yet.{editable ? ' Click “Add founder” to create one.' : ''}
          </p>
        ) : (
          <div className="divide-y mt-2">
            {dossiers.map((f, i) => (
              <FounderCard key={i} founder={f} editable={editable} onSave={(patch) => saveDossier(i, patch)} onRemove={() => removeFounder(i)} />
            ))}
          </div>
        )}
      </Section>

      <SchemaViewer
        schemaName="research_dossier"
        title="How the agent works"
        subtitle="founder research"
        guidanceStage="research"
        description="How the agent builds founder dossiers: what it sources, and how it rates evidence quality."
        defaultOpen={dossiers.length === 0}
      />
    </div>
  )
}

function FounderCard({ founder, editable, onSave, onRemove }: {
  founder: ResearchOutput['founder_dossiers'][number]
  editable?: boolean
  onSave: (patch: Partial<ResearchOutput['founder_dossiers'][number]>) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(founder.founder_name)
  const [role, setRole] = useState(founder.role)
  const [bg, setBg] = useState(founder.background_summary)
  const [questions, setQuestions] = useState((founder.open_questions ?? []).join('\n'))
  useEffect(() => {
    if (editing) return
    setName(founder.founder_name); setRole(founder.role); setBg(founder.background_summary)
    setQuestions((founder.open_questions ?? []).join('\n'))
  }, [founder.founder_name, founder.role, founder.background_summary, founder.open_questions, editing])

  function save() {
    onSave({
      founder_name: name.trim() || 'Unnamed',
      role: role.trim(),
      background_summary: bg.trim(),
      open_questions: questions.split('\n').map(q => q.trim()).filter(Boolean),
    })
    setEditing(false)
  }
  function cancel() {
    setName(founder.founder_name); setRole(founder.role); setBg(founder.background_summary)
    setQuestions((founder.open_questions ?? []).join('\n')); setEditing(false)
  }

  if (!editing) {
    return (
      <div className="py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">{founder.founder_name}</div>
            {founder.role && <div className="text-xs text-muted-foreground">{founder.role}</div>}
          </div>
          {editable && <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => setEditing(true)}>Edit</Button>}
        </div>
        {founder.background_summary && <p className="text-sm mt-2 whitespace-pre-wrap">{founder.background_summary}</p>}
        {founder.open_questions.length > 0 && (
          <div className="mt-2">
            <div className="text-xs font-medium text-muted-foreground">Open questions</div>
            <ul className="text-xs list-disc list-inside mt-0.5 space-y-0.5">
              {founder.open_questions.map((q, j) => <li key={j}>{q}</li>)}
            </ul>
          </div>
        )}
        {founder.sources?.length > 0 && (
          <div className="text-[11px] text-muted-foreground mt-2 space-y-0.5">
            {founder.sources.map((s, j) => <div key={j} className="truncate">{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.title}</a> : <span>{s.title}</span>}</div>)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="py-3 space-y-2">
      <div className="flex gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Founder name" className="h-8 text-sm flex-1" />
        <Input value={role} onChange={e => setRole(e.target.value)} placeholder="Role" className="h-8 text-sm w-44" />
      </div>
      <textarea value={bg} onChange={e => setBg(e.target.value)} rows={4} placeholder="Background summary…" className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Open questions (one per line)</div>
        <textarea value={questions} onChange={e => setQuestions(e.target.value)} rows={3} placeholder="One question per line…" className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:text-destructive" onClick={onRemove}>Remove</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="h-7" onClick={cancel}>Cancel</Button>
          <Button size="sm" className="h-7" onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notes panel — partner-authored notes/research, independent of the data-room
// analysis. Lives in the Diligence tab as an accordion below the "ask anything"
// chat (replacing the old standalone Q&A tab).
// ---------------------------------------------------------------------------
interface DealNote { id: string; body: string; authorId: string | null; authorName: string | null; authorEmail: string | null; createdAt: string }

function NotesPanel({ dealId, userId, isAdmin }: { dealId: string; userId: string; isAdmin: boolean }) {
  const [notes, setNotes] = useState<DealNote[]>([])
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState('')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/diligence/${dealId}/notes`).then(r => r.ok ? r.json() : []).then(d => setNotes(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [dealId])

  async function post() {
    if (!content.trim() || posting) return
    setPosting(true)
    try {
      const res = await fetch(`/api/diligence/${dealId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: content.trim() }) })
      if (res.ok) { const row: DealNote = await res.json(); setNotes(prev => [...prev, row]); setContent('') }
    } finally { setPosting(false) }
  }
  async function remove(id: string) {
    const res = await fetch(`/api/diligence/${dealId}/notes/${id}`, { method: 'DELETE' })
    if (res.ok) setNotes(prev => prev.filter(n => n.id !== id))
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post() } }}
          placeholder="Write a note. ⏎ to save, ⇧⏎ for newline"
          rows={2}
          className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button onClick={post} disabled={!content.trim() || posting} className="self-end">
          {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add note'}
        </Button>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" /> Loading notes…</div>
      ) : notes.length === 0 ? (
        <div className="rounded-card border bg-card p-8 text-center text-sm text-muted-foreground">No notes yet.</div>
      ) : (
        <div className="rounded-md border bg-card divide-y">
          {notes.map(n => {
            const canDelete = n.authorId === userId || isAdmin
            const name = n.authorName || n.authorEmail?.split('@')[0] || 'Unknown'
            return (
              <div key={n.id} className="p-3 group">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-medium">{name}</span>
                  <span className="text-xs text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
                  {canDelete && (
                    <button onClick={() => remove(n.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive" aria-label="Delete note">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap">{n.body}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings tab — deal-level config: AI usage (time/tokens/cost) and the
// delete-deal action (moved here from the header).
// ---------------------------------------------------------------------------
interface UsageReport {
  total: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number; calls: number; processing_ms: number; jobs: number; cache_read_tokens: number; cache_creation_tokens: number; cache_saved_usd: number; audio_seconds: number }
  by_feature: Array<{ feature: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>
  by_model: Array<{ model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; audio_seconds: number; cost_usd: number }>
  by_stage: Array<{ kind: string; runs: number; processing_ms: number }>
}

function formatProcessingMs(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
const usageFeatureLabel = (f: string) => f.replace(/^memo_agent_/, '').replace(/_/g, ' ')

function UsageStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border bg-card p-3">
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function SettingsTab({ dealId, dealName, isAdmin }: { dealId: string; dealName: string; isAdmin: boolean }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [days, setDays] = useState<number | 'all'>('all')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setLoading(true)
    const qs = days === 'all' ? '' : `?days=${days}`
    fetch(`/api/diligence/${dealId}/usage${qs}`).then(r => (r.ok ? r.json() : null)).then(setReport).catch(() => setReport(null)).finally(() => setLoading(false))
  }, [dealId, days])

  async function deleteDeal() {
    const ok = await confirm({
      title: 'Delete deal?',
      description: `Permanently deletes "${dealName}" and all of its analysis, documents, drafts, checklist, notes, and Q&A. This cannot be undone.`,
      confirmLabel: 'Delete deal',
      variant: 'destructive',
    })
    if (!ok) return
    setDeleting(true)
    const res = await fetch(`/api/diligence/${dealId}`, { method: 'DELETE' })
    if (res.ok) router.push('/diligence')
    else setDeleting(false)
  }

  const t = report?.total
  const RANGES: Array<{ key: number | 'all'; label: string }> = [
    { key: 'all', label: 'All time' },
    { key: 90, label: '90d' },
    { key: 30, label: '30d' },
    { key: 7, label: '7d' },
  ]

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">AI usage</span>
            <InfoHint text="Processing time, tokens, and estimated cost the memo agent has spent on this deal. Cost is indicative (list pricing)." />
          </span>
          <div className="flex rounded-md border overflow-hidden shrink-0">
            {RANGES.map(r => (
              <button key={String(r.key)} type="button" onClick={() => setDays(r.key)} className={`px-2.5 py-1 text-xs ${days === r.key ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>{r.label}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" /> Loading usage…</div>
        ) : !t || (t.calls === 0 && t.jobs === 0) ? (
          <div className="rounded-card border bg-card p-8 text-center text-sm text-muted-foreground">No AI usage recorded for this deal in this window.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <UsageStat label="Est. cost" value={`$${t.cost_usd.toFixed(2)}`} sub={t.cache_saved_usd > 0 ? `cache saved ~$${t.cache_saved_usd.toFixed(2)}` : undefined} />
              <UsageStat label="Total tokens" value={t.total_tokens.toLocaleString()} sub={`${t.input_tokens.toLocaleString()} in · ${t.output_tokens.toLocaleString()} out`} />
              <UsageStat label="Processing time" value={formatProcessingMs(t.processing_ms)} sub={`${t.jobs} run${t.jobs === 1 ? '' : 's'}`} />
              <UsageStat label="AI calls" value={t.calls.toLocaleString()} sub={t.cache_read_tokens > 0 ? `${t.cache_read_tokens.toLocaleString()} cached` : undefined} />
            </div>

            {report!.by_feature.length > 0 && (
              <div className="rounded-md border bg-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Stage</th>
                      <th className="px-3 py-2 font-medium text-right">Calls</th>
                      <th className="px-3 py-2 font-medium text-right">Tokens</th>
                      <th className="px-3 py-2 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report!.by_feature.map(f => (
                      <tr key={f.feature} className="border-t">
                        <td className="px-3 py-2 capitalize">{usageFeatureLabel(f.feature)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{f.calls}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{(f.input_tokens + f.output_tokens).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">${f.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report!.by_model.length > 0 && (
              <div className="rounded-md border bg-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 font-medium text-right">Calls</th>
                      <th className="px-3 py-2 font-medium text-right">In / out</th>
                      <th className="px-3 py-2 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report!.by_model.map(m => (
                      <tr key={m.model} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">{m.model}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.calls}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{m.audio_seconds > 0 ? `${Math.round(m.audio_seconds / 60)}m audio` : `${m.input_tokens.toLocaleString()} / ${m.output_tokens.toLocaleString()}`}</td>
                        <td className="px-3 py-2 text-right tabular-nums">${m.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {isAdmin && (
        <section>
          <h3 className="text-base font-medium text-destructive">Danger zone</h3>
          <div className="mt-2 rounded-card border border-destructive/40 p-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Delete this deal</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">Permanently removes the deal and all of its analysis: documents, drafts, checklist, notes, and Q&A. This cannot be undone.</p>
            </div>
            <Button variant="outline" size="sm" onClick={deleteDeal} disabled={deleting} className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10">
              {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />} Delete deal
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scoring tab — surfaces rubric scoring derived from the latest memo draft.
// Run-scoring button stays in the Memo tab; this tab is the read-out.
// ---------------------------------------------------------------------------
function ScoringTab({ dealId }: { dealId: string }) {
  const { status } = useAgentStatus(dealId)
  const [draft, setDraft] = useState<any>(null)

  useEffect(() => {
    fetch(`/api/diligence/${dealId}/drafts`).then(r => r.ok ? r.json() : []).then(rows => {
      setDraft((rows ?? [])[0] ?? null)
    }).catch(() => {})
  }, [dealId, status?.latest_draft?.id, status?.latest_job?.status])

  const memoOutput = draft?.memo_draft_output as { scores?: Array<{ dimension_id: string; mode: string; score: number | null; confidence: 'low' | 'medium' | 'high' | null; rationale: string | null }> } | null
  const scores = memoOutput?.scores ?? []

  async function patchScore(dimensionId: string, patch: { score?: number | null; confidence?: string | null; rationale?: string }) {
    if (!draft?.id) return
    // Optimistic local update so the control responds immediately.
    setDraft((d: any) => d?.memo_draft_output ? {
      ...d,
      memo_draft_output: {
        ...d.memo_draft_output,
        scores: (d.memo_draft_output.scores ?? []).map((s: any) =>
          s.dimension_id === dimensionId ? { ...s, ...patch, partner_edited: true } : s),
      },
    } : d)
    try {
      const res = await fetch(`/api/diligence/${dealId}/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score_edits: [{ dimension_id: dimensionId, ...patch }] }),
      })
      if (res.ok) {
        const body = await res.json()
        if (body.memo_draft_output) setDraft((d: any) => d ? { ...d, memo_draft_output: body.memo_draft_output } : d)
      }
    } catch {
      // Keep the optimistic value; a later refetch resyncs.
    }
  }

  return (
    <div className="space-y-6 max-w-page">
      {/* The only run button on this tab. It knows if it's blocked, says why, and
          reports the last run — so the section below carries no second button. */}
      <StageHeader dealId={dealId} stageKey="scoring" />

      <Section
        title="Scoring"
        help="Scores are judged from the evidence — the data room, research and Q&A. A memo isn't required; run scoring as soon as the data room is analyzed. Edit any score, rating, or rationale; changes save to the deal."
      >
        {scores.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Not scored yet. Run scoring from the header above.
          </p>
        ) : (
          <div className="divide-y mt-2 -mx-1">
            {scores.map((s, i) => (
              <ScoreEditRow key={`${s.dimension_id}-${i}`} score={s} onSave={(patch) => patchScore(s.dimension_id, patch)} />
            ))}
          </div>
        )}
      </Section>

      <SchemaViewer
        schemaName="rubric"
        title="How the agent works"
        subtitle="scoring rubric"
        guidanceStage="score"
        description="The dimensions, 1–5 criteria, and confidence signals the agent scores against."
        defaultOpen={scores.length === 0}
      />
    </div>
  )
}

// One editable rubric-score row. A read-only summary by default; clicking Edit
// reveals the score (1–5 / —) and confidence dropdowns side-by-side plus a
// roomy rationale field. Nothing persists until Save is clicked.
function ScoreEditRow({ score, onSave }: {
  score: { dimension_id: string; score: number | null; confidence: 'low' | 'medium' | 'high' | null; rationale: string | null }
  onSave: (patch: { score?: number | null; confidence?: string | null; rationale?: string }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [scoreVal, setScoreVal] = useState<number | null>(score.score)
  const [confidence, setConfidence] = useState<string | null>(score.confidence)
  const [rationale, setRationale] = useState(score.rationale ?? '')

  // Resync from upstream (e.g. a re-run) only while not actively editing, so a
  // background refresh never clobbers in-progress edits.
  useEffect(() => {
    if (editing) return
    setScoreVal(score.score)
    setConfidence(score.confidence)
    setRationale(score.rationale ?? '')
  }, [score.score, score.confidence, score.rationale, editing])

  const label = score.dimension_id.replace(/_/g, ' ')

  function save() {
    onSave({ score: scoreVal, confidence, rationale })
    setEditing(false)
  }
  function cancel() {
    setScoreVal(score.score)
    setConfidence(score.confidence)
    setRationale(score.rationale ?? '')
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className="p-3 text-sm flex items-start gap-3">
        <div className="w-14 shrink-0 text-center text-lg font-semibold tabular-nums">{score.score ?? '—'}</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium capitalize flex items-center gap-2">
            {label}
            {score.confidence && <span className="text-[11px] font-normal text-muted-foreground capitalize">· {score.confidence}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{score.rationale || 'No rationale yet.'}</p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 h-7" onClick={() => setEditing(true)}>Edit</Button>
      </div>
    )
  }

  return (
    <div className="p-3 text-sm">
      <div className="font-medium capitalize mb-2">{label}</div>
      <div className="flex items-center gap-2 mb-2">
        <select
          value={scoreVal ?? ''}
          onChange={e => setScoreVal(e.target.value === '' ? null : Number(e.target.value))}
          className="w-14 shrink-0 h-9 rounded-md border border-input bg-background text-center text-lg font-semibold tabular-nums"
          aria-label={`Score for ${score.dimension_id}`}
        >
          <option value="">—</option>
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select
          value={confidence ?? ''}
          onChange={e => setConfidence(e.target.value === '' ? null : e.target.value)}
          className="shrink-0 h-9 rounded-md border border-input bg-background px-2 text-xs font-medium"
          aria-label={`Confidence for ${score.dimension_id}`}
        >
          <option value="">—</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
      <textarea
        value={rationale}
        onChange={e => setRationale(e.target.value)}
        rows={6}
        placeholder="Rationale…"
        className="w-full min-h-[140px] resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button variant="ghost" size="sm" className="h-7" onClick={cancel}>Cancel</Button>
        <Button size="sm" className="h-7" onClick={save}>Save</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memo tab — fetches the latest draft + attention items and renders the
// existing MemoEditor inline (no click-through to a separate page). When no
// memo exists yet, shows the Run draft action.
// ---------------------------------------------------------------------------

function MemoTab({ dealId, dealName, isAdmin }: { dealId: string; dealName: string; isAdmin: boolean }) {
  const { status } = useAgentStatus(dealId)
  const [draft, setDraft] = useState<any | null>(null)
  const [attention, setAttention] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Re-fetch whenever the draft job lifecycle changes so the inline editor
  // picks up the new memo_draft_output the moment the worker finishes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch(`/api/diligence/${dealId}/drafts`).then(r => r.ok ? r.json() : []),
      fetch(`/api/diligence/${dealId}/attention?status=all`).then(r => r.ok ? r.json() : []),
    ]).then(([drafts, atts]) => {
      if (cancelled) return
      const latest = Array.isArray(drafts) ? drafts[0] ?? null : null
      setDraft(latest)
      setAttention(Array.isArray(atts) ? atts : [])
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [dealId, status?.latest_draft?.id, status?.latest_job?.status, status?.latest_job?.id])

  const job = status?.latest_job
  const isDraftWorkflowJob = job?.kind === 'draft' || job?.kind === 'draft_review' || job?.kind === 'score'
  const isInFlight = job && (job.status === 'pending' || job.status === 'running') && isDraftWorkflowJob
  // Prose, not merely a non-null memo_draft_output — scoring parks its scores in that
  // same column and can run before the memo is ever drafted.
  const memoParagraphs = draft?.memo_draft_output?.paragraphs
  const hasMemo = Array.isArray(memoParagraphs) && memoParagraphs.length > 0

  return (
    <div className="space-y-6 max-w-page">
      {/* The only run button on this tab, and the only place the last run is reported. */}
      <StageHeader dealId={dealId} stageKey="memo" />

      <Section
        title="Memo draft"
        help="Assemble a structured memo from ingestion, research, and Q&A. Run it from the header above. Scoring is separate and does not wait for the memo — see the Scoring tab."
      />

      {status?.memo_stale && !isInFlight && (
        <div className="rounded-card border border-warning/40 bg-warning-subtle dark:bg-warning-subtle/30 p-3 text-sm text-warning">
          <span className="font-medium">Memo is out of date with the data room.</span>{' '}
          {status.documents_added_since_draft && status.documents_added_since_draft > 0
            ? `${status.documents_added_since_draft} document${status.documents_added_since_draft === 1 ? '' : 's'} ${status.documents_added_since_draft === 1 ? 'has' : 'have'} been uploaded since this memo was drafted. `
            : 'Ingestion has changed since this memo was drafted. '}
          Re-run research and draft to fold the latest evidence into the memo.
        </div>
      )}

      {loading ? (
        <div className="rounded-card border bg-card p-12 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 inline animate-spin mr-2" /> Loading memo…
        </div>
      ) : !hasMemo ? (
        <div className="rounded-card border bg-card p-12 text-center text-sm text-muted-foreground">
          No memo yet. Run the draft from the header above once the data room and research are ready.
        </div>
      ) : (
        <MemoEditor
          dealId={dealId}
          dealName={dealName}
          draft={draft}
          initialAttention={attention}
          isAdmin={isAdmin}
          embedded
        />
      )}

      <MemoConfigPanel dealId={dealId} defaultOpen={!hasMemo} />
    </div>
  )
}
