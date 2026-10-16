// The non-secret half of a fund's connections, settable from chat: which AI provider and model
// run, which email providers send and receive, and the addresses and domains they use.
//
// The secrets themselves (API keys, server tokens, signing keys, the Google client secret) are never
// accepted here. They are saved in Settings, or set in the deployment's environment
// (lib/credentials/env.ts), and `environment_status` says which are set without showing any.
//
// The same fields, the same columns and the same checks as PATCH /api/settings, which the Settings
// page uses.

import type { SupabaseClient } from '@supabase/supabase-js'
import { expireTag } from '@/lib/cache/tags'
import { logActivity } from '@/lib/activity'

export const AI_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const
export const OUTBOUND_PROVIDERS = ['resend', 'postmark', 'mailgun', 'gmail'] as const
export const INBOUND_PROVIDERS = ['postmark', 'mailgun'] as const

/** Field → fund_settings column. `null` input clears a field (the provider is then "none"). */
const FIELDS = {
  defaultAIProvider: 'default_ai_provider',
  claudeModel: 'claude_model',
  openaiModel: 'openai_model',
  openrouterModel: 'openrouter_model',
  openrouterBaseUrl: 'openrouter_base_url',
  outboundEmailProvider: 'outbound_email_provider',
  asksEmailProvider: 'asks_email_provider',
  systemEmailFromName: 'system_email_from_name',
  systemEmailFromAddress: 'system_email_from_address',
  mailgunSendingDomain: 'mailgun_sending_domain',
  inboundEmailProvider: 'inbound_email_provider',
  postmarkInboundAddress: 'postmark_inbound_address',
  mailgunInboundDomain: 'mailgun_inbound_domain',
  googleClientId: 'google_client_id',
} as const

export type ConnectionField = keyof typeof FIELDS
export const CONNECTION_FIELDS = Object.keys(FIELDS) as ConnectionField[]

/** Names a secret might be passed under. Refused outright, so a key never lands in the audit trail. */
const SECRET_HINT = /key|token|secret|password/i

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const DEFAULTS: Partial<Record<ConnectionField, string>> = { claudeModel: 'claude-sonnet-4-6', openaiModel: 'gpt-4o' }

/**
 * Check an update and turn it into column writes, or say what is wrong. Pure, apart from the
 * OpenRouter base URL, whose resolution check is passed in (it does DNS).
 */
export async function parseConnectionUpdate(
  input: unknown,
  checkBaseUrl: (url: string) => Promise<{ ok: true; url?: string } | { ok: false; error: string }>,
): Promise<{ updates: Record<string, string | null> } | { error: string }> {
  const raw = (input ?? {}) as Record<string, unknown>
  const secretish = Object.keys(raw).filter(k => !(k in FIELDS) && SECRET_HINT.test(k))
  if (secretish.length) {
    return { error: `${secretish.join(', ')}: keys and secrets are not set from chat. Put them in the deployment's environment (environment_status lists the variable names) or in Settings.` }
  }
  const unknown = Object.keys(raw).filter(k => !(k in FIELDS))
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}. Settable: ${CONNECTION_FIELDS.join(', ')}.` }

  const updates: Record<string, string | null> = {}
  for (const field of CONNECTION_FIELDS) {
    if (!(field in raw)) continue
    const value = raw[field]
    if (value !== null && typeof value !== 'string') return { error: `${field} must be a string or null.` }
    const v = value?.trim() || null

    if (field === 'defaultAIProvider') {
      if (!v || !(AI_PROVIDERS as readonly string[]).includes(v)) return { error: `defaultAIProvider must be one of ${AI_PROVIDERS.join(', ')}.` }
    }
    if ((field === 'outboundEmailProvider' || field === 'asksEmailProvider') && v && !(OUTBOUND_PROVIDERS as readonly string[]).includes(v)) {
      return { error: `${field} must be one of ${OUTBOUND_PROVIDERS.join(', ')}, or null for none.` }
    }
    if (field === 'inboundEmailProvider' && v && !(INBOUND_PROVIDERS as readonly string[]).includes(v)) {
      return { error: `inboundEmailProvider must be one of ${INBOUND_PROVIDERS.join(', ')}, or null for none.` }
    }
    if ((field === 'systemEmailFromAddress' || field === 'postmarkInboundAddress') && v && !EMAIL.test(v)) {
      return { error: `${field} is not a valid email address.` }
    }
    if (field === 'openrouterBaseUrl' && v) {
      const check = await checkBaseUrl(v)
      if (!check.ok) return { error: check.error }
    }
    updates[FIELDS[field]] = v ?? DEFAULTS[field] ?? null
  }
  if (Object.keys(updates).length === 0) return { error: `Nothing to change. Settable: ${CONNECTION_FIELDS.join(', ')}.` }
  return { updates }
}

/** Write a parsed update to the fund's settings, logged and with the settings caches expired, as the route does. */
export async function applyConnectionUpdate(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string | null },
  updates: Record<string, string | null>,
) {
  const { error } = await (admin as any).from('fund_settings').update(updates).eq('fund_id', ctx.fundId)
  if (error) throw new Error(`Settings could not be saved: ${error.message}`)
  if (ctx.userId) logActivity(admin, ctx.fundId, ctx.userId, 'settings.update', { fields: Object.keys(updates) })
  expireTag('fund-data')
  expireTag('fund-settings')
  return { updated: Object.keys(updates) }
}

/** The current non-secret connection settings, by field name, for environment_status. */
export function connectionSettingsOf(settings: Record<string, unknown> | null | undefined): Record<ConnectionField, unknown> {
  return Object.fromEntries(CONNECTION_FIELDS.map(f => [f, settings?.[FIELDS[f]] ?? null])) as Record<ConnectionField, unknown>
}
