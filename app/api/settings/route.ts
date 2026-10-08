import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { APP_VERSION } from '@/lib/version'
import { getUpdateAvailable } from '@/lib/cache/layout'
import { encrypt } from '@/lib/crypto'
import { randomBytes } from 'crypto'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import { forgetFundCurrency } from '@/lib/accounting/currency'
import { isLotMethod, LOT_METHODS } from '@/lib/portfolio/lots'
import { validateOllamaUrl } from '@/lib/validate-url'
import type { FeatureKey, FeatureVisibility, FeatureVisibilityMap } from '@/lib/types/features'
import { AUTH_TITLE_MAX } from '@/lib/auth-brand-shared'

// GET — returns fund settings (safe fields only)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role, display_name')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 404 })

  // `select('*')`, deliberately, rather than naming the ~45 columns this route serves.
  //
  // Postgres rejects a SELECT that names one column it doesn't have (42703), and
  // supabase-js reports that as `{ data: null }` without throwing — so with an explicit
  // column list, a single unapplied migration made EVERY field on the settings page fall
  // through to its `?? default`. A configured Claude key read as "no key configured", the
  // inbound-email provider as "None (disabled)", Google Drive as "None (database only)",
  // and `feature_visibility` as the defaults — all while the row sat intact in the table,
  // one Save away from being overwritten with those blanks. (That was `lot_method`, from
  // 20260822000001_income_and_lot_basis.sql, on a database that hadn't run it.)
  //
  // A star select can't fail that way: it returns whatever columns exist, so a column
  // added by a pending migration is simply `undefined` and degrades to its own default,
  // leaving every other setting correct. The response below is still an explicit
  // allowlist — nothing reaches the client just because it's in the table — so the cost
  // is a few unread columns on the wire, which is the right trade for a settings page
  // that can't silently blank itself. Anything genuinely secret is stored encrypted and
  // exposed here only as a `!!has…` boolean, as before.
  const [{ data: fund }, { data: settings }, { data: senders }] = await Promise.all([
    admin.from('funds').select('id, name, logo_url, address').eq('id', membership.fund_id).single(),
    (admin as any).from('fund_settings').select('*').eq('fund_id', membership.fund_id).maybeSingle(),
    admin.from('authorized_senders').select('id, email, label, created_at').eq('fund_id', membership.fund_id).order('email'),
  ])

  // Decrypt webhook token if encrypted; fall back to plaintext for legacy
  let webhookToken = ''
  if (membership.role === 'admin' && settings) {
    if (settings.postmark_webhook_token_encrypted && settings.encryption_key_encrypted) {
      try {
        const kek = process.env.ENCRYPTION_KEY
        if (kek) {
          const { decrypt } = await import('@/lib/crypto')
          const dek = decrypt(settings.encryption_key_encrypted, kek)
          webhookToken = decrypt(settings.postmark_webhook_token_encrypted, dek)
        }
      } catch {
        webhookToken = settings.postmark_webhook_token ?? ''
      }
    } else {
      webhookToken = settings.postmark_webhook_token ?? ''
    }
  }

  return NextResponse.json({
    fundId: fund?.id,
    fundName: fund?.name,
    fundLogo: fund?.logo_url ?? null,
    fundAddress: fund?.address ?? null,
    // Ship in 20261005120000_sign_in_branding.sql; absent, they read as unset.
    signInLogo: settings?.sign_in_logo ?? null,
    signInTitle: settings?.sign_in_title ?? null,
    postmarkInboundAddress: settings?.postmark_inbound_address ?? '',
    postmarkWebhookToken: webhookToken,
    hasClaudeKey: !!settings?.claude_api_key_encrypted,
    claudeModel: settings?.claude_model ?? 'claude-sonnet-4-6',
    hasOpenAIKey: !!settings?.openai_api_key_encrypted,
    openaiModel: settings?.openai_model ?? 'gpt-4o',
    defaultAIProvider: settings?.default_ai_provider ?? 'anthropic',
    hasOpenRouterKey: !!settings?.openrouter_api_key_encrypted,
    openrouterModel: settings?.openrouter_model ?? '',
    openrouterBaseUrl: settings?.openrouter_base_url ?? '',
    retainResolvedReviews: settings?.retain_resolved_reviews ?? true,
    resolvedReviewsTtlDays: settings?.resolved_reviews_ttl_days ?? null,
    senders: senders ?? [],
    googleDriveConnected: !!settings?.google_refresh_token_encrypted,
    googleDriveFolderId: settings?.google_drive_folder_id ?? null,
    googleDriveFolderName: settings?.google_drive_folder_name ?? null,
    hasGoogleCredentials: !!(settings?.google_client_id && settings?.google_client_secret_encrypted),
    googleClientId: settings?.google_client_id ?? '',
    aiSummaryPrompt: settings?.ai_summary_prompt ?? null,
    outboundEmailProvider: settings?.outbound_email_provider ?? null,
    asksEmailProvider: settings?.asks_email_provider ?? null,
    approvalEmailSubject: settings?.approval_email_subject ?? null,
    approvalEmailBody: settings?.approval_email_body ?? null,
    systemEmailFromName: settings?.system_email_from_name ?? null,
    systemEmailFromAddress: settings?.system_email_from_address ?? null,
    hasResendKey: !!settings?.resend_api_key_encrypted,
    hasPostmarkServerToken: !!settings?.postmark_server_token_encrypted,
    inboundEmailProvider: settings?.inbound_email_provider ?? null,
    mailgunInboundDomain: settings?.mailgun_inbound_domain ?? '',
    hasMailgunSigningKey: !!settings?.mailgun_signing_key_encrypted,
    hasMailgunApiKey: !!settings?.mailgun_api_key_encrypted,
    mailgunSendingDomain: settings?.mailgun_sending_domain ?? '',
    fileStorageProvider: settings?.file_storage_provider ?? null,
    analyticsFathomSiteId: settings?.analytics_fathom_site_id ?? null,
    analyticsGaMeasurementId: settings?.analytics_ga_measurement_id ?? null,
    currency: settings?.currency ?? 'USD',
    lotMethod: settings?.lot_method ?? 'fifo',
    disableUserTracking: settings?.disable_user_tracking ?? false,
    featureVisibility: { ...DEFAULT_FEATURE_VISIBILITY, ...(settings?.feature_visibility as Partial<FeatureVisibilityMap> | null) },
    dealThesis: settings?.deal_thesis ?? null,
    dealScreeningPrompt: settings?.deal_screening_prompt ?? null,
    dealIntakeEnabled: settings?.deal_intake_enabled ?? false,
    dealsDefaultVehicleId: settings?.deals_default_vehicle_id ?? null,
    // Only the hash is stored, so the token itself can't be shown after minting — expose whether
    // one is active; the plaintext URL is surfaced once, from the mint response.
    hasSubmissionToken: !!settings?.deal_submission_token,
    lpPortalEnabled: settings?.lp_portal_enabled ?? false,
    // Both ship in later migrations; absent, they read as off — see the star select above.
    affinityMcpEnabled: !!settings?.affinity_mcp_enabled,
    agentApiEnabled: !!settings?.agent_api_enabled,
    displayName: membership.display_name ?? '',
    isAdmin: membership.role === 'admin',
    userId: user.id,
    appVersion: APP_VERSION,
    updateAvailable: membership.role === 'admin' ? await getUpdateAvailable() : false,
  })
}

