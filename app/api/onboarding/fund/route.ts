import { NextRequest, NextResponse } from 'next/server'
import { hasAnyAIKeyFrom } from '@/lib/credentials/env'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt, encrypt } from '@/lib/crypto'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { randomBytes } from 'crypto'
import {
  AI_PROVIDER_COLUMN,
  buildFeatureVisibility,
  claimableEmailDomain,
  deriveResumeStep,
  isWizardAIProvider,
  isWizardProduct,
  needsFirstEntity,
  parseOnboardingRecord,
  productsFromVisibility,
  type SkippableStep,
  type WizardAIProvider,
  type WizardProduct,
} from '@/lib/onboarding/wizard'
import {
  createFirstEntity,
  isMissingOnboardingColumn,
  parseFirstEntity,
  patchOnboardingRecord,
  readWebhookToken,
  stillOnboarding,
} from '@/lib/onboarding/wizard-server'
import type { FeatureVisibilityMap } from '@/lib/types/features'
import { createFund, newSettingsRow } from '@/lib/onboarding/create-fund'

// This route is UNGATED in lib/access/route-domains.ts — the caller of POST has no fund yet, so
// there is no grant to check. Every branch that touches an existing fund therefore checks the
// `admin` role itself, here, before reading a credential or writing a setting.

// GET — onboarding status so the UI can resume where the user left off
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ step: 'fund', fundId: null, webhookToken: null })
  }

  const fundId = membership.fund_id
  // A member who joined an existing fund is already onboarded. Do not expose fund-wide setup
  // credentials or invite them into administrator-only integration configuration.
  if (membership.role !== 'admin') {
    return NextResponse.json({ step: 'complete', fundId, webhookToken: null })
  }

  // select('*') so a column added by a pending migration (`onboarding`) reads as undefined rather
  // than failing the whole select — see the note in app/api/settings/route.ts.
  const [{ data: settings }, { data: fund }, { count: senderCount }] = await Promise.all([
    (admin as any).from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle(),
    admin.from('funds').select('name').eq('id', fundId).maybeSingle(),
    admin.from('authorized_senders').select('id', { count: 'exact', head: true }).eq('fund_id', fundId),
  ])

  if (!settings) {
    // The fund row exists without settings (a failed half-create). Step 1 repairs it.
    return NextResponse.json({ step: 'fund', fundId, fundName: fund?.name ?? null, webhookToken: null })
  }

  // Step "inbound" is complete if either Postmark or Mailgun inbound is configured
  const inboundConfigured = !!(
    (settings.inbound_email_provider === 'postmark' && settings.postmark_inbound_address) ||
    (settings.inbound_email_provider === 'mailgun' && settings.mailgun_inbound_domain) ||
    // Legacy: postmark address set without explicit provider
    (!settings.inbound_email_provider && settings.postmark_inbound_address)
  )

  const featureVisibility = settings.feature_visibility as Partial<FeatureVisibilityMap> | null
  const step = deriveResumeStep({
    isAdmin: true,
    onboarding: parseOnboardingRecord(settings.onboarding),
    featureVisibility,
    inboundConfigured,
    senderCount: senderCount ?? 0,
  })

  return NextResponse.json({
    step,
    fundId,
    fundName: fund?.name ?? null,
    webhookToken: readWebhookToken(settings),
    products: productsFromVisibility(featureVisibility),
    hasAIKey: hasAnyAIKeyFrom(settings),
    aiMode: settings.ai_mode ?? null,
  })
}

/**
 * "Use my own assistant" in step 1: record the no-key choice (lib/ai/capabilities.ts). A separate,
 * best-effort update rather than part of the settings insert, so a database still missing the
 * `ai_mode` migration only loses the choice (the checklist asks again) instead of the whole fund.
 */
async function recordAIMode(admin: ReturnType<typeof createAdminClient>, fundId: string, body: Record<string, unknown>, ai: unknown) {
  if (body.aiMode !== 'assistant' || ai) return
  const { error } = await (admin as any).from('fund_settings').update({ ai_mode: 'assistant' }).eq('fund_id', fundId)
  if (error) console.warn('[onboarding] could not record ai_mode:', error.message)
}

