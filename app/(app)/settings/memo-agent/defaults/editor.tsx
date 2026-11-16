'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Check, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { recommendedModel } from '@/lib/ai/recommended'

const STAGES = ['ingest', 'ingest_synthesis', 'checklist_assessment', 'research', 'qa', 'draft', 'draft_review', 'score'] as const
type Stage = typeof STAGES[number]

const FEATURES = ['deal_classify', 'deal_analysis', 'portfolio'] as const
type Feature = typeof FEATURES[number]

const FEATURE_LABEL: Record<Feature, string> = {
  deal_classify: 'Deals: inbound email classifier',
  deal_analysis: 'Deals: deal screening / analysis',
  portfolio: 'Inbound analysis / portfolio tracking',
}

const FEATURE_HINT: Record<Feature, string> = {
  deal_classify: 'Routes every inbound email to reporting, interactions, deals, or other.',
  deal_analysis: 'Screens each pitch: thesis fit, field extraction, and duplicate detection.',
  portfolio: 'Extracts company updates and metrics from inbound reporting emails.',
}

const STAGE_LABEL: Record<Stage, string> = {
  ingest: 'Stage 1a, Ingest (per-doc)',
  ingest_synthesis: 'Stage 1b, Ingest synthesis',
  checklist_assessment: 'Stage 1c, Checklist assessment',
  research: 'Stage 2, Research',
  qa: 'Stage 3, Q&A',
  draft: 'Stage 4, Draft (outline + fills)',
  draft_review: 'Stage 4c, Draft review',
  score: 'Stage 5, Score',
}

// Speed-vs-depth tradeoff hint per stage. Stages with heavy structured I/O
// and modest reasoning are good Haiku candidates; stages that produce prose
// or do deep multi-source reasoning are better on Sonnet/Opus.
const STAGE_HINT: Record<Stage, string> = {
  ingest:           'Structured extraction from each document in the data room.',
  ingest_synthesis: 'Cross-document gap analysis and conflict detection over the per-doc summaries.',
  checklist_assessment: 'Matches data-room findings to each checklist item.',
  research:         'Verifies findings via web search, maps competitors, and builds founder dossiers.',
  qa:               'Interactive partner Q&A about the deal.',
  draft:            'Writes the memo — outline, then the section prose.',
  draft_review:     'Edits the first draft: the quality pass over the whole memo.',
  score:            'Scores the deal against the rubric, with rationale.',
}

