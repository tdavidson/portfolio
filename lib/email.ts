import type { SupabaseClient } from '@supabase/supabase-js'
import { EMAIL_RE } from '@/lib/deals/submission-validation'

export interface EmailAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export interface EmailParams {
  to: string
  from?: string
  subject: string
  html: string
  cc?: string
  bcc?: string
  attachments?: EmailAttachment[]
}

export interface OutboundConfig {
  provider: 'resend' | 'postmark' | 'gmail' | 'mailgun'
  apiKey?: string       // resend or mailgun
  serverToken?: string  // postmark
  mailgunDomain?: string // mailgun sending domain
  // gmail uses admin + fundId
  admin?: SupabaseClient
  fundId?: string
}

async function sendViaResend(apiKey: string, params: EmailParams) {
  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)
  const result = await resend.emails.send({
    from: params.from || process.env.EMAIL_FROM || 'onboarding@resend.dev',
    to: params.to,
    cc: params.cc || undefined,
    bcc: params.bcc || undefined,
    subject: params.subject,
    html: params.html,
    attachments: params.attachments?.map(a => ({ filename: a.filename, content: a.content })),
  })
  // The Resend SDK reports failures as { data: null, error } rather than throwing.
  if (result.error) throw new Error(result.error.message)
  return { id: result.data?.id }
}

async function sendViaPostmark(serverToken: string, params: EmailParams) {
  const postmark = await import('postmark')
  const client = new postmark.ServerClient(serverToken)
  const result = await client.sendEmail({
    From: params.from || process.env.EMAIL_FROM || 'noreply@example.com',
    To: params.to,
    Cc: params.cc || undefined,
    Bcc: params.bcc || undefined,
    Subject: params.subject,
    HtmlBody: params.html,
    Attachments: params.attachments?.map(a => ({
      Name: a.filename,
      Content: a.content.toString('base64'),
      ContentType: a.contentType,
      ContentID: null as unknown as string,
    })),
  })
  // Non-2xx responses reject (axios); a resolved response still carries ErrorCode, 0 on success.
  if (result.ErrorCode) throw new Error(result.Message || `Postmark error ${result.ErrorCode}`)
  return { id: result.MessageID }
}

async function sendViaMailgun(apiKey: string, domain: string, params: EmailParams) {
  const FormData = (await import('form-data')).default
  const Mailgun = (await import('mailgun.js')).default
  const mailgun = new Mailgun(FormData)
  const mg = mailgun.client({ username: 'api', key: apiKey })
  const result = await mg.messages.create(domain, {
    from: params.from || process.env.EMAIL_FROM || `noreply@${domain}`,
    to: [params.to],
    cc: params.cc || undefined,
    bcc: params.bcc || undefined,
    subject: params.subject,
    html: params.html,
    attachment: params.attachments?.map(a => ({ filename: a.filename, data: a.content })),
  })
  return { id: result.id }
}

async function sendViaGmail(admin: SupabaseClient, fundId: string, params: EmailParams) {
  const { decrypt } = await import('@/lib/crypto')
  const { getGoogleCredentials } = await import('@/lib/google/credentials')
  const { getAccessToken } = await import('@/lib/google/drive')
  const { sendEmail } = await import('@/lib/google/gmail')

  const { data: settings } = await admin
    .from('fund_settings')
    .select('google_refresh_token_encrypted, encryption_key_encrypted')
    .eq('fund_id', fundId)
    .single()

  if (!settings?.google_refresh_token_encrypted || !settings?.encryption_key_encrypted) {
    throw new Error('Google not connected')
  }

  const kek = process.env.ENCRYPTION_KEY
  if (!kek) throw new Error('ENCRYPTION_KEY not set')

  const dek = decrypt(settings.encryption_key_encrypted, kek)
  const refreshToken = decrypt(settings.google_refresh_token_encrypted, dek)
  const creds = await getGoogleCredentials(admin, fundId)
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error('Google OAuth credentials not configured')
  }
  const accessToken = await getAccessToken(refreshToken, creds.clientId, creds.clientSecret)

  const result = await sendEmail(accessToken, params.to, params.subject, params.html, params.cc, params.bcc, params.attachments)
  return { id: result.id }
}

