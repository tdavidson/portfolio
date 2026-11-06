'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Lock, Sparkles, Copy, Check, Save, FileText, Download, ExternalLink, ChevronDown, ChevronRight, MessageSquare, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useFeatureVisibility, useIsAdmin } from '@/components/feature-visibility-context'
import { LpShareControl } from '@/components/lp-share-control'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { PullDialog } from './pull-dialog'

const DEFAULT_PROMPT_PLACEHOLDER = `## LP Letter Style Guide (Default)

### Structure
1. Header: Fund name, period, date
2. Opening: "Dear Limited Partners" + brief intro paragraph
3. Portfolio Company Updates: one section per active company
4. Exited/Written-off: brief notes
5. Closing: placeholder for GP outlook

### Company Update Format
- Length: 2-4 paragraphs per company
- Leads with key metrics and trends
- References specific numbers from the data
- Notes significant developments or milestones
- Flags challenges honestly
- Does NOT include forward-looking predictions unless data-supported

### Tone
- Professional but not overly formal
- First person plural ("We", "Our portfolio")
- Data-forward, numbers first, narrative supports
- Balanced, acknowledges both positives and challenges
- Concise, no filler language`

interface CompanyNarrative {
  company_id: string
  company_name: string
  narrative: string
  updated_by: string | null
  updated_at: string
}

interface CompanyPrompt {
  prompt: string
  mode: 'add' | 'replace'
}

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
  company_narratives: CompanyNarrative[]
  full_draft: string | null
  /** The partners' "Missing information" notes: kept with the letter, never shown to investors. */
  internal_notes?: string | null
  generation_prompt: string | null
  generation_error: string | null
  company_prompts: Record<string, CompanyPrompt> | null
  status: string
  created_at: string
  updated_at: string
}

interface PortfolioPreviewData {
  fundName: string
  fundCurrency: string
  periodLabel: string
  portfolioGroup: string
  companies: {
    investment: {
      companyName: string
      status: string
      stage: string | null
      totalInvested: number
      totalRealized: number
      unrealizedValue: number
      fmv: number
      moic: number | null
    }
  }[]
  fundMetrics: {
    committedCapital: number
    paidInCapital: number
    distributions: number
    fmv: number
    dpi: number | null
    rvpi: number | null
    tvpi: number | null
    irr: number | null
  } | null
  totals: {
    totalInvested: number
    totalFmv: number
    totalRealized: number
    portfolioMoic: number | null
    activeCount: number
    exitedCount: number
    writtenOffCount: number
  }
}

