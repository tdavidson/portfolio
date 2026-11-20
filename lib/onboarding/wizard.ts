/**
 * First-run wizard (app/onboarding) — the parts that are pure and shared by the page and its API.
 *
 * Deliberately dependency-light (no `next/server`, no Supabase) so the client page can import the
 * product list and step order without dragging server code into the browser bundle. The server half
 * — decrypting the webhook token, creating the first entity, persisting progress — is
 * lib/onboarding/wizard-server.ts.
 */
import { parseSkippedSteps, type StepKey } from '@/lib/onboarding/progress'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey, type FeatureVisibilityMap } from '@/lib/types/features'
import {
  PRODUCT_META,
  disabledVisibilityForProduct,
  isProductActive,
  recommendedVisibilityForProduct,
} from '@/lib/access/products'

// ---------------------------------------------------------------------------
// Products offered on the "What will you run here?" step
// ---------------------------------------------------------------------------

/**
 * What the wizard offers. Four of these ARE the Settings products (lib/access/products.ts) and turn
 * on exactly what Settings' "Turn on" button does. The fifth, `management_company`, is carved out of
 * Fund Operations: it backs a domain of its own (firm payroll and partner comp, not derivable from
 * the fund's books), and most people starting a fund do not want a manco ledger in the nav, so the
 * wizard asks separately instead of switching it on with the fund's books.
 */
export type WizardProduct =
  | 'portfolio_reporting'
  | 'fund_operations'
  | 'lp_reporting'
  | 'investment_workflow'
  | 'management_company'

export const WIZARD_PRODUCTS: { key: WizardProduct; label: string; description: string; defaultOn: boolean }[] = [
  {
    key: 'portfolio_reporting',
    label: 'Portfolio tracking',
    description: 'Company updates by email, metrics, dashboards, asks and notes.',
    defaultOn: true,
  },
  {
    key: 'fund_operations',
    label: 'Fund books',
    description: 'A ledger per fund entity, GP economics and carry, tax reporting and compliance.',
    defaultOn: false,
  },
  {
    key: 'lp_reporting',
    label: 'LP capital & investor portal',
    description: 'Partners’ capital accounts, LP letters, and a portal where LPs sign in.',
    defaultOn: false,
  },
  {
    key: 'investment_workflow',
    label: 'Deal flow & diligence',
    description: 'Inbound deal intake, diligence checklists, research and memo drafting.',
    defaultOn: false,
  },
  {
    key: 'management_company',
    label: 'Management company books',
    description: 'The firm’s own ledger: management fees in, payroll and costs out.',
    defaultOn: false,
  },
]

const WIZARD_PRODUCT_KEYS = new Set<string>(WIZARD_PRODUCTS.map(p => p.key))

export function isWizardProduct(v: unknown): v is WizardProduct {
  return typeof v === 'string' && WIZARD_PRODUCT_KEYS.has(v)
}

/** The products whose data lives on a fund entity (fund_vehicles), so the wizard asks for the first one. */
export function needsFirstEntity(products: readonly WizardProduct[]): boolean {
  return products.some(p => p === 'fund_operations' || p === 'lp_reporting' || p === 'management_company')
}

/**
 * The complete feature_visibility map for a set of chosen products.
 *
 * Always EVERY FeatureKey, explicitly. A fund whose row carries no value for a key reads the column
 * DEFAULT from 20260306021914_feature_visibility.sql, which predates most of these switches and has
 * interactions/notes/lp_letters on for everyone — the opposite of DEFAULT_FEATURE_VISIBILITY. Writing
 * the whole map is what stops that stale default from deciding a new fund's access.
 *
 * Chosen products get `recommendedVisibilityForProduct` (what Settings' "Turn on" writes: the TS
 * default, with off defaults raised to `admin`); unchosen ones get `off`.
 */
export function buildFeatureVisibility(products: readonly WizardProduct[]): FeatureVisibilityMap {
  const chosen = new Set(products)
  const out: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY }
  const apply = (m: Partial<FeatureVisibilityMap>) => Object.assign(out, m)

  apply(chosen.has('portfolio_reporting')
    ? recommendedVisibilityForProduct('portfolio_reporting')
    : disabledVisibilityForProduct('portfolio_reporting'))
  apply(chosen.has('investment_workflow')
    ? recommendedVisibilityForProduct('investment_workflow')
    : disabledVisibilityForProduct('investment_workflow'))
  apply(chosen.has('lp_reporting')
    ? recommendedVisibilityForProduct('lp_reporting')
    : disabledVisibilityForProduct('lp_reporting'))
  apply(chosen.has('fund_operations')
    ? recommendedVisibilityForProduct('fund_operations')
    : disabledVisibilityForProduct('fund_operations'))
  // The carve-out: management_company follows its own checkbox, not Fund Operations'.
  out.management_company = chosen.has('management_company') ? 'admin' : 'off'
  return out
}