const PROVIDER_LABEL: Record<string, string> = {
  '': 'Use fund default',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

const PROVIDER_MODELS_ENDPOINT: Record<string, string> = {
  anthropic: '/api/claude-models',
  openai: '/api/openai-models',
}

const PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const

interface Defaults {
  per_deal_token_cap: number | null
  monthly_token_cap: number | null
  stage_models: Record<string, { provider: string; model?: string } | null>
  feature_models: Record<string, { provider: string; model?: string } | null>
  web_search_enabled: boolean
  default_ai_provider: string
  default_models: Record<string, string>
  export_font_family: string
  export_font_size: number
  monthly_used: number
  month_window: { from: string; to: string }
}

// Common document fonts offered in the export font picker. The export still
// accepts any value the user types, but these cover the usual choices.
const EXPORT_FONT_OPTIONS = [
  'DM Sans', 'Arial', 'Calibri', 'Georgia', 'Helvetica',
  'Inter', 'Lato', 'Times New Roman', 'Verdana',
]

interface AIModel { id: string; name: string }

// One provider+model row, prefilled with the recommended choice for the fund's
// provider. The model dropdown defaults to the recommended model for the tier
// (Claude/OpenAI have fast/strong models; OpenRouter uses the fund default).
function ModelRow({ label, hint, recommendedKey, current, onChange, defaultProvider, defaultModels, modelsByProvider, loadingProviders }: {
  label: string
  hint: string
  recommendedKey: string
  current: { provider: string; model?: string } | null | undefined
  onChange: (provider: string, model?: string) => void
  defaultProvider: string
  defaultModels: Record<string, string>
  modelsByProvider: Record<string, AIModel[]>
  loadingProviders: Set<string>
}) {
  const effProvider = current?.provider || defaultProvider
  const effModel = current?.model || recommendedModel(recommendedKey, effProvider, defaultModels[effProvider] ?? '')
  const models = modelsByProvider[effProvider]
  const loading = loadingProviders.has(effProvider)
  return (
    <div className="rounded-card border bg-card p-3">
      <div className="mb-2">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-[11px] text-muted-foreground mt-0.5 max-w-2xl">{hint}</p>
      </div>
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <select
          value={effProvider}
          onChange={e => onChange(e.target.value, undefined)}
          className="h-9 px-2 rounded-md border border-input bg-background text-sm"
        >
          {PROVIDERS.map(v => <option key={v} value={v}>{PROVIDER_LABEL[v]}</option>)}
        </select>
        {models && models.length > 0 ? (
          <select
            value={effModel}
            onChange={e => onChange(effProvider, e.target.value || undefined)}
            className="h-9 px-2 rounded-md border border-input bg-background text-sm font-mono"
          >
            {!models.some(m => m.id === effModel) && <option value={effModel}>{effModel}</option>}
            {models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        ) : (
          <Input
            value={effModel}
            onChange={e => onChange(effProvider, e.target.value || undefined)}
            placeholder={loading ? 'Loading models…' : 'Model id'}
            className="font-mono text-xs"
            disabled={loading}
          />
        )}
      </div>
    </div>
  )
}

type EditorSection = 'caps' | 'stages' | 'features' | 'export'

export function DefaultsEditor({ embedded, section }: { embedded?: boolean; section?: EditorSection } = {}) {
  // When a section is set, render + save only that slice (so the editor can be
  // split across several settings locations without instances clobbering each
  // other's fields on save).
  const show = (s: EditorSection) => !section || section === s
  const [data, setData] = useState<Defaults | null>(null)
  const [perDeal, setPerDeal] = useState<string>('')
  const [monthly, setMonthly] = useState<string>('')
  const [stageModels, setStageModels] = useState<Record<string, { provider: string; model?: string } | null>>({})
  const [featureModels, setFeatureModels] = useState<Record<string, { provider: string; model?: string } | null>>({})
  const [webSearch, setWebSearch] = useState(false)
  const [exportFont, setExportFont] = useState('DM Sans')
  const [exportFontSize, setExportFontSize] = useState('11')
  const [dgTesting, setDgTesting] = useState(false)
  const [dgResult, setDgResult] = useState<{
    deepgram: { ok: boolean; detail: string }
    webhook_url_resolvable: boolean
    ready: boolean
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Model dropdowns load from the active provider for each stage. Cached
  // per provider since multiple stages may pick the same one.
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AIModel[]>>({})
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set())

  async function load() {
    const res = await fetch('/api/firm/memo-agent-defaults')
    if (res.ok) {
      const body: Defaults = await res.json()
      setData(body)
      setPerDeal(body.per_deal_token_cap !== null ? String(body.per_deal_token_cap) : '')
      setMonthly(body.monthly_token_cap !== null ? String(body.monthly_token_cap) : '')
      setStageModels(body.stage_models ?? {})
      setFeatureModels(body.feature_models ?? {})
      setWebSearch(!!body.web_search_enabled)
      setExportFont(body.export_font_family || 'DM Sans')
      setExportFontSize(String(body.export_font_size || 11))
    }
  }

  async function loadModelsFor(provider: string) {
    if (!provider || modelsByProvider[provider] || loadingProviders.has(provider)) return
    const endpoint = PROVIDER_MODELS_ENDPOINT[provider]
    if (!endpoint) return
    setLoadingProviders(prev => new Set(prev).add(provider))
    try {
      const res = await fetch(endpoint)
      const body = await res.json().catch(() => ({}))
      const models: AIModel[] = Array.isArray(body?.models) ? body.models : []
      setModelsByProvider(prev => ({ ...prev, [provider]: models }))
    } catch {
      // Leave models empty so the UI falls back to freeform input.
      setModelsByProvider(prev => ({ ...prev, [provider]: [] }))
    } finally {
      setLoadingProviders(prev => { const next = new Set(prev); next.delete(provider); return next })
    }
  }

  useEffect(() => { load() }, [])

  // Pre-load models for the fund default provider (used by every prefilled row)
  // plus any providers explicitly overridden on a stage/feature.
  useEffect(() => {
    const providers = new Set<string>()
    if (data?.default_ai_provider) providers.add(data.default_ai_provider)
    for (const v of Object.values(stageModels)) if (v?.provider) providers.add(v.provider)
    for (const v of Object.values(featureModels)) if (v?.provider) providers.add(v.provider)
    providers.forEach(loadModelsFor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageModels, featureModels, data])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {}
      if (show('caps')) {
        body.per_deal_token_cap = perDeal === '' ? null : Number(perDeal)
        body.monthly_token_cap = monthly === '' ? null : Number(monthly)
        body.web_search_enabled = webSearch
      }
      if (show('stages')) body.stage_models = stageModels
      if (show('features')) body.feature_models = featureModels
      if (show('export')) {
        body.export_font_family = exportFont
        body.export_font_size = exportFontSize === '' ? 11 : Number(exportFontSize)
      }
      const res = await fetch('/api/firm/memo-agent-defaults', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? 'Save failed')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function setStage(stage: Stage, provider: string, model?: string) {
    setStageModels(prev => ({
      ...prev,
      [stage]: provider ? { provider, ...(model ? { model } : {}) } : null,
    }))
    if (provider) loadModelsFor(provider)
  }

  function setFeature(feature: Feature, provider: string, model?: string) {
    setFeatureModels(prev => ({
      ...prev,
      [feature]: provider ? { provider, ...(model ? { model } : {}) } : null,
    }))
    if (provider) loadModelsFor(provider)
  }

  async function testTranscription() {
    setDgTesting(true)
    setDgResult(null)
    try {
      const res = await fetch('/api/transcription/test')
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? 'Test failed')
      setDgResult(body)
    } catch (err) {
      setDgResult({
        deepgram: { ok: false, detail: err instanceof Error ? err.message : 'Test failed' },
        webhook_url_resolvable: false,
        ready: false,
      })
    } finally {
      setDgTesting(false)
    }
  }

  if (!data) return <div className="p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…</div>

  const monthName = new Date(data.month_window.from).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const monthlyPct = data.monthly_token_cap ? Math.min(100, (data.monthly_used / data.monthly_token_cap) * 100) : 0

  return (
    <div className={embedded ? '' : 'p-4 md:py-8 md:pl-8 md:pr-4 max-w-4xl'}>
      {!embedded && (
        <>
          <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to settings
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">Diligence defaults</h1>
          <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
            Cost guardrails and per-stage AI provider overrides. Caps are checked before each agent
            stage runs; if the estimate would exceed a cap, the run is blocked.
          </p>
        </>
      )}

      {error && <div className="rounded-card border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive mb-4">{error}</div>}

      <div className="space-y-4">
        {show('caps') && (
          <div className="space-y-3 text-sm">
            <div className="text-sm font-medium">Token caps</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Per-deal cap</label>
                <Input
                  type="number"
                  value={perDeal}
                  onChange={e => setPerDeal(e.target.value)}
                  placeholder="(unlimited)"
                  className="font-mono"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Maximum total tokens (input + output) across all stages for a single deal. Blank = no cap.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Monthly cap (fund-wide)</label>
                <Input
                  type="number"
                  value={monthly}
                  onChange={e => setMonthly(e.target.value)}
                  placeholder="(unlimited)"
                  className="font-mono"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Tracks the calendar month. Resets at month rollover.
                </p>
              </div>
            </div>

            <div className="rounded-card border bg-muted/20 p-3">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium">{monthName}, usage</span>
                <span className="font-mono text-muted-foreground">
                  {data.monthly_used.toLocaleString()}{data.monthly_token_cap ? ` / ${data.monthly_token_cap.toLocaleString()}` : ''} tokens
                </span>
              </div>
              {data.monthly_token_cap && (
                <div className="h-1.5 bg-background rounded overflow-hidden">
                  <div
                    className={`h-full ${monthlyPct > 90 ? 'bg-destructive' : monthlyPct > 70 ? 'bg-warning' : 'bg-primary'}`}
                    style={{ width: `${monthlyPct}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {show('stages') && (
          <div className="space-y-3">
            {STAGES.map(stage => (
              <ModelRow
                key={stage}
                label={STAGE_LABEL[stage]}
                hint={STAGE_HINT[stage]}
                recommendedKey={stage}
                current={stageModels[stage]}
                onChange={(provider, model) => setStage(stage, provider, model)}
                defaultProvider={data.default_ai_provider}
                defaultModels={data.default_models}
                modelsByProvider={modelsByProvider}
                loadingProviders={loadingProviders}
              />
            ))}
          </div>
        )}

        {show('features') && (
          <div className="space-y-3">
            {FEATURES.map(feature => (
              <ModelRow
                key={feature}
                label={FEATURE_LABEL[feature]}
                hint={FEATURE_HINT[feature]}
                recommendedKey={feature}
                current={featureModels[feature]}
                onChange={(provider, model) => setFeature(feature, provider, model)}
                defaultProvider={data.default_ai_provider}
                defaultModels={data.default_models}
                modelsByProvider={modelsByProvider}
                loadingProviders={loadingProviders}
              />
            ))}
          </div>
        )}

        {show('caps') && (
          <div className="space-y-2 text-sm">
            <div className="text-sm font-medium">Research web search</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={webSearch}
                onChange={e => setWebSearch(e.target.checked)}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <div className="font-medium">Enable Anthropic web search during research</div>
                <p className="text-xs text-muted-foreground max-w-2xl">
                  When on, Stage 2 attaches Anthropic&apos;s <span className="font-mono">web_search</span> tool so the
                  agent can verify claims against external sources and cite URLs in findings. Only active when the
                  research stage is running on Anthropic. <span className="font-medium text-foreground">Adds external billing
                  </span> at Anthropic&apos;s rate (~$10 per 1,000 searches) on top of token usage; capped at 5 searches per run.
                </p>
              </div>
            </label>
          </div>
        )}

        {show('export') && (
        <div className="space-y-3 text-sm">
            <div className="text-sm font-medium">Memo export formatting</div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Base font and size for Word / Google Doc exports. Headings scale from the base size.
              Citations and the appendix are omitted from exported documents.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Base font</label>
                <input
                  list="export-font-options"
                  value={exportFont}
                  onChange={e => setExportFont(e.target.value)}
                  placeholder="DM Sans"
                  className="h-9 w-full px-2 rounded-md border border-input bg-background text-sm"
                />
                <datalist id="export-font-options">
                  {EXPORT_FONT_OPTIONS.map(f => <option key={f} value={f} />)}
                </datalist>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Any font name is accepted. Google Docs renders web fonts like DM Sans natively; Word
                  substitutes if the font isn&apos;t installed locally.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Base font size (pt)</label>
                <Input
                  type="number"
                  min={6}
                  max={32}
                  value={exportFontSize}
                  onChange={e => setExportFontSize(e.target.value)}
                  placeholder="11"
                  className="font-mono"
                />
                <p className="text-[11px] text-muted-foreground mt-1">Body text size. 6–32pt.</p>
              </div>
            </div>
        </div>
        )}

        {show('stages') && (
          <div className="space-y-3 text-sm pt-1">
            <div className="text-sm font-medium">Call transcription (Deepgram)</div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Audio/video recordings uploaded to a deal&apos;s data room are transcribed via Deepgram.
              Test that the API key and webhook environment are configured correctly.
            </p>
            <Button variant="outline" size="sm" onClick={testTranscription} disabled={dgTesting}>
              {dgTesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              Test Deepgram connection
            </Button>
            {dgResult && (
              <div className="rounded-card border bg-muted/20 p-3 space-y-1.5 text-xs">
                <ResultRow ok={dgResult.deepgram.ok} label="Deepgram API" detail={dgResult.deepgram.detail} />
                <ResultRow
                  ok={dgResult.webhook_url_resolvable}
                  label="Webhook URL"
                  detail={dgResult.webhook_url_resolvable ? 'A callback base URL is resolvable.' : 'No callback base URL (set TRANSCRIPTION_WEBHOOK_URL or NEXT_PUBLIC_SITE_URL).'}
                />
                <div className={`pt-1 font-medium ${dgResult.ready ? 'text-success dark:text-success' : 'text-warning dark:text-warning'}`}>
                  {dgResult.ready ? 'Transcription is ready to use.' : 'Transcription is not fully configured.'}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : saved ? <Check className="h-4 w-4 mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            {saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ResultRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className={ok ? 'text-success' : 'text-destructive'}>
        {ok ? '\u2713' : '\u2717'}
      </span>
      <div className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{` \u2014 ${detail}`}</span>
      </div>
    </div>
  )
}
