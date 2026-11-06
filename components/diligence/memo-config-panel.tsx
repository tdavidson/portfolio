'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Loader2, Save, Trash2, GripVertical, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/confirm-dialog'
import { SchemaViewer } from '@/components/diligence/schema-viewer'
import { DefaultsEditor } from '@/app/(app)/settings/memo-agent/defaults/editor'

export type MemoComplexity = 'brief' | 'standard' | 'detailed' | 'comprehensive'

export interface SectionConfig {
  id: string
  title: string
  included: boolean
  /** Per-section depth/length. Defaults to 'standard'. */
  complexity?: MemoComplexity
  /** Partner-added section the agent should draft (vs a built-in schema section). */
  custom?: boolean
  /** For custom sections: a short note on what the agent should cover. */
  cover?: string
}

export interface MemoTemplateConfig {
  style_override?: 'pre_seed' | 'seed' | 'series_a' | 'series_b' | 'growth' | null
  analyst_persona?: string
  complexity?: MemoComplexity
  emphasis?: string[]
  /** Ordered, user-managed section list (array order = memo order). Authoritative
   *  for which sections appear and in what order; overrides the schema order. */
  sections?: SectionConfig[]
  // Legacy include/exclude map — still written for back-compat; superseded by `sections`.
  section_overrides?: Record<string, { included?: boolean; target_paragraphs?: number | null }>
}

// Section list mirrors the memo editor — keep these in sync if the schema
// section IDs ever change. Order matches the editor for partner mental model.
const SECTIONS: Array<{ id: string; title: string; defaultParagraphs: number }> = [
  { id: 'executive_summary', title: 'Executive Summary', defaultParagraphs: 2 },
  { id: 'recommendation', title: 'Recommendation', defaultParagraphs: 1 },
  { id: 'company_overview', title: 'Company Overview', defaultParagraphs: 2 },
  { id: 'market', title: 'Market', defaultParagraphs: 3 },
  { id: 'team', title: 'Team', defaultParagraphs: 2 },
  { id: 'product_technology', title: 'Product & Technology', defaultParagraphs: 3 },
  { id: 'traction', title: 'Traction & Evidence', defaultParagraphs: 3 },
  { id: 'business_model', title: 'Business Model & Financials', defaultParagraphs: 3 },
  { id: 'competition_moat', title: 'Competition & Moat', defaultParagraphs: 2 },
  { id: 'deal_terms', title: 'Deal & Terms', defaultParagraphs: 2 },
  { id: 'risks_and_open_questions', title: 'Risks & Open Questions', defaultParagraphs: 2 },
]

const STYLE_OPTIONS: Array<{ value: '' | NonNullable<MemoTemplateConfig['style_override']>; label: string }> = [
  { value: '',          label: 'Deal default (use stage_at_consideration)' },
  { value: 'pre_seed',  label: 'Pre-seed' },
  { value: 'seed',      label: 'Seed' },
  { value: 'series_a',  label: 'Series A' },
  { value: 'series_b',  label: 'Series B' },
  { value: 'growth',    label: 'Growth' },
]

// Curated analyst-voice presets. Stored verbatim as analyst_persona and fed to
// the agent prompt. "Custom…" reveals a free-text field for anything bespoke.
const PERSONA_PRESETS = [
  'Balanced generalist',
  'Skeptical, numbers-first',
  'Conviction-driven (bull case)',
  'Risk-focused (bear case)',
  'Founder-empathetic operator',
  'Market/TAM-first',
]

// Single proxy for completeness, depth, and length — replaces per-section
// paragraph counts. Order runs shortest → most thorough.
const COMPLEXITY_OPTIONS: Array<{ value: MemoComplexity; label: string; hint: string }> = [
  { value: 'brief',         label: 'Brief',         hint: 'Concise, key points only' },
  { value: 'standard',      label: 'Standard',      hint: 'Standard depth (default)' },
  { value: 'detailed',      label: 'Detailed',      hint: 'Thorough, more evidence' },
  { value: 'comprehensive', label: 'Comprehensive', hint: 'Exhaustive, maximum depth' },
]

interface MemoPreset {
  id: string
  name: string
  description: string | null
  partner_memo_guidance: string
  memo_template_config: MemoTemplateConfig
  default_for_stage: string | null
}

type DesignInfo =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'unusable'; reason: string }
  | {
      status: 'ready'
      design: { headings: string[]; fields: Array<{ field: string; label: string }>; title: string | null; warnings: string[] }
      sections?: Array<{ id: string; title: string; custom?: boolean; cover?: string }>
    }