/**
 * Normalize a user-typed Cc/Bcc field into a header-safe address list.
 *
 * Accepts comma- or semicolon-separated entries, either bare (`a@b.com`) or with a
 * display name (`Ada <a@b.com>`). Returns the joined list, or the first entry that
 * isn't an address so the caller can reject it with a useful message — providers
 * fail an unparseable Cc with an opaque error, and Gmail would happily put it in a
 * header.
 */
export function parseAddressList(
  input: string | null | undefined,
): { value?: string; invalid?: string } {
  const entries = (input ?? '')
    .split(/[,;]/)
    .map(e => e.replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean)

  for (const entry of entries) {
    const address = entry.match(/<([^>]*)>$/)?.[1].trim() ?? entry
    if (!EMAIL_RE.test(address)) return { invalid: entry }
  }

  return { value: entries.length ? entries.join(', ') : undefined }
}

/**
 * Send a single email using the given outbound config.
 * Throws on failure — callers decide how to handle errors.
 */
export async function sendOutboundEmail(config: OutboundConfig, params: EmailParams): Promise<{ id?: string }> {
  console.log(`[outbound-email] Sending via ${config.provider} to=${params.to} subject="${params.subject}"`)
  let result: { id?: string }

  if (config.provider === 'resend') {
    if (!config.apiKey) throw new Error('Resend API key not configured')
    result = await sendViaResend(config.apiKey, params)
  } else if (config.provider === 'postmark') {
    if (!config.serverToken) throw new Error('Postmark server token not configured')
    result = await sendViaPostmark(config.serverToken, params)
  } else if (config.provider === 'mailgun') {
    if (!config.apiKey) throw new Error('Mailgun API key not configured')
    if (!config.mailgunDomain) throw new Error('Mailgun sending domain not configured')
    result = await sendViaMailgun(config.apiKey, config.mailgunDomain, params)
  } else if (config.provider === 'gmail') {
    if (!config.admin || !config.fundId) throw new Error('Gmail requires admin client and fundId')
    result = await sendViaGmail(config.admin, config.fundId, params)
  } else {
    throw new Error(`Unknown provider: ${config.provider}`)
  }

  console.log(`[outbound-email] Sent successfully via ${config.provider} messageId=${result.id}`)
  return result
}

/**
 * Build an OutboundConfig from a fund's settings.
 * Returns null if no provider is configured.
 */
export async function getOutboundConfig(
  admin: SupabaseClient,
  fundId: string,
  purpose: 'system' | 'asks' = 'system',
): Promise<OutboundConfig | null> {
  const { data: settings, error: settingsError } = await admin
    .from('fund_settings')
    .select('outbound_email_provider, asks_email_provider, resend_api_key_encrypted, postmark_server_token_encrypted, mailgun_api_key_encrypted, mailgun_sending_domain, encryption_key_encrypted')
    .eq('fund_id', fundId)
    .single()

  if (settingsError || !settings) {
    console.warn(`[outbound-email] No fund_settings found for fund ${fundId}`, settingsError?.message)
    return null
  }

  const selectedProvider = purpose === 'asks'
    ? settings.asks_email_provider
    : settings.outbound_email_provider

  if (!selectedProvider) {
    console.warn(`[outbound-email] No ${purpose} email provider set for fund ${fundId} (outbound_email_provider=${settings.outbound_email_provider}, asks_email_provider=${settings.asks_email_provider})`)
    return null
  }

  const provider = selectedProvider as 'resend' | 'postmark' | 'gmail' | 'mailgun'
  console.log(`[outbound-email] Using provider "${provider}" for purpose "${purpose}" (fund ${fundId})`)

  if (provider === 'gmail') {
    return { provider, admin, fundId }
  }

  // The provider's secret: the one saved in Settings, else the deployment's environment
  // (lib/credentials/env.ts), so a fund run from chat never has to paste a key into the app.
  const { envCredential } = await import('@/lib/credentials/env')
  const kek = process.env.ENCRYPTION_KEY
  let dek: string | null = null
  if (settings.encryption_key_encrypted && kek) {
    const { decrypt } = await import('@/lib/crypto')
    dek = decrypt(settings.encryption_key_encrypted, kek)
  }
  const secret = async (saved: string | null, fromEnv: Parameters<typeof envCredential>[0]): Promise<string | null> => {
    if (saved && dek) {
      const { decrypt } = await import('@/lib/crypto')
      return decrypt(saved, dek)
    }
    if (saved && !kek) console.warn('[outbound-email] ENCRYPTION_KEY env var not set')
    return envCredential(fromEnv)
  }

  if (provider === 'resend') {
    const apiKey = await secret(settings.resend_api_key_encrypted, 'resend')
    if (!apiKey) {
      console.warn(`[outbound-email] Resend selected but no API key stored or in RESEND_API_KEY for fund ${fundId}`)
      return null
    }
    return { provider, apiKey }
  }

  if (provider === 'postmark') {
    const serverToken = await secret(settings.postmark_server_token_encrypted, 'postmark_server')
    if (!serverToken) {
      console.warn(`[outbound-email] Postmark selected but no server token stored or in POSTMARK_SERVER_TOKEN for fund ${fundId}`)
      return null
    }
    return { provider, serverToken }
  }

  if (provider === 'mailgun') {
    const apiKey = await secret(settings.mailgun_api_key_encrypted, 'mailgun_api')
    if (!apiKey || !settings.mailgun_sending_domain) {
      console.warn(`[outbound-email] Mailgun selected but missing API key or domain for fund ${fundId}`)
      return null
    }
    return { provider, apiKey, mailgunDomain: settings.mailgun_sending_domain }
  }

  return null
}