export default function LetterEditorPage() {
  const fv = useFeatureVisibility()
  const isAdmin = useIsAdmin()
  const router = useRouter()
  const params = useParams()
  const letterId = params.id as string

  const [letter, setLetter] = useState<Letter | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState<string | null>(null)
  const [regeneratingAll, setRegeneratingAll] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingNarrative, setEditingNarrative] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [fullDraft, setFullDraft] = useState('')
  const [viewMode, setViewMode] = useState<'sections' | 'portfolio' | 'full'>('sections')
  const [exporting, setExporting] = useState<string | null>(null)
  const [googleDriveConnected, setGoogleDriveConnected] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [globalPromptOpen, setGlobalPromptOpen] = useState(false)
  const [globalPromptText, setGlobalPromptText] = useState('')
  const [savingGlobalPrompt, setSavingGlobalPrompt] = useState(false)
  const [promptPanelCompany, setPromptPanelCompany] = useState<string | null>(null)
  const [companyPromptText, setCompanyPromptText] = useState('')
  const [savingCompanyPrompt, setSavingCompanyPrompt] = useState(false)
  const [liveTableHtml, setLiveTableHtml] = useState<string | null>(null)
  const [loadingTable, setLoadingTable] = useState(false)
  const [previewData, setPreviewData] = useState<PortfolioPreviewData | null>(null)

  const loadLetter = useCallback(async () => {
    const res = await fetch(`/api/lp-letters/${letterId}`)
    if (res.ok) {
      const data = await res.json()
      setLetter(data)
      setFullDraft(data.full_draft ?? '')
      setGlobalPromptText(data.generation_prompt ?? DEFAULT_PROMPT_PLACEHOLDER)
    }
    setLoading(false)
  }, [letterId])

  // Load live portfolio table from preview endpoint
  const loadPortfolioTable = useCallback(async (l: Letter) => {
    setLoadingTable(true)
    try {
      const params = new URLSearchParams({
        year: String(l.period_year),
        quarter: String(l.period_quarter),
        group: l.portfolio_group,
        yearEnd: String(l.is_year_end),
      })
      const res = await fetch(`/api/lp-letters/preview?${params}`)
      if (res.ok) {
        const preview = await res.json()
        setPreviewData(preview)
        const html = buildTableHtml(preview)
        setLiveTableHtml(html)
      }
    } catch {
      // Fall back to stored table
    } finally {
      setLoadingTable(false)
    }
  }, [])

  useEffect(() => {
    loadLetter()
  }, [loadLetter])

  // Load live portfolio table when letter is available
  useEffect(() => {
    if (letter) loadPortfolioTable(letter)
  }, [letter?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for updates when letter is generating server-side
  useEffect(() => {
    if (!letter || letter.status !== 'generating') return
    const interval = setInterval(() => { loadLetter() }, 5000)
    return () => clearInterval(interval)
  }, [letter?.status, loadLetter])

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.googleDriveConnected) setGoogleDriveConnected(true)
      })
      .catch(() => {})
  }, [])

  const saveNarrative = async (companyId: string, text: string) => {
    if (!letter) return
    const narratives = [...(letter.company_narratives ?? [])]
    const idx = narratives.findIndex(n => n.company_id === companyId)
    if (idx >= 0) {
      narratives[idx] = { ...narratives[idx], narrative: text, updated_at: new Date().toISOString() }
    }

    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_narratives: narratives }),
    })
    if (res.ok) {
      const updated = await res.json()
      setLetter(updated)
    }
    setSaving(false)
    setEditingNarrative(null)
  }

  // Final = a person has reviewed it; only a final letter can be shared. Regenerating puts it back to draft.
  const setStatus = async (status: 'draft' | 'final') => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) setLetter(await res.json())
    setSaving(false)
  }

  const saveFullDraft = async () => {
    setSaving(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_draft: fullDraft }),
    })
    if (res.ok) {
      const updated = await res.json()
      setLetter(updated)
    }
    setSaving(false)
  }

  const regenerateCompany = async (companyId: string) => {
    setRegenerating(companyId)
    const res = await fetch(`/api/lp-letters/${letterId}/generate/${companyId}`, { method: 'POST' })
    if (res.ok) {
      await loadLetter()
    }
    setRegenerating(null)
  }

  const regenerateAll = async () => {
    setRegeneratingAll(true)
    const res = await fetch(`/api/lp-letters/${letterId}/generate`, { method: 'POST' })
    if (res.ok) {
      await loadLetter()
    }
    setRegeneratingAll(false)
  }

  const copyToClipboard = () => {
    const text = letter?.full_draft ?? fullDraft
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const exportLetter = async (format: 'markdown' | 'docx' | 'google-docs') => {
    setExporting(format)
    // Open the tab synchronously within the click so the browser doesn't block it
    // as a popup (window.open after an await is commonly blocked).
    const docWin = format === 'google-docs' ? window.open('about:blank', '_blank') : null
    try {
      const res = await fetch(`/api/lp-letters/${letterId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      })

      if (!res.ok) {
        docWin?.close()
        const err = await res.json().catch(() => ({ error: 'Export failed' }))
        alert(err.error ?? 'Export failed')
        return
      }

      if (format === 'google-docs') {
        const { url } = await res.json()
        if (docWin) docWin.location.href = url
        else window.open(url, '_blank')
      } else {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const ext = format === 'docx' ? 'docx' : 'md'
        a.download = `${letter?.period_label ?? 'letter'}.${ext}`
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch {
      docWin?.close()
      alert('Export failed')
    } finally {
      setExporting(null)
    }
  }

  const saveGlobalPrompt = async () => {
    setSavingGlobalPrompt(true)
    const res = await fetch(`/api/lp-letters/${letterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation_prompt: globalPromptText || null }),
    })
    if (res.ok) {
      const updated = await res.json()
      setLetter(updated)
    }
    setSavingGlobalPrompt(false)
  }

  const saveCompanyPromptAndRegenerate = async (companyId: string) => {
    if (!letter) return
    setSavingCompanyPrompt(true)
    const existing = letter.company_prompts ?? {}
    const updated = { ...existing }
    if (companyPromptText.trim()) {
      updated[companyId] = { prompt: companyPromptText.trim(), mode: 'add' }
    } else {
      delete updated[companyId]
    }
    const res = await fetch(`/api/lp-letters/${letterId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_prompts: updated }),
    })
    if (res.ok) {
      const data = await res.json()
      setLetter(data)
    }
    setSavingCompanyPrompt(false)
    setPromptPanelCompany(null)
    await regenerateCompany(companyId)
  }

  const openPromptPanel = (companyId: string) => {
    if (promptPanelCompany === companyId) {
      setPromptPanelCompany(null)
      return
    }
    const cp = letter?.company_prompts?.[companyId]
    setCompanyPromptText(cp?.prompt ?? '')
    setPromptPanelCompany(companyId)
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

  const narratives: CompanyNarrative[] = Array.isArray(letter.company_narratives) ? letter.company_narratives : []
  const hasContent = narratives.length > 0 || letter.full_draft
  const tableHtml = sanitizeLetterHtml(liveTableHtml ?? letter.portfolio_table_html)

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
      {/* Header */}
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          {fv.lp_letters === 'admin' && <Lock className="h-4 w-4 text-warning" />}{letter.period_label}
        </h1>
        <p className="text-sm text-muted-foreground">{letter.portfolio_group}</p>
      </div>

      {/* Tabs row with action buttons */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Tabs value={viewMode} onValueChange={v => setViewMode(v as 'sections' | 'portfolio' | 'full')}>
          <TabsList>
            <TabsTrigger value="sections">Edit Company Summaries</TabsTrigger>
            <TabsTrigger value="portfolio">Review Portfolio Data</TabsTrigger>
            <TabsTrigger value="full">Review All</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2 ml-auto">
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={copyToClipboard} title="Copy the full letter draft to your clipboard">
            {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {hasContent && (
            <Button
              size="sm"
              variant="outline"
              className="text-muted-foreground"
              onClick={() => exportLetter('docx')}
              disabled={!!exporting}
              title="Download the letter as a Word document (.docx)"
            >
              {exporting === 'docx' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
              Download .docx
            </Button>
          )}
          {hasContent && googleDriveConnected && (
            <Button
              size="sm"
              variant="outline"
              className="text-muted-foreground"
              onClick={() => exportLetter('google-docs')}
              disabled={!!exporting}
              title="Export the letter to Google Docs in your connected Drive"
            >
              {exporting === 'google-docs' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <ExternalLink className="h-3.5 w-3.5 mr-1.5" />}
              Google Docs
            </Button>
          )}
          {googleDriveConnected && letter.status === 'draft' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="text-muted-foreground"
                onClick={() => setPullOpen(true)}
                title="Replace this draft with the Google Doc the partners edited"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Pull from Google Doc
              </Button>
              <PullDialog
                letterId={letterId}
                open={pullOpen}
                onOpenChange={setPullOpen}
                onReplaced={updated => { setLetter(updated); setFullDraft(updated.full_draft ?? '') }}
              />
            </>
          )}
          {/* Sharing into the portal is the portal's own switch — `lp_portal_access` was a second
              key for the same idea and has been folded into `lp_portal`. */}
          {hasContent && letter.status !== 'generating' && (
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

      {/* Analyst prompt editor, only on Edit Company Summaries tab */}
      {viewMode === 'sections' && <div className="rounded-lg border mb-4">
        <button
          onClick={() => setGlobalPromptOpen(!globalPromptOpen)}
          className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-sm hover:bg-muted/50"
        >
          {globalPromptOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-medium">Analyst prompt</span>
          {letter.generation_prompt && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">customized</span>
          )}
        </button>
        {globalPromptOpen && (
          <div className="px-4 pb-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Custom instructions applied to all company narratives during generation.
            </p>
            <Textarea
              value={globalPromptText}
              onChange={e => setGlobalPromptText(e.target.value)}
              rows={6}
              className="text-sm"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={saveGlobalPrompt}
                disabled={savingGlobalPrompt || globalPromptText === (letter.generation_prompt ?? DEFAULT_PROMPT_PLACEHOLDER)}
              >
                {savingGlobalPrompt ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Save prompt
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                className="text-muted-foreground"
                onClick={regenerateAll}
                disabled={regeneratingAll}
                title="Generate AI narratives for all portfolio companies"
              >
                {regeneratingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
                Analyze All Companies
              </Button>
            </div>
          </div>
        )}
      </div>}

      {!hasContent && !regeneratingAll && letter.status === 'generating' && (
        <div className="rounded-card border bg-muted/30 p-8 text-center space-y-3">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Generation is in progress. This may take a few minutes...
          </p>
          <p className="text-xs text-muted-foreground/60">This page will update automatically when ready.</p>
        </div>
      )}

      {!hasContent && !regeneratingAll && letter.status !== 'generating' && (
        <div className="rounded-card border border-dashed p-12 text-center space-y-3">
          <FileText className="h-8 w-8 mx-auto text-muted-foreground" />
          {letter.generation_error ? (
            <>
              <p className="text-sm text-destructive">Generation failed</p>
              <p className="text-xs text-muted-foreground">{letter.generation_error}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">No content has been generated for this letter yet.</p>
              <p className="text-xs text-muted-foreground/60">Open the Analyst Prompt above to generate AI-written narratives for each portfolio company.</p>
            </>
          )}
          {letter.generation_error && (
            <Button size="sm" variant="outline" onClick={regenerateAll}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              Retry generation
            </Button>
          )}
        </div>
      )}

      {regeneratingAll && (
        <div className="rounded-card border bg-muted/30 p-8 text-center space-y-3">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Analyzing all companies. This may take a few minutes...
          </p>
        </div>
      )}

      {/* Section view */}
      {viewMode === 'sections' && !regeneratingAll && (
        <div className="space-y-6">
          {/* Company narratives */}
          {hasContent && narratives.map(n => (
            <div key={n.company_id} className="rounded-card border p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-base">{n.company_name}</h3>
                <div className="flex items-center gap-1.5">
                  {editingNarrative !== n.company_id && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs px-2.5"
                      onClick={() => { setEditingNarrative(n.company_id); setEditText(n.narrative); setPromptPanelCompany(null) }}
                    >
                      <Pencil className="h-3 w-3 mr-1.5" />
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={promptPanelCompany === n.company_id ? 'default' : 'outline'}
                    className="h-7 text-xs px-2.5"
                    onClick={() => { openPromptPanel(n.company_id); setEditingNarrative(null) }}
                  >
                    <MessageSquare className="h-3 w-3 mr-1.5" />
                    Prompt
                    {letter.company_prompts?.[n.company_id] && promptPanelCompany !== n.company_id && (
                      <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary inline-block" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex gap-0">
                {/* Main content area */}
                <div className={`min-w-0 ${promptPanelCompany === n.company_id ? 'flex-1' : 'w-full'}`}>
                  {editingNarrative === n.company_id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={8}
                        className="text-sm"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveNarrative(n.company_id, editText)}
                          disabled={saving}
                        >
                          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                          Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingNarrative(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap text-muted-foreground leading-relaxed">
                      {regenerating === n.company_id ? (
                        <div className="flex items-center gap-2 py-4 text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="text-xs">Analyzing company...</span>
                        </div>
                      ) : (
                        n.narrative
                      )}
                    </div>
                  )}
                </div>

                {/* Inline prompt panel (slides in from right within card) */}
                {promptPanelCompany === n.company_id && (
                  <div className="w-[280px] shrink-0 border-l ml-4 pl-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">Company prompt</p>
                      <button onClick={() => setPromptPanelCompany(null)} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Custom instructions for this company. Saving will regenerate the narrative.
                    </p>
                    <Textarea
                      value={companyPromptText}
                      onChange={e => setCompanyPromptText(e.target.value)}
                      placeholder="e.g., Emphasize product milestones and customer growth..."
                      rows={5}
                      className="text-xs"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => saveCompanyPromptAndRegenerate(n.company_id)}
                        disabled={savingCompanyPrompt || regenerating === n.company_id}
                      >
                        {(savingCompanyPrompt || regenerating === n.company_id) ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                        ) : (
                          <Sparkles className="h-3 w-3 mr-1.5" />
                        )}
                        Save & analyze
                      </Button>
                    </div>
                    {letter.company_prompts?.[n.company_id] && (
                      <button
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          const existing = letter.company_prompts ?? {}
                          const updated = { ...existing }
                          delete updated[n.company_id]
                          const res = await fetch(`/api/lp-letters/${letterId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ company_prompts: updated }),
                          })
                          if (res.ok) {
                            const data = await res.json()
                            setLetter(data)
                            setCompanyPromptText('')
                          }
                        }}
                      >
                        Clear prompt
                      </button>
                    )}
                  </div>
                )}
              </div>

              <p className="text-[10px] text-muted-foreground/50 mt-2">
                Last updated: {new Date(n.updated_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Portfolio data view */}
      {viewMode === 'portfolio' && (
        <div className="space-y-6">
          {loadingTable ? (
            <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading portfolio data...</span>
            </div>
          ) : previewData ? (
            <>
              {/* Fund metrics table */}
              <div className="rounded-card border p-4">
                <h2 className="font-medium text-base mb-3">Fund Summary</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-2 py-1.5 font-semibold">Fund</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Committed</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Called</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Distributions</th>
                        <th className="text-right px-2 py-1.5 font-semibold">FMV</th>
                        <th className="text-right px-2 py-1.5 font-semibold">DPI</th>
                        <th className="text-right px-2 py-1.5 font-semibold">RVPI</th>
                        <th className="text-right px-2 py-1.5 font-semibold">TVPI</th>
                        <th className="text-right px-2 py-1.5 font-semibold">IRR</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{previewData.fundName}</div>
                          <div className="text-muted-foreground">{previewData.portfolioGroup}</div>
                        </td>
                        {previewData.fundMetrics ? (
                          <>
                            <td className="text-right px-2 py-1.5 tabular-nums">{fmtCurrency(previewData.fundMetrics.committedCapital)}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{fmtCurrency(previewData.fundMetrics.paidInCapital)}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{fmtCurrency(previewData.fundMetrics.distributions)}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{fmtCurrency(previewData.fundMetrics.fmv)}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{previewData.fundMetrics.dpi != null ? `${previewData.fundMetrics.dpi.toFixed(2)}x` : '\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{previewData.fundMetrics.rvpi != null ? `${previewData.fundMetrics.rvpi.toFixed(2)}x` : '\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{previewData.fundMetrics.tvpi != null ? `${previewData.fundMetrics.tvpi.toFixed(2)}x` : '\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{previewData.fundMetrics.irr != null ? `${(previewData.fundMetrics.irr * 100).toFixed(1)}%` : '\u2014'}</td>
                          </>
                        ) : (
                          <>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{'\u2014'}</td>
                          </>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Portfolio company table */}
              {tableHtml && (
                <div className="rounded-card border p-4">
                  <h2 className="font-medium text-base mb-3">Portfolio Companies</h2>
                  {/* Not markdown — sanitized HTML from buildTableHtml. The `prose` classes that
                      used to lead this list did nothing (@tailwindcss/typography isn't installed);
                      the [&_…] selectors are what actually styles the table. tabular-nums so the
                      currency and MOIC columns line up, per CLAUDE.md. */}
                  <div
                    className="overflow-x-auto tabular-nums [&_table]:w-full [&_table]:text-xs [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_td]:border [&_thead]:bg-muted/50"
                    dangerouslySetInnerHTML={{ __html: tableHtml }}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="rounded-card border border-dashed p-12 text-center">
              <p className="text-sm text-muted-foreground">No portfolio data available for this period.</p>
            </div>
          )}
        </div>
      )}

      {/* Full draft view */}
      {viewMode === 'full' && hasContent && !regeneratingAll && (
        <div className="space-y-4">
          {letter.internal_notes && (
            <div className="rounded-card border bg-muted/30 p-4 space-y-1.5">
              <p className="text-xs font-medium">Internal notes · never shown to investors</p>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{letter.internal_notes}</p>
            </div>
          )}
          <Textarea
            value={fullDraft}
            onChange={e => setFullDraft(e.target.value)}
            rows={40}
            className="font-mono text-sm leading-relaxed"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={saveFullDraft}
              disabled={saving || fullDraft === letter.full_draft}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Save draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFullDraft(letter.full_draft ?? '')}
              disabled={fullDraft === letter.full_draft}
            >
              Revert
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Build portfolio table HTML from preview data (client-side, no AI)
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
      <td>${escHtml(inv.stage ?? '\u2014')}</td>
      <td style="text-align:right">${fmtCurrency(inv.totalInvested)}</td>
      <td style="text-align:right">${fmtCurrency(inv.fmv)}</td>
      <td style="text-align:right">${inv.moic ? `${inv.moic.toFixed(2)}x` : '\u2014'}</td>
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
      <td style="text-align:right"><strong>${preview.totals.portfolioMoic ? `${preview.totals.portfolioMoic.toFixed(2)}x` : '\u2014'}</strong></td>
    </tr>
  </tfoot>
</table>`
}
