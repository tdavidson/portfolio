'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, Loader2, Copy } from 'lucide-react'
import { Section } from '@/components/settings/section'
import { EntityPicker } from '@/components/entity-picker'

// ──────────────────────────── Deals ────────────────────────────

const DEFAULT_DEAL_SCREENING_PROMPT = `You are a senior partner at a venture capital fund. The fund's thesis is provided above.

For the inbound email and any attached materials, return structured output containing:

- The standard extraction fields (company, founders, intro source, stage, industry, raise).
- A company_summary describing what they do, who they sell to, stage, traction signals,
  and team highlights drawn directly from the materials.
- A thesis_fit_analysis covering:
   - Alignment with each pillar of the thesis (cite specific evidence).
   - Disqualifiers, if any.
   - Open questions a partner would ask before a first meeting.
- A single thesis_fit_score: strong | moderate | weak | out_of_thesis | spam (spam = non-pitches like newsletters or vendor solicitations).

Be specific. Avoid hedging adjectives. If a key fact is not in the materials, say so
explicitly rather than inferring.`

export function DealScreeningSection({ thesis, prompt, intakeEnabled, defaultVehicleId, hasSubmissionToken, onSaved }: {
  thesis: string | null
  prompt: string | null
  intakeEnabled: boolean
  defaultVehicleId: string | null
  hasSubmissionToken: boolean
  onSaved: () => void
}) {
  const [thesisVal, setThesisVal] = useState(thesis ?? '')
  const [promptVal, setPromptVal] = useState(prompt ?? DEFAULT_DEAL_SCREENING_PROMPT)
  const [intake, setIntake] = useState(intakeEnabled)
  const [pitchEntity, setPitchEntity] = useState<string | null>(defaultVehicleId)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  // The plaintext token is returned only when minted — only the hash is stored, so it can't be
  // shown again on reload. `mintedToken` holds it for this one session so the URL is copyable now.
  const [mintedToken, setMintedToken] = useState<string | null>(null)

  const isCustomized = prompt !== null
  const submissionUrl = mintedToken ? `${typeof window !== 'undefined' ? window.location.origin : ''}/submit/${mintedToken}` : null

  async function generateToken() {
    setTokenBusy(true)
    const res = await fetch('/api/settings/deal-submission-token', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setTokenBusy(false)
    if (res.ok) { setMintedToken(data.token ?? null); onSaved() }
  }

  async function clearToken() {
    if (!confirm('Disable the public submission form? Anyone with the current URL will see a not-found page.')) return
    setTokenBusy(true)
    const res = await fetch('/api/settings/deal-submission-token', { method: 'DELETE' })
    setTokenBusy(false)
    if (res.ok) { setMintedToken(null); onSaved() }
  }

  function copyUrl() {
    if (!submissionUrl) return
    navigator.clipboard.writeText(submissionUrl)
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 2000)
  }

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dealThesis: thesisVal,
        dealScreeningPrompt: promptVal,
        dealIntakeEnabled: intake,
        dealsDefaultVehicleId: pitchEntity,
      }),
    })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    }
  }

  async function handleResetPrompt() {
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealScreeningPrompt: null }),
    })
    setSaving(false)
    if (res.ok) {
      setPromptVal(DEFAULT_DEAL_SCREENING_PROMPT)
      onSaved()
    }
  }

  async function handlePreview() {
    setPreviewing(true)
    setPreviewResult(null)
    const res = await fetch('/api/deals/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thesis: thesisVal, screeningPrompt: promptVal }),
    })
    setPreviewing(false)
    if (res.ok) {
      const body = await res.json()
      setPreviewResult(JSON.stringify(body.analysis ?? body, null, 2))
    } else {
      const err = await res.text()
      setPreviewResult(`Error: ${err}`)
    }
  }

  return (
    <Section title="Deal screening">
      <p className="text-xs text-muted-foreground mb-3">
        Configure how inbound pitches are screened against your fund's thesis. The thesis is included
        verbatim before the screening instructions in the AI prompt.
      </p>

      <label className="block text-xs font-medium text-muted-foreground mb-1">Investment thesis</label>
      <textarea
        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono leading-relaxed mb-4"
        rows={6}
        value={thesisVal}
        onChange={e => setThesisVal(e.target.value)}
        placeholder="Describe your thesis: stages, sectors, geographies, check sizes, what you avoid..."
      />

      <label className="block text-xs font-medium text-muted-foreground mb-1">Screening instructions</label>
      <textarea
        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono leading-relaxed"
        rows={10}
        value={promptVal}
        onChange={e => setPromptVal(e.target.value)}
      />

      <label className="flex items-center gap-2 mt-4 text-sm cursor-pointer">
        <input type="checkbox" checked={intake} onChange={e => setIntake(e.target.checked)} className="h-4 w-4" />
        <span>Enable inbound deal intake</span>
      </label>
      <p className="text-xs text-muted-foreground ml-6 mt-1">
        When off, the classifier still runs in shadow mode (results recorded on each email) but no email is routed to Deals.
      </p>

      <label className="block text-sm mt-4 mb-1" htmlFor="pitch-entity">New pitches go to</label>
      <div className="max-w-xs">
        <EntityPicker id="pitch-entity" value={pitchEntity} onChange={setPitchEntity} allowUnassigned />
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Every pitch from the inbox or the submission form lands in this entity&apos;s deals, visible to its
        team. Unassigned pitches wait for an admin to move them to an entity&apos;s queue.
      </p>

      <div className="flex items-center gap-2 mt-4">
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
        </Button>
        {isCustomized && (
          <Button onClick={handleResetPrompt} disabled={saving} variant="outline" size="sm">
            Reset prompt
          </Button>
        )}
        <Button onClick={handlePreview} disabled={previewing || saving} variant="outline" size="sm">
          {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
          Preview
        </Button>
      </div>

      {previewResult && (
        <pre className="mt-3 whitespace-pre-wrap text-xs bg-muted rounded-md px-3 py-2 font-mono leading-relaxed max-h-80 overflow-y-auto">
          {previewResult}
        </pre>
      )}

      <div className="border-t mt-6 pt-4">
        <h3 className="text-base font-medium mb-1">Public submission form</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Share a public URL where founders can submit pitches directly. Each submission runs through the same screening pipeline as inbound emails.
          Generating a new URL invalidates the previous one.
        </p>
        {submissionUrl ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">Copy this URL now — it won&rsquo;t be shown again. Only a hash is stored.</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={submissionUrl} className="font-mono text-xs" />
              <Button onClick={copyUrl} variant="outline" size="sm">
                {tokenCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <Button onClick={clearToken} disabled={tokenBusy} variant="outline" size="sm">Disable form</Button>
            {!intake && (
              <p className="text-sm text-warning">
                Note: the form is currently inactive because deal intake is disabled above.
              </p>
            )}
          </div>
        ) : hasSubmissionToken ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">A submission link is active. The URL isn&rsquo;t shown after minting — regenerate to get a new one (the old link stops working).</p>
            <div className="flex gap-2">
              <Button onClick={generateToken} disabled={tokenBusy} variant="outline" size="sm">Regenerate URL</Button>
              <Button onClick={clearToken} disabled={tokenBusy} variant="outline" size="sm">Disable form</Button>
            </div>
            {!intake && (
              <p className="text-sm text-warning">
                Note: the form is currently inactive because deal intake is disabled above.
              </p>
            )}
          </div>
        ) : (
          <Button onClick={generateToken} disabled={tokenBusy} variant="outline" size="sm">
            Generate submission URL
          </Button>
        )}
      </div>
    </Section>
  )
}