export function MemoConfigPanel({ dealId, defaultOpen }: { dealId: string; defaultOpen?: boolean }) {
  const confirm = useConfirm()
  const [open, setOpen] = useState(!!defaultOpen)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [partnerGuidance, setPartnerGuidance] = useState('')
  const [styleOverride, setStyleOverride] = useState<'' | NonNullable<MemoTemplateConfig['style_override']>>('')
  const [persona, setPersona] = useState('')
  const [personaCustom, setPersonaCustom] = useState(false)
  const [sections, setSections] = useState<SectionConfig[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  // Presets — fund-level saved configs.
  const [presets, setPresets] = useState<MemoPreset[]>([])
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDefaultFor, setPresetDefaultFor] = useState<'' | NonNullable<MemoTemplateConfig['style_override']>>('')

  // First-page template — fund-level: which example memo's first page the agent
  // models new memos on. Moved here from the (removed) Diligence Settings page.
  const [anchors, setAnchors] = useState<Array<{ id: string; label: string; file_format?: string | null }>>([])
  const [firstPageAnchorId, setFirstPageAnchorId] = useState<string>('')
  // Design template — fund-level: the sample memo (a Word file) every export is written into, so the
  // memo looks like the fund's own: fonts, styles, header, footer, first page and section headings.
  const [designAnchorId, setDesignAnchorId] = useState<string>('')
  const [design, setDesign] = useState<DesignInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/diligence/${dealId}/memo-config`).then(r => r.ok ? r.json() : Promise.reject(new Error('config'))),
      fetch('/api/diligence/memo-presets').then(r => r.ok ? r.json() : Promise.reject(new Error('presets'))),
      fetch('/api/diligence/prompts').then(r => r.ok ? r.json() : { anchors: [], first_page_anchor_id: null }),
    ])
      .then(([cfgBody, presetBody, promptsBody]) => {
        if (cancelled) return
        applyConfigToForm(cfgBody.partner_memo_guidance ?? '', (cfgBody.memo_template_config ?? {}) as MemoTemplateConfig)
        setPresets((presetBody.presets ?? []) as MemoPreset[])
        setAnchors(Array.isArray(promptsBody.anchors) ? promptsBody.anchors : [])
        setFirstPageAnchorId(promptsBody.first_page_anchor_id ?? '')
        setDesignAnchorId(promptsBody.design_anchor_id ?? '')
        setLoaded(true)
      })
      .catch(() => { setError('Failed to load memo settings.'); setLoaded(true) })
    return () => { cancelled = true }
  }, [dealId])

  useEffect(() => {
    if (!designAnchorId) { setDesign(null); return }
    let cancelled = false
    setDesign({ status: 'loading' })
    fetch(`/api/diligence/memo-design?anchor=${encodeURIComponent(designAnchorId)}`)
      .then(r => r.ok ? r.json() : { status: 'unusable', reason: 'Could not read the design template.' })
      .then(body => { if (!cancelled) setDesign(body as DesignInfo) })
      .catch(() => { if (!cancelled) setDesign({ status: 'unusable', reason: 'Could not read the design template.' }) })
    return () => { cancelled = true }
  }, [designAnchorId])

  function useDesignSections() {
    if (design?.status !== 'ready' || !design.sections?.length) return
    const prior = new Map(sections.map(s => [s.id, s]))
    setSections(design.sections.map(s => ({
      id: s.id,
      title: s.title,
      included: true,
      complexity: prior.get(s.id)?.complexity ?? 'standard',
      custom: !!s.custom,
      cover: s.custom ? (prior.get(s.id)?.cover || s.cover || '') : '',
    })))
  }

  function applyConfigToForm(guidance: string, cfg: MemoTemplateConfig) {
    // Legacy "points to emphasize" are now folded into the single guidance field.
    const emph = (Array.isArray(cfg.emphasis) ? cfg.emphasis : []).filter(Boolean)
    setPartnerGuidance(emph.length ? [guidance.trim(), ...emph.map(e => `Emphasize: ${e}`)].filter(Boolean).join('\n') : guidance)
    setStyleOverride((cfg.style_override ?? '') as any)
    const p = cfg.analyst_persona ?? ''
    setPersona(p)
    setPersonaCustom(!!p && !PERSONA_PRESETS.includes(p))
    // Legacy configs carry a single memo-wide complexity; seed each section from
    // it (then 'standard') so older deals/presets migrate cleanly to per-section.
    const defaultComplexity: MemoComplexity = cfg.complexity ?? 'standard'
    if (Array.isArray(cfg.sections) && cfg.sections.length > 0) {
      setSections(cfg.sections.map(s => ({
        id: s.id,
        title: s.title ?? s.id,
        included: s.included !== false,
        complexity: s.complexity ?? defaultComplexity,
        custom: !!s.custom,
        cover: s.cover ?? '',
      })))
    } else {
      // Back-compat: seed the default section list, honoring legacy include flags.
      setSections(SECTIONS.map(s => ({
        id: s.id,
        title: s.title,
        included: cfg.section_overrides?.[s.id]?.included !== false,
        complexity: defaultComplexity,
      })))
    }
  }

  function currentConfig(): MemoTemplateConfig {
    return {
      style_override: (styleOverride || null) as MemoTemplateConfig['style_override'],
      analyst_persona: persona,
      emphasis: [],
      sections: sections.map(s => ({
        id: s.id,
        title: s.title,
        included: s.included,
        complexity: s.complexity ?? 'standard',
        ...(s.custom ? { custom: true, cover: (s.cover ?? '').trim() } : {}),
      })),
      // Back-compat for any consumer still reading section_overrides.
      section_overrides: Object.fromEntries(sections.map(s => [s.id, { included: s.included }])),
    }
  }

  function loadPreset(presetId: string) {
    const p = presets.find(p => p.id === presetId)
    if (!p) return
    applyConfigToForm(p.partner_memo_guidance ?? '', p.memo_template_config ?? {})
  }

  async function savePreset() {
    const name = presetName.trim()
    if (!name) return
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/diligence/memo-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          partner_memo_guidance: partnerGuidance,
          memo_template_config: currentConfig(),
          default_for_stage: presetDefaultFor || null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Save failed')
      // Refresh presets list — easier than splice-merging the swap-cleanup the
      // server may have done if default_for_stage took an existing slot.
      const refreshed = await fetch('/api/diligence/memo-presets').then(r => r.ok ? r.json() : { presets: [] })
      setPresets((refreshed.presets ?? []) as MemoPreset[])
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDefaultFor('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function deletePreset(presetId: string) {
    const p = presets.find(p => p.id === presetId)
    const ok = await confirm({
      title: 'Delete preset?',
      description: p ? `Removes "${p.name}" from this fund. Deals already using it keep their config.` : 'Removes this preset.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/diligence/memo-presets/${presetId}`, { method: 'DELETE' })
    if (res.ok) setPresets(prev => prev.filter(p => p.id !== presetId))
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const config = currentConfig()
      const [res] = await Promise.all([
        fetch(`/api/diligence/${dealId}/memo-config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partner_memo_guidance: partnerGuidance,
            memo_template_config: config,
          }),
        }),
        // First-page template is fund-level (applies to all memos).
        fetch('/api/diligence/prompts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ first_page_anchor_id: firstPageAnchorId || null, design_anchor_id: designAnchorId || null }),
        }),
      ])
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Save failed')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ---- helpers ----
  function patchSection(id: string, patch: Partial<SectionConfig>) {
    setSections(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }
  function removeSection(id: string) {
    setSections(prev => prev.filter(s => s.id !== id))
  }
  function addSection() {
    const id = `custom_${Math.random().toString(36).slice(2, 9)}`
    setSections(prev => [...prev, { id, title: 'New section', included: true, complexity: 'standard', custom: true, cover: '' }])
  }
  function dropSectionOnto(targetId: string) {
    setSections(prev => {
      if (!dragId || dragId === targetId) return prev
      const from = prev.findIndex(s => s.id === dragId)
      const to = prev.findIndex(s => s.id === targetId)
      if (from === -1 || to === -1) return prev
      const next = prev.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setDragId(null)
    setOverId(null)
  }

  const includedCount = sections.filter(s => s.included).length
  const summary = !loaded
    ? 'Loading…'
    : [
        styleOverride && STYLE_OPTIONS.find(s => s.value === styleOverride)?.label,
        persona ? `persona: ${persona.length > 30 ? persona.slice(0, 30) + '…' : persona}` : null,
        `${includedCount}/${sections.length} sections`,
      ].filter(Boolean).join(' · ')

  return (
    <div className="rounded-md border bg-card">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="flex items-center gap-2">
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className="font-medium text-sm">How the agent works</span>
        </span>
        <span className="text-xs text-muted-foreground truncate ml-4">{summary}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}

          {/* Preset toolbar, load a saved fund preset into the form, or save
              the current form state as a new preset. The form below is still
              the source of truth that gets PATCHed to the deal on Save. */}
          <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium">Preset:</label>
              <select
                onChange={e => { if (e.target.value) loadPreset(e.target.value) }}
                defaultValue=""
                className="h-7 rounded border border-input bg-background px-2 text-xs min-w-[200px]"
              >
                <option value="">Load a saved preset…</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.default_for_stage ? ` (default for ${p.default_for_stage.replace('_', ' ')})` : ''}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={() => setSavePresetOpen(o => !o)}>
                Save as preset…
              </Button>
              {presets.length > 0 && (
                <span className="text-[11px] text-muted-foreground ml-auto">{presets.length} preset{presets.length === 1 ? '' : 's'} on file</span>
              )}
            </div>
            {savePresetOpen && (
              <div className="space-y-2 pt-2 border-t">
                <div className="flex flex-wrap gap-2 items-center">
                  <Input
                    value={presetName}
                    onChange={e => setPresetName(e.target.value)}
                    placeholder="Preset name (e.g. 'Our seed memo style')"
                    className="h-8 text-sm flex-1 min-w-[200px]"
                  />
                  <select
                    value={presetDefaultFor}
                    onChange={e => setPresetDefaultFor(e.target.value as any)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    title="Auto-apply to new deals at this stage"
                  >
                    <option value="">Not a default</option>
                    <option value="pre_seed">Default for pre-seed</option>
                    <option value="seed">Default for seed</option>
                    <option value="series_a">Default for Series A</option>
                    <option value="series_b">Default for Series B</option>
                    <option value="growth">Default for growth</option>
                  </select>
                  <Button size="sm" onClick={savePreset} disabled={saving || !presetName.trim()}>
                    {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Save preset
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setSavePresetOpen(false); setPresetName(''); setPresetDefaultFor('') }}>Cancel</Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Saves the current form state (style, persona, emphasis, sections, guidance) as a reusable preset. Marking it the default for a stage auto-applies it to new deals at that stage.
                </p>
              </div>
            )}
            {presets.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Manage presets</summary>
                <div className="mt-2 space-y-1 pl-2">
                  {presets.map(p => (
                    <div key={p.id} className="flex items-center gap-2">
                      <span className="font-medium truncate flex-1">{p.name}</span>
                      {p.default_for_stage && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">default · {p.default_for_stage.replace('_', ' ')}</span>}
                      <button onClick={() => deletePreset(p.id)} className="text-muted-foreground hover:text-destructive" aria-label="Delete preset" title="Delete preset">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium mb-1">Style</label>
              <select
                value={styleOverride}
                onChange={e => setStyleOverride(e.target.value as any)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {STYLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">Calibrates expectations and tone. Overrides the deal&apos;s stage when set.</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Analyst persona</label>
              <select
                value={personaCustom ? '__custom__' : (persona && PERSONA_PRESETS.includes(persona) ? persona : (persona ? '__custom__' : ''))}
                onChange={e => {
                  const v = e.target.value
                  if (v === '') { setPersonaCustom(false); setPersona('') }
                  else if (v === '__custom__') { setPersonaCustom(true) }
                  else { setPersonaCustom(false); setPersona(v) }
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">No persona (default voice)</option>
                {PERSONA_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                <option value="__custom__">Custom…</option>
              </select>
              {personaCustom && (
                <Input
                  value={persona}
                  onChange={e => setPersona(e.target.value)}
                  placeholder="e.g. skeptical numbers-first analyst"
                  className="h-8 text-sm mt-1.5"
                  autoFocus
                />
              )}
              <p className="text-[10px] text-muted-foreground mt-1">The voice the agent writes in. Pick a preset, or choose Custom to describe your own.</p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Memo first-page template</label>
            {anchors.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">No example memos uploaded yet. Add them in Settings → Memo agent → Style anchors.</p>
            ) : (
              <select
                value={firstPageAnchorId}
                onChange={e => setFirstPageAnchorId(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— no first-page exemplar —</option>
                {anchors.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            )}
            <p className="text-[10px] text-muted-foreground mt-1">An example memo whose first page (title block, framing, opening) the agent models new memos on. Fund-wide.</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Memo design template</label>
            {anchors.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">No example memos uploaded yet. Add them in Settings → Memo agent → Style anchors.</p>
            ) : (
              <select
                value={designAnchorId}
                onChange={e => setDesignAnchorId(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— standard layout —</option>
                {anchors.map(a => (
                  <option key={a.id} value={a.id}>{a.label}{a.file_format && a.file_format.toLowerCase() !== 'docx' ? ` (${a.file_format.toUpperCase()}: needs the Word file)` : ''}</option>
                ))}
              </select>
            )}
            <p className="text-[10px] text-muted-foreground mt-1">
              A sample memo in Word whose design every export copies: its fonts, heading and body styles, margins, header, footer,
              logo and first page. Fund-wide.
            </p>
            {design?.status === 'loading' && <p className="text-[10px] text-muted-foreground mt-1">Reading the template…</p>}
            {design?.status === 'unusable' && <p className="text-[10px] text-destructive mt-1">{design.reason}</p>}
            {design?.status === 'ready' && (
              <div className="mt-1.5 rounded-md border border-border bg-muted/40 p-2 text-[11px] space-y-1">
                <div>
                  <span className="font-medium">Sections:</span>{' '}
                  {design.design.headings.length ? design.design.headings.join(' · ') : 'none found'}
                </div>
                <div>
                  <span className="font-medium">First page fills:</span>{' '}
                  {design.design.fields.length ? design.design.fields.map(f => f.label).join(', ') : 'the title only'}
                </div>
                {design.design.warnings.map(w => <div key={w} className="text-warning">{w}</div>)}
                {design.sections && design.sections.length > 0 && (
                  <Button type="button" variant="outline" size="sm" className="h-6 text-[11px] mt-1" onClick={useDesignSections}>
                    Use the template&apos;s sections for this memo
                  </Button>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Guidance for this memo</label>
            <textarea
              value={partnerGuidance}
              onChange={e => setPartnerGuidance(e.target.value)}
              rows={4}
              placeholder="Deal-specific direction and points to emphasize, e.g. &quot;lead with the wedge; tilt toward technical defensibility; flag the CAC trajectory.&quot;"
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground mt-1">Adds to the fund&apos;s draft-stage guidance from Settings. Covers both what to emphasize and any deal-specific direction.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium">Sections</label>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={addSection}>
                <Plus className="h-3 w-3 mr-1" /> Add section
              </Button>
            </div>
            <div className="rounded-md border divide-y">
              {sections.map(s => (
                <div
                  key={s.id}
                  onDragOver={dragId && dragId !== s.id ? (e) => { e.preventDefault(); if (overId !== s.id) setOverId(s.id) } : undefined}
                  onDrop={dragId ? (e) => { e.preventDefault(); dropSectionOnto(s.id) } : undefined}
                  className={`px-2 py-2 ${dragId && dragId !== s.id && overId === s.id ? 'border-t-2 border-primary' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      draggable
                      onDragStart={() => setDragId(s.id)}
                      onDragEnd={() => { setDragId(null); setOverId(null) }}
                      className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground shrink-0"
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </span>
                    <input
                      type="checkbox"
                      checked={s.included}
                      onChange={e => patchSection(s.id, { included: e.target.checked })}
                      className="h-3.5 w-3.5 shrink-0"
                      title={s.included ? 'Included' : 'Omitted'}
                    />
                    <Input
                      value={s.title}
                      onChange={e => patchSection(s.id, { title: e.target.value })}
                      className={`h-7 text-sm flex-1 ${s.included ? '' : 'opacity-50'}`}
                    />
                    <select
                      value={s.complexity ?? 'standard'}
                      onChange={e => patchSection(s.id, { complexity: e.target.value as MemoComplexity })}
                      disabled={!s.included}
                      title="Depth & length for this section"
                      aria-label={`Depth for ${s.title}`}
                      className={`h-7 rounded-md border border-input bg-background px-1.5 text-xs shrink-0 ${s.included ? '' : 'opacity-50'}`}
                    >
                      {COMPLEXITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {s.custom && <span className="text-[9px] uppercase tracking-wide text-muted-foreground shrink-0">custom</span>}
                    {s.custom && (
                      <button onClick={() => removeSection(s.id)} className="text-muted-foreground hover:text-destructive shrink-0" aria-label="Remove section" title="Remove section">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {s.custom && s.included && (
                    <Input
                      value={s.cover ?? ''}
                      onChange={e => patchSection(s.id, { cover: e.target.value })}
                      placeholder="What should the agent cover in this section?"
                      className="h-7 text-xs mt-1.5 ml-7"
                    />
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Drag to reorder. Unchecked sections are omitted. Each section&apos;s depth dropdown sets its length and level of detail independently. Add custom sections the agent drafts from your &ldquo;what to cover&rdquo; note. Save as a preset to reuse this as a default.</p>
          </div>

          <SchemaViewer
            schemaName="memo_output"
            title="Base memo schema"
            guidanceStage="draft"
            description="The section structure, guidance, and sourcing rules the draft is built from. The settings above layer on top of this."
          />

          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : saved ? <Save className="h-3.5 w-3.5 mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              {saved ? 'Saved' : 'Save settings'}
            </Button>
          </div>

          {/* Memo export formatting (font + size) — fund-level, editable here. */}
          <DefaultsEditor embedded section="export" />
        </div>
      )}
    </div>
  )
}
