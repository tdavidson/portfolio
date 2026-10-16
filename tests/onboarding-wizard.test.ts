import { describe, expect, it } from 'vitest'
import {
  buildFeatureVisibility,
  claimableEmailDomain,
  deriveResumeStep,
  isPublicEmailDomain,
  needsFirstEntity,
  productsFromVisibility,
  stepsFor,
  type ResumeInput,
} from '@/lib/onboarding/wizard'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey } from '@/lib/types/features'
import { recommendedVisibilityForProduct } from '@/lib/access/products'

/**
 * The pure half of the first-run wizard: which features a product choice turns on, which email
 * domains a new fund may claim, and where a returning admin resumes.
 */

describe('buildFeatureVisibility', () => {
  it('writes every feature key, so the stale column default can never apply', () => {
    const fv = buildFeatureVisibility(['portfolio_reporting'])
    expect(Object.keys(fv).sort()).toEqual(Object.keys(DEFAULT_FEATURE_VISIBILITY).sort())
  })

  it('portfolio tracking alone matches Settings’ "Turn on" for that product and leaves the rest off', () => {
    const fv = buildFeatureVisibility(['portfolio_reporting'])
    expect(fv).toMatchObject(recommendedVisibilityForProduct('portfolio_reporting'))
    // The column DEFAULT from 20260306021914 had these on for everyone — the bug being fixed.
    expect(fv.lp_letters).toBe('off')
    for (const k of ['accounting', 'lps', 'lp_portal', 'deals', 'diligence', 'management_company'] as FeatureKey[]) {
      expect(fv[k]).toBe('off')
    }
  })

  it('an unchecked portfolio product is switched off, not left at the TS default', () => {
    const fv = buildFeatureVisibility(['fund_operations'])
    expect(fv.investments).toBe('off')
    expect(fv.imports).toBe('off')
    expect(fv.accounting).toBe('admin')
    expect(fv.gp_economics).toBe('admin')
    expect(fv.tax_reporting).toBe('admin')
  })

  it('fund books do not switch on the management company; its own box does', () => {
    expect(buildFeatureVisibility(['fund_operations']).management_company).toBe('off')
    expect(buildFeatureVisibility(['management_company']).management_company).toBe('admin')
    expect(buildFeatureVisibility(['management_company']).accounting).toBe('off')
  })

  it('round-trips through productsFromVisibility', () => {
    const chosen = ['portfolio_reporting', 'lp_reporting', 'investment_workflow', 'management_company'] as const
    expect(productsFromVisibility(buildFeatureVisibility([...chosen])).sort()).toEqual([...chosen].sort())
  })
})

describe('needsFirstEntity / stepsFor', () => {
  it('asks for an entity only when a product keeps per-entity data', () => {
    expect(needsFirstEntity(['portfolio_reporting', 'investment_workflow'])).toBe(false)
    expect(needsFirstEntity(['fund_operations'])).toBe(true)
    expect(needsFirstEntity(['lp_reporting'])).toBe(true)
    expect(needsFirstEntity(['management_company'])).toBe(true)
  })

  it('shows inbound email and senders only with portfolio tracking', () => {
    expect(stepsFor(['portfolio_reporting'])).toEqual(['fund', 'products', 'inbound', 'senders', 'drive'])
    expect(stepsFor(['fund_operations'])).toEqual(['fund', 'products', 'drive'])
  })
})

describe('public email domains', () => {
  it.each(['gmail.com', 'GoogleMail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.fr', 'icloud.com', 'proton.me', 'gmx.de', 'gmx.at'])(
    '%s is a consumer mailbox',
    d => expect(isPublicEmailDomain(d)).toBe(true),
  )

  it.each(['acme.vc', 'acmecapital.com', 'gmailx.com', 'mail.acme.com'])('%s is an organisation', d => {
    expect(isPublicEmailDomain(d)).toBe(false)
  })

  it('a new fund claims its creator’s domain only when it is an organisation’s', () => {
    expect(claimableEmailDomain('someone@gmail.com')).toBeNull()
    expect(claimableEmailDomain('Partner@Acme.VC')).toBe('acme.vc')
    expect(claimableEmailDomain(undefined)).toBeNull()
  })
})

describe('deriveResumeStep', () => {
  const base: ResumeInput = {
    isAdmin: true,
    onboarding: {},
    featureVisibility: buildFeatureVisibility(['portfolio_reporting']),
    inboundConfigured: false,
    senderCount: 0,
  }

  it('a member who joined is never put through setup', () => {
    expect(deriveResumeStep({ ...base, isAdmin: false })).toBe('complete')
  })

  it('right after step 1 the products question is next', () => {
    expect(deriveResumeStep(base)).toBe('products')
  })

  it('walks inbound → senders → drive, honouring skips', () => {
    const answered = { products: ['portfolio_reporting' as const] }
    expect(deriveResumeStep({ ...base, onboarding: answered })).toBe('inbound')
    expect(deriveResumeStep({ ...base, onboarding: answered, inboundConfigured: true })).toBe('senders')
    expect(deriveResumeStep({ ...base, onboarding: { ...answered, skipped: ['inbound'] } })).toBe('senders')
    expect(deriveResumeStep({ ...base, onboarding: { ...answered, skipped: ['inbound', 'senders'] } })).toBe('drive')
    expect(deriveResumeStep({ ...base, onboarding: answered, inboundConfigured: true, senderCount: 2 })).toBe('drive')
  })

  it('skips inbound and senders entirely when portfolio tracking is off', () => {
    expect(deriveResumeStep({
      ...base,
      onboarding: { products: ['fund_operations'] },
      featureVisibility: buildFeatureVisibility(['fund_operations']),
    })).toBe('drive')
  })

  it('Finish ends it', () => {
    expect(deriveResumeStep({ ...base, onboarding: { products: ['portfolio_reporting'], completed_at: '2026-10-11T00:00:00Z' } }))
      .toBe('complete')
  })

  it('a fund onboarded by the old wizard (no record, inbound + senders) is complete', () => {
    expect(deriveResumeStep({ ...base, onboarding: null, featureVisibility: null, inboundConfigured: true, senderCount: 1 }))
      .toBe('complete')
  })
})