/**
 * Send the approval notification email using the fund's configured outbound provider.
 * Fails silently — never throws.
 */
export const DEFAULT_APPROVAL_SUBJECT = "You've been approved to join {{fundName}}"
export const DEFAULT_APPROVAL_BODY = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr><td style="padding:32px 32px 0 32px;">
          <p style="margin:0;font-size:13px;color:#6b7280;">{{siteUrl}}</p>
        </td></tr>
        <tr><td style="padding:24px 32px 32px 32px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">You've been approved</h1>
          <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#374151;">You've been approved to join <strong>{{fundName}}</strong>. Click below to sign in and get started.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr><td style="background-color:#111827;border-radius:6px;padding:12px 24px;">
            <a href="{{siteUrl}}/auth" style="color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;display:inline-block;">Sign in</a>
          </td></tr></table>
          <p style="margin:0 0 8px 0;font-size:12px;color:#6b7280;">Or copy this link into your browser:</p>
          <p style="margin:0 0 24px 0;font-size:12px;color:#6b7280;word-break:break-all;">{{siteUrl}}/auth</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">If you weren't expecting this email, you can safely ignore it.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">Sent by your reporting platform &middot; {{siteUrl}}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

export async function sendApprovalEmail(
  admin: SupabaseClient,
  fundId: string,
  to: string,
  fundName: string,
) {
  try {
    const config = await getOutboundConfig(admin, fundId)
    if (!config) {
      console.warn('[approval-email] No system email provider configured for fund', fundId)
      return
    }

    const { data: settings } = await admin
      .from('fund_settings')
      .select('approval_email_subject, approval_email_body, system_email_from_name, system_email_from_address')
      .eq('fund_id', fundId)
      .single()

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const vars: Record<string, string> = { fundName, siteUrl }
    const interpolate = (template: string) =>
      template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')

    const subject = interpolate(settings?.approval_email_subject || DEFAULT_APPROVAL_SUBJECT)
    const html = interpolate(settings?.approval_email_body || DEFAULT_APPROVAL_BODY)

    let from: string | undefined
    if (settings?.system_email_from_address) {
      from = settings.system_email_from_name
        ? `${settings.system_email_from_name} <${settings.system_email_from_address}>`
        : settings.system_email_from_address
    }

    console.log(`[approval-email] Sending to ${to} for fund "${fundName}" via ${config.provider}`)
    await sendOutboundEmail(config, { to, from, subject, html })
    console.log(`[approval-email] Sent successfully to ${to}`)
  } catch (error) {
    console.error(`[approval-email] Failed to send to ${to}:`, error)
  }
}