/** Body of POST: step 1. `claudeApiKey` is the pre-provider-choice field, still accepted. */
function readAIKey(body: Record<string, unknown>): { provider: WizardAIProvider; key: string } | null | { error: string } {
  const legacy = typeof body.claudeApiKey === 'string' ? body.claudeApiKey.trim() : ''
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : legacy
  if (!key) return null
  const provider = body.aiProvider === undefined || body.aiProvider === null
    ? 'anthropic'
    : body.aiProvider
  if (!isWizardAIProvider(provider)) return { error: 'Invalid AI provider' }
  return { provider, key }
}

// POST — step 1: create the fund (idempotent: an admin who already has one updates it instead)
export async function POST(req: NextRequest) {
  // Rate limit: 5 requests per 5 minutes per IP
  const limited = await rateLimit({ key: `onboard-fund:${getClientIp(req)}`, limit: 5, windowSeconds: 300 })
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const fundName = typeof body.fundName === 'string' ? body.fundName.trim() : ''
  if (!fundName) {
    return NextResponse.json({ error: 'Fund name is required' }, { status: 400 })
  }
  if (fundName.length > 200) {
    return NextResponse.json({ error: 'Fund name is too long' }, { status: 400 })
  }
  // The AI key is optional: "Use my own assistant" (aiMode) or "Skip — decide later".
  const ai = readAIKey(body)
  if (ai && 'error' in ai) return NextResponse.json({ error: ai.error }, { status: 400 })

  const kek = process.env.ENCRYPTION_KEY
  const admin = createAdminClient()

  // Check if user already has a fund — return it instead of creating a duplicate
  const { data: existing } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (existing) {
    if (existing.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    if (!kek) {
      return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })
    }
    const { data: settings, error: settingsError } = await (admin as any)
      .from('fund_settings')
      .select('*')
      .eq('fund_id', existing.fund_id)
      .maybeSingle()
    if (settingsError) {
      return NextResponse.json({ error: 'Fund settings not found' }, { status: 500 })
    }
    if (!settings) {
      // A half-created fund (the settings insert failed after the fund row landed): finish it.
      const fresh = newSettingsRow(existing.fund_id, kek, ai)
      const [{ error: fundError }, { error: insertError }] = await Promise.all([
        admin.from('funds').update({ name: fundName }).eq('id', existing.fund_id),
        (admin as any).from('fund_settings').insert(fresh.row),
      ])
      if (fundError || insertError) {
        return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
      }
      await recordAIMode(admin, existing.fund_id, body, ai)
      return NextResponse.json({ fundId: existing.fund_id, webhookToken: fresh.webhookToken })
    }

    const updates: Record<string, unknown> = {}
    if (ai) {
      // Reuse the existing DEK. Rotating it while rewriting only the AI key would permanently
      // orphan every other integration credential encrypted with the previous key.
      let dek: string
      let encryptionKeyEncrypted = settings.encryption_key_encrypted as string | null
      try {
        if (encryptionKeyEncrypted) {
          dek = decrypt(encryptionKeyEncrypted, kek)
        } else {
          dek = randomBytes(32).toString('hex')
          encryptionKeyEncrypted = encrypt(dek, kek)
        }
      } catch {
        return NextResponse.json({ error: 'Existing fund encryption key is invalid' }, { status: 500 })
      }
      updates[AI_PROVIDER_COLUMN[ai.provider]] = encrypt(ai.key, dek)
      updates.default_ai_provider = ai.provider
      updates.encryption_key_encrypted = encryptionKeyEncrypted
    }

    const [{ error: fundError }, { error: updateError }] = await Promise.all([
      admin.from('funds').update({ name: fundName }).eq('id', existing.fund_id),
      Object.keys(updates).length > 0
        ? (admin as any).from('fund_settings').update(updates).eq('fund_id', existing.fund_id)
        : Promise.resolve({ error: null }),
    ])
    if (fundError || updateError) {
      return NextResponse.json({ error: 'Failed to update fund settings' }, { status: 500 })
    }

    await recordAIMode(admin, existing.fund_id, body, ai)
    return NextResponse.json({
      fundId: existing.fund_id,
      webhookToken: readWebhookToken(settings),
    })
  }

  const created = await createFund(admin as any, { userId: user.id, email: user.email, fundName, ai })
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
  await recordAIMode(admin, created.fundId, body, ai)
  return NextResponse.json({ fundId: created.fundId, webhookToken: created.webhookToken })
}