// PATCH — update fund settings
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 404 })

  const body = await req.json()
  const { fundName, fundLogo, fundAddress, signInLogo, signInTitle, postmarkInboundAddress, claudeApiKey, claudeModel, retainResolvedReviews, resolvedReviewsTtlDays, googleClientId, googleClientSecret, aiSummaryPrompt, displayName, outboundEmailProvider, asksEmailProvider, approvalEmailSubject, approvalEmailBody, systemEmailFromName, systemEmailFromAddress, resendApiKey, postmarkServerToken, inboundEmailProvider, mailgunInboundDomain, mailgunSigningKey, mailgunApiKey, mailgunSendingDomain, fileStorageProvider, openaiApiKey, openaiModel, defaultAIProvider, openrouterApiKey, openrouterModel, openrouterBaseUrl, analyticsFathomSiteId, analyticsGaMeasurementId, analyticsCustomHeadScript, currency, lotMethod, disableUserTracking, featureVisibility, dealThesis, dealScreeningPrompt, dealIntakeEnabled, dealsDefaultVehicleId, lpPortalEnabled, affinityMcpEnabled, agentApiEnabled } = body

  // Update display name on fund_members (any user can do this)
  if (displayName !== undefined) {
    await admin.from('fund_members').update({ display_name: displayName?.trim() || null }).eq('fund_id', membership.fund_id).eq('user_id', user.id)
  }

  // All other settings require admin role
  const hasAdminFields = fundName !== undefined || fundLogo !== undefined || fundAddress !== undefined ||
    signInLogo !== undefined || signInTitle !== undefined || postmarkInboundAddress !== undefined ||
    claudeApiKey !== undefined || claudeModel !== undefined || retainResolvedReviews !== undefined ||
    resolvedReviewsTtlDays !== undefined || googleClientId !== undefined || googleClientSecret !== undefined ||
    aiSummaryPrompt !== undefined || outboundEmailProvider !== undefined || asksEmailProvider !== undefined ||
    approvalEmailSubject !== undefined || approvalEmailBody !== undefined ||
    systemEmailFromName !== undefined || systemEmailFromAddress !== undefined || resendApiKey !== undefined ||
    postmarkServerToken !== undefined || inboundEmailProvider !== undefined || mailgunInboundDomain !== undefined ||
    mailgunSigningKey !== undefined || mailgunApiKey !== undefined || mailgunSendingDomain !== undefined ||
    fileStorageProvider !== undefined ||
    openaiApiKey !== undefined || openaiModel !== undefined || defaultAIProvider !== undefined ||
    openrouterApiKey !== undefined || openrouterModel !== undefined || openrouterBaseUrl !== undefined ||
    analyticsFathomSiteId !== undefined || analyticsGaMeasurementId !== undefined ||
    analyticsCustomHeadScript !== undefined || currency !== undefined || lotMethod !== undefined ||
    disableUserTracking !== undefined || featureVisibility !== undefined ||
    dealThesis !== undefined || dealScreeningPrompt !== undefined ||
    dealIntakeEnabled !== undefined || dealsDefaultVehicleId !== undefined || lpPortalEnabled !== undefined || affinityMcpEnabled !== undefined ||
    agentApiEnabled !== undefined

  if (hasAdminFields && membership.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Update fund name
  if (fundName !== undefined) {
    if (!fundName?.trim()) return NextResponse.json({ error: 'Fund name cannot be empty' }, { status: 400 })
    await admin.from('funds').update({ name: fundName.trim() }).eq('id', membership.fund_id)
  }

  // Update fund logo
  if (fundLogo !== undefined) {
    if (fundLogo !== null) {
      if (typeof fundLogo !== 'string' || !fundLogo.startsWith('data:image/')) {
        return NextResponse.json({ error: 'Logo must be a data:image/ URL' }, { status: 400 })
      }
      if (fundLogo.length > 200 * 1024) {
        return NextResponse.json({ error: 'Logo must be under 200KB' }, { status: 400 })
      }
    }
    await admin.from('funds').update({ logo_url: fundLogo }).eq('id', membership.fund_id)
  }

  // Update fund address
  if (fundAddress !== undefined) {
    await admin.from('funds').update({ address: fundAddress?.trim() || null }).eq('id', membership.fund_id)
  }

  // Update fund_settings
  const settingsUpdates: Record<string, unknown> = {}

  // The sign-in screens' logo and text (components/auth-brand.tsx). Null clears either: no
  // logo shows Hemrock's mark, no text shows none.
  if (signInLogo !== undefined) {
    if (signInLogo !== null) {
      if (typeof signInLogo !== 'string' || !signInLogo.startsWith('data:image/')) {
        return NextResponse.json({ error: 'Sign-in logo must be a data:image/ URL' }, { status: 400 })
      }
      if (signInLogo.length > 200 * 1024) {
        return NextResponse.json({ error: 'Sign-in logo must be under 200KB' }, { status: 400 })
      }
    }
    settingsUpdates.sign_in_logo = signInLogo
  }
  if (signInTitle !== undefined) {
    if (signInTitle !== null && typeof signInTitle !== 'string') {
      return NextResponse.json({ error: 'Sign-in text must be a string' }, { status: 400 })
    }
    const title = signInTitle?.trim() || null
    if (title && title.length > AUTH_TITLE_MAX) {
      return NextResponse.json({ error: `Sign-in text must be ${AUTH_TITLE_MAX} characters or fewer` }, { status: 400 })
    }
    settingsUpdates.sign_in_title = title
  }

  if (postmarkInboundAddress !== undefined) {
    settingsUpdates.postmark_inbound_address = postmarkInboundAddress?.trim() || null
  }

  if (retainResolvedReviews !== undefined) {
    settingsUpdates.retain_resolved_reviews = retainResolvedReviews
  }

  if (resolvedReviewsTtlDays !== undefined) {
    settingsUpdates.resolved_reviews_ttl_days = resolvedReviewsTtlDays
  }

  if (claudeModel !== undefined) {
    settingsUpdates.claude_model = claudeModel.trim() || 'claude-sonnet-4-6'
  }

  if (aiSummaryPrompt !== undefined) {
    settingsUpdates.ai_summary_prompt = aiSummaryPrompt?.trim() || null
  }

  // Update Claude API key with envelope encryption
  if (claudeApiKey !== undefined && claudeApiKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const dek = randomBytes(32).toString('hex')
    settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    settingsUpdates.claude_api_key_encrypted = encrypt(claudeApiKey.trim(), dek)
  }

  // Update Google OAuth credentials
  if (googleClientId !== undefined) {
    settingsUpdates.google_client_id = googleClientId?.trim() || null
  }
  if (googleClientSecret !== undefined) {
    if (!googleClientSecret.trim()) {
      // Clear the secret
      settingsUpdates.google_client_secret_encrypted = null
    } else {
      const kek = process.env.ENCRYPTION_KEY
      if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

      // Ensure we have an encryption key; reuse existing or create new
      const { data: existing } = await admin
        .from('fund_settings')
        .select('encryption_key_encrypted')
        .eq('fund_id', membership.fund_id)
        .single()

      let dek: string
      if (existing?.encryption_key_encrypted) {
        const { decrypt } = await import('@/lib/crypto')
        dek = decrypt(existing.encryption_key_encrypted, kek)
      } else {
        dek = randomBytes(32).toString('hex')
        settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
      }
      settingsUpdates.google_client_secret_encrypted = encrypt(googleClientSecret.trim(), dek)
    }
  }

  // Update outbound email provider
  if (outboundEmailProvider !== undefined) {
    settingsUpdates.outbound_email_provider = outboundEmailProvider || null
  }

  // Update asks email provider
  if (asksEmailProvider !== undefined) {
    settingsUpdates.asks_email_provider = asksEmailProvider || null
  }

  // Update approval email template
  if (approvalEmailSubject !== undefined) {
    settingsUpdates.approval_email_subject = approvalEmailSubject?.trim() || null
  }
  if (approvalEmailBody !== undefined) {
    settingsUpdates.approval_email_body = approvalEmailBody?.trim() || null
  }

  // Update system email from name/address
  if (systemEmailFromName !== undefined) {
    settingsUpdates.system_email_from_name = systemEmailFromName?.trim() || null
  }
  if (systemEmailFromAddress !== undefined) {
    settingsUpdates.system_email_from_address = systemEmailFromAddress?.trim() || null
  }

  // Update Resend API key
  if (resendApiKey !== undefined && resendApiKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()

    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.resend_api_key_encrypted = encrypt(resendApiKey.trim(), dek)
  }

  // Update Postmark server token
  if (postmarkServerToken !== undefined && postmarkServerToken.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()

    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.postmark_server_token_encrypted = encrypt(postmarkServerToken.trim(), dek)
  }

  // Update inbound email provider
  if (inboundEmailProvider !== undefined) {
    settingsUpdates.inbound_email_provider = inboundEmailProvider || null
  }

  // Update Mailgun inbound domain
  if (mailgunInboundDomain !== undefined) {
    settingsUpdates.mailgun_inbound_domain = mailgunInboundDomain?.trim() || null
  }

  // Update Mailgun sending domain
  if (mailgunSendingDomain !== undefined) {
    settingsUpdates.mailgun_sending_domain = mailgunSendingDomain?.trim() || null
  }

  // Update Mailgun signing key (encrypted)
  if (mailgunSigningKey !== undefined && mailgunSigningKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()

    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.mailgun_signing_key_encrypted = encrypt(mailgunSigningKey.trim(), dek)
  }

  // Update Mailgun API key (encrypted)
  if (mailgunApiKey !== undefined && mailgunApiKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()

    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.mailgun_api_key_encrypted = encrypt(mailgunApiKey.trim(), dek)
  }

  // Update file storage provider
  if (fileStorageProvider !== undefined) {
    settingsUpdates.file_storage_provider = fileStorageProvider || null
  }

  // Update OpenAI API key with envelope encryption
  if (openaiApiKey !== undefined && openaiApiKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()

    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.openai_api_key_encrypted = encrypt(openaiApiKey.trim(), dek)
  }

  // Update OpenAI model
  if (openaiModel !== undefined) {
    settingsUpdates.openai_model = openaiModel.trim() || 'gpt-4o'
  }

  // Update OpenRouter (OpenAI-compatible) settings — key uses envelope encryption.
  if (openrouterApiKey !== undefined && openrouterApiKey.trim()) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })
    const { data: existing } = await admin
      .from('fund_settings')
      .select('encryption_key_encrypted')
      .eq('fund_id', membership.fund_id)
      .single()
    let dek: string
    if (existing?.encryption_key_encrypted) {
      const { decrypt } = await import('@/lib/crypto')
      dek = decrypt(existing.encryption_key_encrypted, kek)
    } else {
      dek = randomBytes(32).toString('hex')
      settingsUpdates.encryption_key_encrypted = encrypt(dek, kek)
    }
    settingsUpdates.openrouter_api_key_encrypted = encrypt(openrouterApiKey.trim(), dek)
  }
  if (openrouterModel !== undefined) {
    settingsUpdates.openrouter_model = openrouterModel.trim() || null
  }
  if (openrouterBaseUrl !== undefined) {
    const trimmed = openrouterBaseUrl?.trim() || null
    if (trimmed) {
      const validation = validateOllamaUrl(trimmed)
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
    }
    settingsUpdates.openrouter_base_url = trimmed
  }

  // Update default AI provider
  if (defaultAIProvider !== undefined) {
    const validProviders = ['anthropic', 'openai', 'openrouter']
    if (!validProviders.includes(defaultAIProvider)) {
      return NextResponse.json({ error: 'Invalid AI provider.' }, { status: 400 })
    }
    settingsUpdates.default_ai_provider = defaultAIProvider
  }

  // Update analytics settings
  if (analyticsFathomSiteId !== undefined) {
    settingsUpdates.analytics_fathom_site_id = analyticsFathomSiteId?.trim() || null
  }
  if (analyticsGaMeasurementId !== undefined) {
    settingsUpdates.analytics_ga_measurement_id = analyticsGaMeasurementId?.trim() || null
  }

  // Update fund currency
  if (currency !== undefined) {
    const supported = ['USD','EUR','GBP','CHF','CAD','AUD','JPY','CNY','INR','SGD','HKD','SEK','NOK','DKK','NZD','BRL','ZAR','ILS','KRW']
    if (!supported.includes(currency)) {
      return NextResponse.json({ error: 'Unsupported currency code' }, { status: 400 })
    }
    settingsUpdates.currency = currency
    // The ledger denominates every posting in the fund's currency and memoizes it. Drop the
    // memo, or entries written for the rest of this process's life would carry the old one.
    forgetFundCurrency(membership.fund_id)
  }

  // Which purchase lot a disposal draws its basis from. A POLICY ELECTION, applied consistently:
  // changing it does not restate anything already recorded — every cost_basis_exited on the books
  // stays exactly as it was — it changes what the close proposes and reconciles against from here.
  if (lotMethod !== undefined) {
    if (!isLotMethod(lotMethod)) {
      return NextResponse.json(
        { error: `Unsupported lot method. Choose one of: ${LOT_METHODS.join(', ')}.` },
        { status: 400 },
      )
    }
    settingsUpdates.lot_method = lotMethod
  }

  if (disableUserTracking !== undefined) {
    settingsUpdates.disable_user_tracking = disableUserTracking
  }

  if (dealThesis !== undefined) {
    settingsUpdates.deal_thesis = dealThesis?.trim() || null
  }
  if (dealScreeningPrompt !== undefined) {
    settingsUpdates.deal_screening_prompt = dealScreeningPrompt?.trim() || null
  }
  if (dealIntakeEnabled !== undefined) {
    settingsUpdates.deal_intake_enabled = !!dealIntakeEnabled
  }
  if (dealsDefaultVehicleId !== undefined) {
    // One of this fund's entities, or null (unassigned: admins triage).
    if (dealsDefaultVehicleId !== null) {
      const { data: v } = await (admin as any).from('fund_vehicles').select('id').eq('id', String(dealsDefaultVehicleId)).eq('fund_id', membership.fund_id).maybeSingle()
      if (!v) return NextResponse.json({ error: 'Entity not found' }, { status: 400 })
    }
    settingsUpdates.deals_default_vehicle_id = dealsDefaultVehicleId === null ? null : String(dealsDefaultVehicleId)
  }
  if (lpPortalEnabled !== undefined) {
    settingsUpdates.lp_portal_enabled = !!lpPortalEnabled
  }
  // Which Affinity transport the diligence assistant uses: Affinity's hosted MCP server
  // (richer, live) or this app's three REST tools. Fund-wide, because it changes what
  // every member's assistant can reach — but each member still authenticates with their
  // OWN key, so nobody sees CRM records they couldn't open in Affinity themselves.
  if (affinityMcpEnabled !== undefined) {
    settingsUpdates.affinity_mcp_enabled = !!affinityMcpEnabled
  }

  // The master switch for the entire agent surface: the MCP endpoint (OAuth and
  // static-key alike), the REST agent endpoint, API-key creation, and the OAuth
  // consent screen. Admin-only (enforced by hasAdminFields above) and off by
  // default — this is the switch that decides whether anything outside the app can
  // read the ledger or post to it.
  //
  // Turning it OFF does not revoke keys or tokens; it makes them inert. Every
  // request re-checks this flag, so the surface goes dark immediately and comes
  // back exactly as it was if the admin changes their mind.
  if (agentApiEnabled !== undefined) {
    settingsUpdates.agent_api_enabled = !!agentApiEnabled
  }

  // Update feature visibility
  if (featureVisibility !== undefined) {
    // `hidden` stays accepted so stored rows keep working — it resolves identically to `off` and
    // is no longer offered in the UI. `off` is accepted for EVERY feature now: it used to be
    // silently dropped for all but four, which meant the button appeared to work and didn't.
    const validLevels: FeatureVisibility[] = ['everyone', 'admin', 'hidden', 'off']
    const validKeys = Object.keys(DEFAULT_FEATURE_VISIBILITY) as FeatureKey[]
    const merged: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY }
    for (const [k, v] of Object.entries(featureVisibility)) {
      if (!validKeys.includes(k as FeatureKey)) continue
      if (!validLevels.includes(v as FeatureVisibility)) continue
      merged[k as FeatureKey] = v as FeatureVisibility
    }
    settingsUpdates.feature_visibility = merged
  }

  if (Object.keys(settingsUpdates).length > 0) {
    const { error } = await admin
      .from('fund_settings')
      .update(settingsUpdates)
      .eq('fund_id', membership.fund_id)

    if (error) return dbError(error, 'settings')
  }

  logActivity(admin, membership.fund_id, user.id, 'settings.update', {})

  expireTag('fund-data')
  expireTag('fund-settings')

  return NextResponse.json({ ok: true })
}

// DELETE — delete all fund data
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { confirm } = await req.json()
  if (confirm !== 'DELETE ALL DATA') {
    return NextResponse.json({ error: 'Confirmation text does not match' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 404 })

  if (membership.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const fundId = membership.fund_id

  // Delete in dependency order
  await admin.from('parsing_reviews').delete().eq('fund_id', fundId)
  await admin.from('metric_values').delete().eq('fund_id', fundId)
  await admin.from('metrics').delete().eq('fund_id', fundId)
  await admin.from('inbound_emails').delete().eq('fund_id', fundId)
  await admin.from('companies').delete().eq('fund_id', fundId)
  await admin.from('authorized_senders').delete().eq('fund_id', fundId)
  await admin.from('fund_join_requests').delete().eq('fund_id', fundId)
  await admin.from('fund_settings').delete().eq('fund_id', fundId)
  await admin.from('fund_members').delete().eq('fund_id', fundId)
  await admin.from('funds').delete().eq('id', fundId)

  return NextResponse.json({ ok: true })
}
