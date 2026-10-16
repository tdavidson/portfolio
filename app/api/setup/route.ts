import { NextResponse } from 'next/server'
import { hasCredential } from '@/lib/credentials/env'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { effectiveAIMode, hasAnyAIKey, type AIMode } from '@/lib/ai/capabilities'

export async function GET() {
  if (process.env.ENABLE_SETUP_PAGE !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Require authentication — setup info should not be publicly accessible
  const supabaseConfigured = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (supabaseConfigured) {
    try {
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  // If Supabase env vars are not set, allow unauthenticated access for initial setup only
  // (returns only boolean env var presence checks, no sensitive values)

  const supabaseUrl = !!process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceRoleKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY
  const encryptionKey = !!process.env.ENCRYPTION_KEY
  const appUrl = !!process.env.NEXT_PUBLIC_APP_URL
  const setupPageEnabled = process.env.ENABLE_SETUP_PAGE === 'true'

  // If Supabase env vars are missing, return early with just infrastructure checks
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return NextResponse.json({
      infrastructure: {
        supabaseUrl,
        supabaseAnonKey,
        serviceRoleKey,
        encryptionKey,
        appUrl,
        setupPageEnabled,
      },
      database: null,
      authentication: null,
      fund: null,
      ai: null,
      inboundEmail: null,
      outboundEmail: null,
      fileStorage: null,
      senders: null,
    })
  }

  const supabase = createAdminClient()

  // Database connectivity and core tables
  let dbConnected = false
  let coreTablesExist = false
  let coreTableCount = 0
  const expectedTables = [
    'app_settings',
    'funds',
    'fund_members',
    'fund_settings',
    'authorized_senders',
    'companies',
    'metrics',
    'metric_values',
    'inbound_emails',
    'investment_transactions',
  ]

  try {
    const { error } = await supabase.from('app_settings').select('id').limit(1)
    dbConnected = !error

    if (dbConnected) {
      const tableChecks = await Promise.all(
        expectedTables.map(async (table) => {
          const { error } = await supabase.from(table as any).select('id').limit(1)
          return !error
        })
      )
      coreTableCount = tableChecks.filter(Boolean).length
      coreTablesExist = coreTableCount === expectedTables.length
    }
  } catch {
    dbConnected = false
  }

  // Auth check
  let hasUser = false
  try {
    const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 })
    hasUser = (data?.users?.length ?? 0) > 0
  } catch {
    hasUser = false
  }

  // Fund check
  let hasFund = false
  try {
    const { count } = await supabase.from('funds').select('id', { count: 'exact', head: true })
    hasFund = (count ?? 0) > 0
  } catch {
    hasFund = false
  }

  // AI, email, storage, senders — only check if fund exists
  let ai: { hasProvider: boolean; mode: AIMode | null } | null = null
  let inboundEmail = null
  let outboundEmail = null
  let fileStorage = null
  let senders = null
  let memoAgent: { schemasSeeded: boolean; styleAnchorCount: number } | null = null

  if (hasFund) {
    try {
      const [settingsResult, sendersResult, schemasResult, anchorsResult] = await Promise.all([
        supabase
          .from('fund_settings')
          // select('*') so `ai_mode`, from a migration that may not be applied yet, reads as
          // undefined instead of failing every check below.
          .select('*')
          .limit(1)
          .maybeSingle(),
        supabase.from('authorized_senders').select('id', { count: 'exact', head: true }),
        supabase.from('firm_schemas').select('schema_name', { count: 'exact', head: false }).eq('is_active', true),
        supabase.from('style_anchor_memos').select('id', { count: 'exact', head: true }),
      ])

      memoAgent = {
        // Seven schemas required when seeded.
        schemasSeeded: (schemasResult.count ?? schemasResult.data?.length ?? 0) >= 7,
        styleAnchorCount: anchorsResult.count ?? 0,
      }

      const s = settingsResult.data

      const hasProvider = hasAnyAIKey(s)
      ai = {
        hasProvider,
        // 'assistant' when the fund runs with no server key, through the admin's own assistant.
        mode: effectiveAIMode(hasProvider, (s as Record<string, unknown> | null)?.ai_mode),
      }

      const hasInboundProvider = !!s?.inbound_email_provider
      const hasInboundKey =
        !!s?.postmark_webhook_token || !!s?.postmark_webhook_token_encrypted || hasCredential(s, 'mailgun_signing')
      inboundEmail = {
        providerConfigured: hasInboundProvider,
        keyConfigured: hasInboundKey,
      }

      const hasOutboundProvider = !!s?.outbound_email_provider
      const hasOutboundKey =
        hasCredential(s, 'postmark_server') ||
        hasCredential(s, 'resend') ||
        hasCredential(s, 'mailgun_api')
      outboundEmail = {
        providerConfigured: hasOutboundProvider,
        keyConfigured: hasOutboundKey,
      }

      const hasGoogleDrive = !!s?.google_refresh_token_encrypted
      fileStorage = {
        connected: hasGoogleDrive,
      }

      senders = {
        count: sendersResult.count ?? 0,
      }
    } catch {
      // partial failure — leave as null
    }
  }

  return NextResponse.json({
    infrastructure: {
      supabaseUrl,
      supabaseAnonKey,
      serviceRoleKey,
      encryptionKey,
      appUrl,
      setupPageEnabled,
    },
    database: {
      connected: dbConnected,
      coreTablesExist,
      coreTableCount,
      expectedTableCount: expectedTables.length,
    },
    authentication: { hasUser },
    fund: { hasFund },
    ai,
    inboundEmail,
    outboundEmail,
    fileStorage,
    senders,
    memoAgent,
  })
}
