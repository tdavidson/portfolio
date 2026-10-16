'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, CheckCircle2, Circle, Loader2, X, Plus, Building2, HardDrive } from 'lucide-react'
import {
  WIZARD_PRODUCTS,
  WIZARD_STEP_LABELS,
  needsFirstEntity,
  stepsFor,
  type SkippableStep,
  type WizardAIProvider,
  type WizardProduct,
  type WizardStep,
} from '@/lib/onboarding/wizard'
import { VEHICLE_KIND_OPTIONS, type VehicleKind } from '@/lib/vehicle-kinds'
import { AICapabilitiesList } from '@/components/ai-capabilities-list'
import { useOrigin } from '@/components/ask-your-assistant'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Sender {
  email: string
  label: string
}

interface OnboardingState {
  fundId: string | null
  fundName: string
  webhookToken: string | null
  products: WizardProduct[]
}

interface MatchingFund {
  id: string
  name: string
}

const DEFAULT_PRODUCTS: WizardProduct[] = WIZARD_PRODUCTS.filter(p => p.defaultOn).map(p => p.key)

/** Where the wizard lands when the person presses Finish (or skips the last step). */
const FINISH_PATH = '/getting-started'

async function skipStep(step: SkippableStep): Promise<void> {
  // Best effort: remembering the skip only matters for resuming after a refresh.
  await fetch('/api/onboarding/fund', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'skip', step }),
  }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ steps, current }: { steps: WizardStep[]; current: WizardStep }) {
  const currentIndex = steps.indexOf(current)
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2">
        {steps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5" aria-label={WIZARD_STEP_LABELS[step]} title={WIZARD_STEP_LABELS[step]}>
              {i < currentIndex ? (
                <CheckCircle2 className="h-5 w-5 text-primary" />
              ) : i === currentIndex ? (
                <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                  <span className="text-[10px] font-bold text-primary-foreground tabular-nums">{i + 1}</span>
                </div>
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground" />
              )}
              {i === currentIndex && (
                <span className="text-sm font-medium">{WIZARD_STEP_LABELS[step]}</span>
              )}
            </div>
            {i < steps.length - 1 && (
              <div className="w-6 h-px bg-border mx-1" />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2 tabular-nums">
        Step {currentIndex + 1} of {steps.length}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <OnboardingContent />
    </Suspense>
  )
}

function OnboardingContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [loading, setLoading] = useState(true)
  const [matchingFund, setMatchingFund] = useState<MatchingFund | null>(null)
  const [mode, setMode] = useState<'detect' | 'join' | 'create'>('detect')
  const [step, setStep] = useState<WizardStep>('fund')
  const [state, setState] = useState<OnboardingState>({
    fundId: null, fundName: '', webhookToken: null, products: DEFAULT_PRODUCTS,
  })
  const emailConfirmed = searchParams.get('confirmed') === 'true'
  const googleConnected = searchParams.get('google_connected') === 'true'

  const detectFund = useCallback(async () => {
    // Check if the user has an in-progress onboarding to resume
    const statusRes = await fetch('/api/onboarding/fund')
    if (statusRes.ok) {
      const status = await statusRes.json()
      if (status.step === 'complete' && !googleConnected) {
        router.push('/dashboard')
        return
      }
      if (status.fundId) {
        setState({
          fundId: status.fundId,
          fundName: status.fundName ?? '',
          webhookToken: status.webhookToken ?? null,
          products: Array.isArray(status.products) ? status.products : DEFAULT_PRODUCTS,
        })

        if (googleConnected || status.step === 'complete') {
          // Returning from Google OAuth, or everything else done: the Google Drive step
          setStep('drive')
        } else if (typeof status.step === 'string' && status.step in WIZARD_STEP_LABELS) {
          setStep(status.step as WizardStep)
        }

        setMode('create')
        setLoading(false)
        return
      }
    }

    // No existing fund — check for domain-matching fund to join
    const res = await fetch('/api/onboarding/check-domain')
    if (res.ok) {
      const data = await res.json()
      if (data.fund) {
        setMatchingFund(data.fund)
        setMode('join')
        setLoading(false)
        return
      }
    }

    setMode('create')
    setLoading(false)
  }, [router, googleConnected])

  useEffect(() => { detectFund() }, [detectFund])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const confirmedBanner = emailConfirmed ? (
    <Alert className="mb-6 border-success bg-success-subtle">
      <CheckCircle2 className="h-4 w-4 text-success" />
      <AlertDescription className="text-success">
        Your email has been confirmed. You&apos;re all set to get started.
      </AlertDescription>
    </Alert>
  ) : null

  if (mode === 'join' && matchingFund) {
    return <JoinFundScreen fund={matchingFund} onCreateInstead={() => setMode('create')} confirmedBanner={confirmedBanner} />
  }

  const steps = stepsFor(state.products)
  // A resumed step that this product mix no longer shows (portfolio tracking turned off) falls
  // through to the last one.
  const current: WizardStep = steps.includes(step) ? step : 'drive'
  const advance = (from: WizardStep, products: WizardProduct[] = state.products) => {
    const order = stepsFor(products)
    setStep(order[order.indexOf(from) + 1] ?? 'drive')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-lg">
        {confirmedBanner}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Set up your fund</h1>
          <p className="text-sm text-muted-foreground mt-1">
            About 5 minutes. Only the first two steps are needed now; everything after them can be
            set up later, and all of it can be changed in Settings.
          </p>
        </div>

        <StepIndicator steps={steps} current={current} />

        {current === 'fund' && (
          <FundStep
            initialName={state.fundName}
            onComplete={(fundId, webhookToken, fundName) => {
              setState(s => ({ ...s, fundId, fundName, webhookToken: webhookToken ?? s.webhookToken }))
              advance('fund')
            }}
          />
        )}
        {current === 'products' && state.fundId && (
          <ProductsStep
            fundName={state.fundName}
            initialProducts={state.products}
            onBack={() => setStep('fund')}
            onComplete={products => {
              setState(s => ({ ...s, products }))
              advance('products', products)
            }}
          />
        )}
        {current === 'inbound' && state.fundId && (
          <InboundStep
            fundId={state.fundId}
            webhookToken={state.webhookToken}
            onComplete={() => advance('inbound')}
            onSkip={async () => { await skipStep('inbound'); advance('inbound') }}
          />
        )}
        {current === 'senders' && state.fundId && (
          <SendersStep
            fundId={state.fundId}
            onComplete={() => advance('senders')}
            onSkip={async () => { await skipStep('senders'); advance('senders') }}
          />
        )}
        {current === 'drive' && (
          <DriveStep
            googleConnected={googleConnected}
            onFinish={() => router.push(FINISH_PATH)}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Join existing fund screen
// ---------------------------------------------------------------------------

function JoinFundScreen({
  fund,
  onCreateInstead,
  confirmedBanner,
}: {
  fund: MatchingFund
  onCreateInstead: () => void
  confirmedBanner?: React.ReactNode
}) {
  const router = useRouter()
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function requestJoin() {
    setRequesting(true)
    setError(null)

    try {
      const res = await fetch('/api/onboarding/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fundId: fund.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRequested(true)
      setTimeout(() => router.push('/pending'), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setRequesting(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md space-y-4">
        {confirmedBanner}
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome</h1>
          <p className="text-sm text-muted-foreground mt-1">
            We found a fund matching your email domain.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {requested ? (
              <div className="text-center py-4">
                <CheckCircle2 className="h-8 w-8 text-success mx-auto mb-2" />
                <p className="font-medium">Request sent</p>
                <p className="text-sm text-muted-foreground">Redirecting...</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 p-4 rounded-card border bg-muted/50">
                  <Building2 className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div>
                    <p className="font-medium">{fund.name}</p>
                    <p className="text-xs text-muted-foreground">Existing fund at your organization</p>
                  </div>
                </div>

                <Button className="w-full" onClick={requestJoin} disabled={requesting}>
                  {requesting ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Requesting...</>
                  ) : (
                    'Request to join'
                  )}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  Your request will be reviewed by a fund administrator.
                </p>

                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>

                <Button variant="outline" className="w-full" onClick={onCreateInstead}>
                  Create a new fund instead
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** A selectable tile — the provider picker and the product checklist share it. */
function ChoiceTile({
  selected,
  onClick,
  title,
  description,
  role = 'radio',
}: {
  selected: boolean
  onClick: () => void
  title: string
  description?: string
  role?: 'radio' | 'checkbox'
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      onClick={onClick}
      className={`w-full rounded-lg border px-4 py-3 text-left text-sm transition-colors ${ selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent' }`}
    >
      <span className="flex items-start gap-3">
        {role === 'checkbox' && (
          <span
            className={`mt-0.5 h-4 w-4 shrink-0 rounded-sm border flex items-center justify-center ${ selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input' }`}
            aria-hidden
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        )}
        <span className="min-w-0">
          <span className="font-medium">{title}</span>
          {description && <span className="block text-xs text-muted-foreground mt-0.5">{description}</span>}
        </span>
      </span>
    </button>
  )
}

function StepError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

/** The "Set up later" link under a step's primary button. */
function LaterButton({ onClick, busy, children = 'Set up later' }: { onClick: () => void; busy?: boolean; children?: React.ReactNode }) {
  return (
    <Button variant="ghost" className="w-full text-muted-foreground" onClick={onClick} disabled={busy}>
      {children}
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Step: Your fund — name + how AI works here (a provider key, your own assistant, or decide later)
// ---------------------------------------------------------------------------

const AI_PROVIDERS: {
  key: WizardAIProvider
  label: string
  placeholder: string
  consoleUrl: string
  consoleLabel: string
  testUrl: string | null
}[] = [
  { key: 'anthropic', label: 'Claude', placeholder: 'sk-ant-…', consoleUrl: 'https://console.anthropic.com', consoleLabel: 'console.anthropic.com', testUrl: '/api/test-claude-key' },
  { key: 'openai', label: 'OpenAI', placeholder: 'sk-…', consoleUrl: 'https://platform.openai.com/api-keys', consoleLabel: 'platform.openai.com', testUrl: '/api/test-openai-key' },
  { key: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…', consoleUrl: 'https://openrouter.ai/keys', consoleLabel: 'openrouter.ai', testUrl: null },
]

function FundStep({
  initialName,
  onComplete,
}: {
  initialName: string
  onComplete: (fundId: string, webhookToken: string | null, fundName: string) => void
}) {
  const [fundName, setFundName] = useState(initialName)
  const [aiChoice, setAIChoice] = useState<'key' | 'assistant'>('key')
  const origin = useOrigin()
  const [provider, setProvider] = useState<WizardAIProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const meta = AI_PROVIDERS.find(p => p.key === provider)!

  async function testKey() {
    if (!apiKey.trim() || !meta.testUrl) return
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const res = await fetch(meta.testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })
      const data = await res.json()
      if (res.ok) {
        setTestResult('success')
      } else {
        setTestResult('error')
        setTestError(data.error ?? 'Connection failed')
      }
    } catch {
      setTestResult('error')
      setTestError('Network error')
    }
    setTesting(false)
  }

  async function submit(choice: 'key' | 'assistant' | 'later') {
    if (!fundName.trim()) {
      setError('Give your fund a name.')
      return
    }
    if (choice === 'key' && !apiKey.trim()) {
      setError('Paste an API key, choose “Use my own assistant”, or “Skip — decide later”.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const body: Record<string, string> = { fundName: fundName.trim() }
      if (choice === 'key') {
        body.aiProvider = provider
        body.apiKey = apiKey.trim()
      } else if (choice === 'assistant') {
        body.aiMode = 'assistant'
      }
      const res = await fetch('/api/onboarding/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onComplete(data.fundId, data.webhookToken ?? null, fundName.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your fund</CardTitle>
        <CardDescription>
          Name it, and choose how AI works here: with a provider key on the server, or with no key,
          through your own assistant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <StepError error={error} />

        <div className="space-y-2">
          <Label htmlFor="fund-name">Fund name</Label>
          <Input
            id="fund-name"
            placeholder="Acme Ventures"
            value={fundName}
            onChange={e => setFundName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>How should AI work here?</Label>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How AI works here">
            <ChoiceTile
              selected={aiChoice === 'key'}
              title="Add a key"
              description="The app calls Claude, OpenAI or OpenRouter itself: AI buttons, email parsing and background jobs all work."
              onClick={() => setAIChoice('key')}
            />
            <ChoiceTile
              selected={aiChoice === 'assistant'}
              title="Use my own assistant"
              description="No server key. Claude or ChatGPT, connected to this fund, does the AI work when you ask it."
              onClick={() => setAIChoice('assistant')}
            />
          </div>
        </div>

        {aiChoice === 'assistant' ? (
          <div className="space-y-3 rounded-card border p-4">
            <p className="text-sm text-muted-foreground">
              Connect <span className="font-mono text-foreground">{`${origin}/api/mcp`}</span>{' '}
              in Claude or ChatGPT after this step. You can add a key later in Settings.
            </p>
            <AICapabilitiesList />
          </div>
        ) : (<>
        <div className="space-y-2">
          <Label>AI provider</Label>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="AI provider">
            {AI_PROVIDERS.map(p => (
              <ChoiceTile
                key={p.key}
                selected={provider === p.key}
                title={p.label}
                onClick={() => {
                  setProvider(p.key)
                  setTestResult(null)
                  setTestError(null)
                }}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="api-key">{meta.label} API key</Label>
          <div className="flex gap-2">
            <Input
              id="api-key"
              type="password"
              placeholder={meta.placeholder}
              value={apiKey}
              onChange={e => {
                setApiKey(e.target.value)
                setTestResult(null)
              }}
              className="flex-1 font-mono"
              autoComplete="off"
            />
            {meta.testUrl && (
              <Button variant="outline" onClick={testKey} disabled={testing || !apiKey.trim()}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
              </Button>
            )}
          </div>
          {testResult === 'success' && (
            <p className="text-sm text-success flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected successfully
            </p>
          )}
          {testResult === 'error' && (
            <p className="text-sm text-destructive">{testError}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Get your key at{' '}
            <a href={meta.consoleUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {meta.consoleLabel}
            </a>
            {provider === 'openrouter' && '. The model and endpoint can be changed in Settings, where you can also test the connection.'}
            {'. Keys are encrypted before storage and never shown again.'}
          </p>
        </div>
        </>)}

        <div className="space-y-2">
          <Button className="w-full" onClick={() => submit(aiChoice)} disabled={saving}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</> : 'Next →'}
          </Button>
          <LaterButton onClick={() => submit('later')} busy={saving}>
            Skip — decide later
          </LaterButton>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step: What will you run here? — products + the first fund entity
// ---------------------------------------------------------------------------

function ProductsStep({
  fundName,
  initialProducts,
  onBack,
  onComplete,
}: {
  fundName: string
  initialProducts: WizardProduct[]
  onBack: () => void
  onComplete: (products: WizardProduct[]) => void
}) {
  const [products, setProducts] = useState<WizardProduct[]>(initialProducts)
  const [entityName, setEntityName] = useState(fundName)
  const [entityKind, setEntityKind] = useState<VehicleKind>(() =>
    initialProducts.includes('management_company') && !initialProducts.includes('fund_operations') && !initialProducts.includes('lp_reporting')
      ? 'manco'
      : 'fund')
  const [vintageYear, setVintageYear] = useState(String(new Date().getFullYear()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wantsEntity = needsFirstEntity(products)
  const mancoOn = products.includes('management_company')
  const kindOptions = VEHICLE_KIND_OPTIONS.filter(o => o.value !== 'manco' || mancoOn)
  // Only the manco chosen: the first entity is the management company itself.
  const onlyManco = mancoOn && !products.includes('fund_operations') && !products.includes('lp_reporting')
  const effectiveKind: VehicleKind = entityKind === 'manco' && !mancoOn ? 'fund' : entityKind

  function toggle(p: WizardProduct) {
    const next = products.includes(p) ? products.filter(x => x !== p) : [...products, p]
    const nextOnlyManco = next.includes('management_company') && !next.includes('fund_operations') && !next.includes('lp_reporting')
    setProducts(next)
    if (nextOnlyManco) setEntityKind('manco')
    else if (entityKind === 'manco' && (onlyManco || !next.includes('management_company'))) setEntityKind('fund')
  }

  async function submit() {
    if (products.length === 0) {
      setError('Choose at least one. You can turn the rest on later in Settings.')
      return
    }
    if (wantsEntity && !entityName.trim()) {
      setError('Name the first entity.')
      return
    }
    if (wantsEntity && vintageYear.trim() && !/^\d{4}$/.test(vintageYear.trim())) {
      setError('Vintage year must be a year like 2024.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const body: Record<string, unknown> = { action: 'products', products }
      if (wantsEntity) {
        body.entity = { name: entityName.trim(), kind: effectiveKind, vintageYear: vintageYear.trim() || null }
      }
      const res = await fetch('/api/onboarding/fund', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onComplete(products)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What will you run here?</CardTitle>
        <CardDescription>
          Pick what you need today. Each one can be turned on or off later in Settings, so there is
          no wrong answer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <StepError error={error} />

        <div className="space-y-2">
          {WIZARD_PRODUCTS.map(p => (
            <ChoiceTile
              key={p.key}
              role="checkbox"
              selected={products.includes(p.key)}
              title={p.label}
              description={p.description}
              onClick={() => toggle(p.key)}
            />
          ))}
        </div>

        {wantsEntity && (
          <div className="space-y-4 rounded-card border p-4">
            <div>
              <h2 className="text-base font-medium">{onlyManco ? 'Your management company' : 'Your first fund entity'}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Books and LP capital are kept per entity. Start with one; you can add SPVs and other
                entities later.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="entity-name">Name</Label>
              <Input
                id="entity-name"
                value={entityName}
                placeholder={fundName || 'Acme Ventures Fund I'}
                onChange={e => setEntityName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="entity-kind">Kind</Label>
                <Select value={effectiveKind} onValueChange={v => setEntityKind(v as VehicleKind)}>
                  <SelectTrigger id="entity-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kindOptions.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="entity-vintage">Vintage year</Label>
                <Input
                  id="entity-vintage"
                  inputMode="numeric"
                  maxLength={4}
                  value={vintageYear}
                  onChange={e => setVintageYear(e.target.value.replace(/\D/g, ''))}
                  className="tabular-nums"
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack} disabled={saving}>
            ← Back
          </Button>
          <Button className="flex-1" onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</> : 'Next →'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step: Inbound email (Postmark or Resend) — optional
// ---------------------------------------------------------------------------

function InboundStep({
  fundId,
  webhookToken,
  onComplete,
  onSkip,
}: {
  fundId: string
  webhookToken: string | null
  onComplete: () => void
  onSkip: () => Promise<void>
}) {
  const [provider, setProvider] = useState<'postmark' | 'resend'>('postmark')
  const [inboundAddress, setInboundAddress] = useState('')
  const [rsDomain, setRsDomain] = useState('')
  const [rsApiKey, setRsApiKey] = useState('')
  const [rsSecret, setRsSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultBase = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_APP_URL || window.location.origin)
    : ''
  const [baseUrl, setBaseUrl] = useState(defaultBase)
  const postmarkWebhookUrl = webhookToken ? `${baseUrl}/api/inbound-email?token=${webhookToken}` : null
  const resendWebhookUrl = `${baseUrl}/api/inbound-email/resend`
  const webhookUrl = provider === 'postmark' ? postmarkWebhookUrl : resendWebhookUrl

  async function submit() {
    if (provider === 'postmark' && !inboundAddress.trim()) {
      setError('Postmark inbound address is required.')
      return
    }
    if (provider === 'resend' && !rsDomain.trim()) {
      setError('Resend inbound domain is required.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const body: Record<string, string> = { fundId, provider }
      if (provider === 'postmark') {
        body.postmarkInboundAddress = inboundAddress
      } else {
        body.resendInboundDomain = rsDomain
        if (rsApiKey.trim()) body.resendApiKey = rsApiKey
        if (rsSecret.trim()) body.resendWebhookSecret = rsSecret
      }
      const res = await fetch('/api/onboarding/inbound-email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inbound email</CardTitle>
        <CardDescription>
          Give your fund an address that portfolio companies (or you) forward updates to. Each email
          is read and its metrics and highlights are filed against the right company.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <StepError error={error} />

        <div className="space-y-2">
          <Label>Email provider</Label>
          <div className="flex gap-2" role="radiogroup" aria-label="Email provider">
            <ChoiceTile
              selected={provider === 'postmark'}
              onClick={() => setProvider('postmark')}
              title="Postmark"
              description="Managed inbound address with webhook forwarding"
            />
            <ChoiceTile
              selected={provider === 'resend'}
              onClick={() => setProvider('resend')}
              title="Resend"
              description="Receive on your own domain"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Webhook base URL</Label>
          <Input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://your-app.vercel.app"
          />
          <p className="text-xs text-muted-foreground">
            For local development, use your ngrok or tunnel URL (e.g. https://abc123.ngrok.io).
          </p>
        </div>

        <div className="space-y-2">
          <Label>Your webhook URL</Label>
          {webhookUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted rounded-md px-3 py-2 text-xs break-all font-mono">
                {webhookUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
              >
                Copy
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your Postmark webhook URL is shown under Settings → Inbound email.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {provider === 'postmark' ? (
              <>
                In your{' '}
                <a
                  href="https://account.postmarkapp.com/servers"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Postmark server settings
                </a>
                , go to <strong>Inbound</strong> and paste this URL as the webhook endpoint.
              </>
            ) : (
              <>
                In Resend, go to <strong>Webhooks</strong> and add this URL for the{' '}
                <strong>email.received</strong> event.
              </>
            )}
          </p>
        </div>

        {provider === 'postmark' && (
          <div className="space-y-2">
            <Label htmlFor="inbound-address">Postmark inbound email address</Label>
            <Input
              id="inbound-address"
              type="email"
              placeholder="abc123@inbound.postmarkapp.com"
              value={inboundAddress}
              onChange={e => setInboundAddress(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Found on the same Inbound settings page. Share this with your portfolio founders.
            </p>
          </div>
        )}

        {provider === 'resend' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="rs-domain">Resend inbound domain</Label>
              <Input
                id="rs-domain"
                placeholder="inbound.yourdomain.com"
                value={rsDomain}
                onChange={e => setRsDomain(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The domain with receiving turned on in Resend. Mail to any address on it comes to your fund.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rs-api-key">Resend API key (optional)</Label>
              <Input
                id="rs-api-key"
                type="password"
                placeholder="re_..."
                value={rsApiKey}
                onChange={e => setRsApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A full-access key, so the app can read each received email. Or set RESEND_API_KEY on the deployment.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rs-secret">Webhook signing secret (optional)</Label>
              <Input
                id="rs-secret"
                type="password"
                placeholder="whsec_..."
                value={rsSecret}
                onChange={e => setRsSecret(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shown when you create the webhook in Resend. Or set RESEND_WEBHOOK_SECRET on the deployment. Mail is refused until one is set.
              </p>
            </div>
          </>
        )}

        <div className="space-y-2">
          <Button className="w-full" onClick={submit} disabled={saving || skipping}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</> : 'Next →'}
          </Button>
          <LaterButton
            busy={saving || skipping}
            onClick={async () => { setSkipping(true); await onSkip(); setSkipping(false) }}
          />
          <p className="text-xs text-muted-foreground text-center">
            Until this is set up, you can still add companies and metrics by hand or by import.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step: Authorized senders — optional
// ---------------------------------------------------------------------------

function SendersStep({
  fundId,
  onComplete,
  onSkip,
}: {
  fundId: string
  onComplete: () => void
  onSkip: () => Promise<void>
}) {
  const [senders, setSenders] = useState<Sender[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addSender() {
    if (!newEmail.trim()) return
    setSenders(prev => [...prev, { email: newEmail.trim(), label: newLabel.trim() }])
    setNewEmail('')
    setNewLabel('')
  }

  function removeSender(index: number) {
    setSenders(prev => prev.filter((_, i) => i !== index))
  }

  async function submit() {
    // An address typed but not yet added with "+" still counts.
    const pending = newEmail.trim() ? [{ email: newEmail.trim(), label: newLabel.trim() }] : []
    const valid = [...senders, ...pending].filter(s => s.email.trim())
    if (valid.length === 0) {
      setError('Add at least one authorized sender, or choose “Set up later”.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = await fetch('/api/onboarding/senders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fundId, senders: valid }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorized senders</CardTitle>
        <CardDescription>
          Whose emails are trusted. Only mail from these addresses is parsed; anything else is
          ignored. Add yourself, plus the founders and CFOs who send you reports.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <StepError error={error} />

        {/* Sender list */}
        {senders.length > 0 && (
          <div className="space-y-2">
            {senders.map((sender, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1 bg-muted rounded-md px-3 py-2 text-sm flex items-center justify-between">
                  <span>{sender.email}</span>
                  {sender.label && (
                    <Badge variant="secondary" className="ml-2 text-xs">
                      {sender.label}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSender(i)}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${sender.email}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add sender */}
        <div className="space-y-2">
          <Label>Add sender</Label>
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="cfo@portfolio.com"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSender()}
              className="flex-1"
            />
            <Input
              placeholder="Label (optional)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSender()}
              className="w-36"
            />
            <Button variant="outline" size="icon" onClick={addSender} disabled={!newEmail.trim()} aria-label="Add sender">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Button className="w-full" onClick={submit} disabled={saving || skipping}>
            {saving ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</>
            ) : (
              'Next →'
            )}
          </Button>
          <LaterButton
            busy={saving || skipping}
            onClick={async () => { setSkipping(true); await onSkip(); setSkipping(false) }}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step: Google Drive — optional, last
// ---------------------------------------------------------------------------

function DriveStep({
  googleConnected,
  onFinish,
}: {
  googleConnected: boolean
  onFinish: () => void
}) {
  const [configured, setConfigured] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)

  // Credential entry
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)

  // Check if credentials exist (DB or env)
  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => setConfigured(!!data.hasGoogleCredentials))
      .catch(() => setConfigured(false))
  }, [])

  async function saveCredentials() {
    if (!clientId.trim() || !clientSecret.trim()) return
    setSavingCreds(true)
    setConnectError(null)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleClientId: clientId.trim(),
        googleClientSecret: clientSecret.trim(),
      }),
    })
    setSavingCreds(false)
    if (res.ok) {
      setConfigured(true)
    } else {
      const data = await res.json().catch(() => ({}))
      setConnectError(data.error || 'Failed to save credentials')
    }
  }

  async function finish() {
    setFinishing(true)
    setConnectError(null)
    try {
      if (!googleConnected) await skipStep('drive')
      const res = await fetch('/api/onboarding/fund', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Could not finish setup')
      }
      onFinish()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Could not finish setup')
      setFinishing(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
        <CardDescription>
          Optional. Connect Google Drive to save email attachments and reports to a folder you
          choose. Without it, files are kept in the app&apos;s own storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {googleConnected ? (
          <div className="flex items-center gap-3 p-4 rounded-card border bg-muted/50">
            <CheckCircle2 className="h-6 w-6 text-success shrink-0" />
            <div>
              <p className="font-medium text-sm">Google Drive connected</p>
              <p className="text-xs text-muted-foreground">
                You can choose a specific folder in Settings after setup.
              </p>
            </div>
          </div>
        ) : !configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-4 rounded-card border border-dashed">
              <HardDrive className="h-6 w-6 text-muted-foreground shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-sm">Save reports to Google Drive</p>
                <p className="text-xs text-muted-foreground">
                  Enter your Google OAuth credentials to get started.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div>
                <Label htmlFor="google-client-id">Client ID</Label>
                <Input
                  id="google-client-id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="123456789.apps.googleusercontent.com"
                />
              </div>
              <div>
                <Label htmlFor="google-client-secret">Client secret</Label>
                <Input
                  id="google-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-..."
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Create credentials at{' '}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="underline">
                  Google Cloud Console
                </a>
                . Add <code className="text-[11px] bg-muted px-1 rounded-sm font-mono">{typeof window !== 'undefined' ? window.location.origin : ''}/api/auth/google/callback</code> as an authorized redirect URI.
              </p>
              <Button
                className="w-full"
                variant="outline"
                onClick={saveCredentials}
                disabled={savingCreds || !clientId.trim() || !clientSecret.trim()}
              >
                {savingCreds ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save credentials
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-4 rounded-card border border-dashed">
            <HardDrive className="h-6 w-6 text-muted-foreground shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-sm">Save reports to Google Drive</p>
              <p className="text-xs text-muted-foreground">
                Credentials configured. Connect your Google account to get started.
              </p>
            </div>
          </div>
        )}

        <StepError error={connectError} />

        <div className="space-y-2">
          {!googleConnected && configured && (
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                window.location.href = '/api/auth/google?return_to=/onboarding'
              }}
            >
              <HardDrive className="h-4 w-4 mr-2" />
              Connect Google Drive
            </Button>
          )}

          <Button className="w-full" onClick={finish} disabled={finishing}>
            {finishing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {googleConnected ? 'Finish setup' : 'Set up later and finish'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