/** The wizard products a stored feature_visibility map has switched on (inverse of the builder). */
export function productsFromVisibility(fv: Partial<FeatureVisibilityMap> | null | undefined): WizardProduct[] {
  const merged = { ...DEFAULT_FEATURE_VISIBILITY, ...(fv ?? {}) } as FeatureVisibilityMap
  const on = (k: FeatureKey) => merged[k] !== 'off' && merged[k] !== 'hidden'
  const out: WizardProduct[] = []
  if (isProductActive('portfolio_reporting', merged)) out.push('portfolio_reporting')
  if (PRODUCT_META.fund_operations.features.filter(f => f !== 'management_company').some(on)) out.push('fund_operations')
  if (isProductActive('lp_reporting', merged)) out.push('lp_reporting')
  if (isProductActive('investment_workflow', merged)) out.push('investment_workflow')
  if (on('management_company')) out.push('management_company')
  return out
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

export type WizardAIProvider = 'anthropic' | 'openai' | 'openrouter'

/** Same column names and provider ids /api/settings writes. */
export const AI_PROVIDER_COLUMN: Record<WizardAIProvider, string> = {
  anthropic: 'claude_api_key_encrypted',
  openai: 'openai_api_key_encrypted',
  openrouter: 'openrouter_api_key_encrypted',
}

export function isWizardAIProvider(v: unknown): v is WizardAIProvider {
  return v === 'anthropic' || v === 'openai' || v === 'openrouter'
}

// ---------------------------------------------------------------------------
// Public email providers
// ---------------------------------------------------------------------------

/**
 * Consumer mailbox domains. A fund created by someone at gmail.com must not claim gmail.com, or every
 * other Gmail user who signs up is offered "Request to join" a stranger's fund (and the stranger's
 * admin gets their join requests). Organisation domains only.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'mail.com',
  'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tuta.io',
  'qq.com', '163.com', '126.com', 'naver.com', 'hanmail.net',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'btinternet.com',
])

/** Country variants: gmx.at, yahoo.co.uk, hotmail.fr, outlook.de, live.co.uk … */
const PUBLIC_EMAIL_FAMILIES = /^(gmx|yahoo|hotmail|outlook|live|googlemail|aol|yandex)\.[a-z.]{2,6}$/

export function isPublicEmailDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? '').trim().toLowerCase()
  if (!d) return false
  return PUBLIC_EMAIL_DOMAINS.has(d) || PUBLIC_EMAIL_FAMILIES.test(d)
}

/** The domain a fund may claim for "Request to join" matching, or null for a consumer mailbox. */
export function claimableEmailDomain(email: string | null | undefined): string | null {
  const domain = email?.split('@')[1]?.trim().toLowerCase() || null
  if (!domain || isPublicEmailDomain(domain)) return null
  return domain
}

// ---------------------------------------------------------------------------
// Steps and resume
// ---------------------------------------------------------------------------

export type WizardStep = 'fund' | 'products' | 'inbound' | 'senders' | 'drive'
export type SkippableStep = 'inbound' | 'senders' | 'drive'

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  fund: 'Your fund',
  products: 'Products',
  inbound: 'Inbound email',
  senders: 'Senders',
  drive: 'Google Drive',
}

/** The steps shown for a set of products, in order. Inbound and senders only matter to portfolio tracking. */
export function stepsFor(products: readonly WizardProduct[]): WizardStep[] {
  return products.includes('portfolio_reporting')
    ? ['fund', 'products', 'inbound', 'senders', 'drive']
    : ['fund', 'products', 'drive']
}

/** What fund_settings.onboarding holds (20261011400000_fund_settings_onboarding.sql). */
export interface OnboardingRecord {
  products?: WizardProduct[]
  /** Wizard steps skipped (the first-run setup wizard, not the Getting started checklist). */
  skipped?: SkippableStep[]
  /** Getting started checklist steps the fund skipped (lib/onboarding/progress.ts). */
  checklist_skipped?: StepKey[]
  completed_at?: string
}

export function parseOnboardingRecord(raw: unknown): OnboardingRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: OnboardingRecord = {}
  if (Array.isArray(r.products)) out.products = r.products.filter(isWizardProduct)
  if (Array.isArray(r.skipped)) {
    out.skipped = r.skipped.filter((s): s is SkippableStep => s === 'inbound' || s === 'senders' || s === 'drive')
  }
  if (Array.isArray(r.checklist_skipped)) out.checklist_skipped = parseSkippedSteps(r)
  if (typeof r.completed_at === 'string') out.completed_at = r.completed_at
  return out
}

export interface ResumeInput {
  isAdmin: boolean
  /** fund_settings.onboarding — null when the column is missing (migration not yet applied) or empty. */
  onboarding: OnboardingRecord | null
  featureVisibility: Partial<FeatureVisibilityMap> | null | undefined
  inboundConfigured: boolean
  senderCount: number
}

/**
 * Where a returning admin resumes. Derived from what is actually configured wherever possible; the
 * `onboarding` record only adds what cannot be derived — which products step was answered, which
 * optional steps were deliberately skipped, and that the person pressed Finish.
 */
export function deriveResumeStep(input: ResumeInput): WizardStep | 'complete' {
  if (!input.isAdmin) return 'complete'
  const rec = input.onboarding
  const hasRecord = !!rec && (!!rec.products || !!rec.skipped?.length || !!rec.completed_at)
  if (rec?.completed_at) return 'complete'
  // A fund onboarded before this wizard existed: the old wizard's definition of done.
  if (!hasRecord && input.inboundConfigured && input.senderCount > 0) return 'complete'
  if (!rec?.products) return 'products'

  const skipped = new Set(rec.skipped ?? [])
  const products = productsFromVisibility(input.featureVisibility)
  if (products.includes('portfolio_reporting')) {
    if (!input.inboundConfigured && !skipped.has('inbound')) return 'inbound'
    if (input.senderCount === 0 && !skipped.has('senders')) return 'senders'
  }
  return 'drive'
}