// PATCH — the later wizard steps that have no settings route of their own:
//   { action: 'products', products: WizardProduct[], entity?: { name, kind, vintageYear } }
//   { action: 'skip', step: 'inbound' | 'senders' | 'drive' }
//   { action: 'finish' }
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  if (membership.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const fundId = membership.fund_id as string

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  if (body.action === 'products') {
    if (!Array.isArray(body.products) || !body.products.every(isWizardProduct)) {
      return NextResponse.json({ error: 'Invalid products' }, { status: 400 })
    }
    const products = Array.from(new Set(body.products as WizardProduct[]))

    // Validate the entity before writing anything, so a bad vintage year doesn't half-apply.
    let entity: ReturnType<typeof parseFirstEntity> | null = null
    if (needsFirstEntity(products) && body.entity !== undefined && body.entity !== null) {
      entity = parseFirstEntity(body.entity)
      if ('error' in entity) return NextResponse.json({ error: entity.error }, { status: 400 })
      if (entity.kind === 'manco' && !products.includes('management_company')) {
        return NextResponse.json({ error: 'Turn on management company books to create a management company' }, { status: 400 })
      }
    }

    const featureVisibility = buildFeatureVisibility(products)
    const { data: current } = await (admin as any)
      .from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
    if (!current) return NextResponse.json({ error: 'Fund settings not found' }, { status: 500 })

    // This writes the WHOLE feature map, so it is for a fund still in the wizard only. A fund that
    // finished it (or predates it, or already holds data) changes products in Settings, where turning
    // one on doesn't switch every other one off.
    if (!(await stillOnboarding(admin as any, fundId, current))) {
      return NextResponse.json({ error: 'This fund is already set up. Turn products on or off in Settings.' }, { status: 409 })
    }

    const update: Record<string, unknown> = { feature_visibility: featureVisibility }
    if ('onboarding' in current) {
      update.onboarding = { ...(parseOnboardingRecord(current.onboarding) ?? {}), products }
    }
    let { error } = await (admin as any).from('fund_settings').update(update).eq('fund_id', fundId)
    if (error && 'onboarding' in update && isMissingOnboardingColumn(error)) {
      delete update.onboarding
      ;({ error } = await (admin as any).from('fund_settings').update(update).eq('fund_id', fundId))
    }
    if (error) return NextResponse.json({ error: 'Failed to save products' }, { status: 500 })

    let entityId: string | null = null
    if (entity && !('error' in entity)) {
      const created = await createFirstEntity(admin as any, fundId, entity)
      if (!created.ok) return NextResponse.json({ error: created.error }, { status: 500 })
      entityId = created.id
    }

    return NextResponse.json({ ok: true, products, featureVisibility, entityId })
  }

  if (body.action === 'skip') {
    const step = body.step
    if (step !== 'inbound' && step !== 'senders' && step !== 'drive') {
      return NextResponse.json({ error: 'Invalid step' }, { status: 400 })
    }
    const res = await patchOnboardingRecord(admin as any, fundId, rec => ({
      ...rec,
      skipped: Array.from(new Set([...(rec.skipped ?? []), step as SkippableStep])),
    }))
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ ok: true, persisted: res.persisted })
  }

  if (body.action === 'finish') {
    const res = await patchOnboardingRecord(admin as any, fundId, rec => ({
      ...rec,
      completed_at: rec.completed_at ?? new Date().toISOString(),
    }))
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ ok: true, persisted: res.persisted })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
