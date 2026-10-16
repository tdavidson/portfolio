// Credentials from the deployment's environment, so a key never has to pass through a chat or the
// Settings page.
//
// Every secret a fund can save in Settings (encrypted in fund_settings) can instead be set as an
// environment variable on the deployment: a `.env` file for a self-hosted install, or the host's
// environment settings (Vercel → Project → Settings → Environment Variables). A key saved in
// Settings wins; the environment fills in when Settings has none. So a fund that set its keys in
// the app keeps working unchanged, and one run entirely from chat never has to open it.
//
// The environment belongs to the DEPLOYMENT, not to one fund: every fund on it shares these keys.
// That is the normal self-hosted case (one firm, one deployment). A deployment hosting several firms
// should keep using Settings, which is per fund.
//
// Only presence ever leaves this module (`credentialSources`): never a value. The tools that report
// setup (setup_status, environment_status) say which variables are set, so an assistant can tell
// the person what to add to their `.env` without ever seeing a key.

export type EnvCredential =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'resend'
  | 'postmark_server'
  | 'mailgun_api'
  | 'mailgun_signing'
  | 'google_client_id'
  | 'google_client_secret'

interface EnvCredentialSpec {
  /** The variables read, first set wins. */
  vars: string[]
  /** What it is for, in a few words: shown by environment_status. */
  label: string
  /** The fund_settings column the same secret is saved in from Settings (null: not a column). */
  column: string | null
}

export const ENV_CREDENTIALS: Record<EnvCredential, EnvCredentialSpec> = {
  anthropic: { vars: ['ANTHROPIC_API_KEY'], label: 'Claude API key (AI provider)', column: 'claude_api_key_encrypted' },
  openai: { vars: ['OPENAI_API_KEY'], label: 'OpenAI API key (AI provider)', column: 'openai_api_key_encrypted' },
  openrouter: { vars: ['OPENROUTER_API_KEY'], label: 'OpenRouter API key (AI provider)', column: 'openrouter_api_key_encrypted' },
  resend: { vars: ['RESEND_API_KEY'], label: 'Resend API key (outbound email)', column: 'resend_api_key_encrypted' },
  postmark_server: { vars: ['POSTMARK_SERVER_TOKEN'], label: 'Postmark server token (outbound email)', column: 'postmark_server_token_encrypted' },
  mailgun_api: { vars: ['MAILGUN_API_KEY'], label: 'Mailgun API key (outbound email)', column: 'mailgun_api_key_encrypted' },
  mailgun_signing: { vars: ['MAILGUN_WEBHOOK_SIGNING_KEY'], label: 'Mailgun webhook signing key (inbound email)', column: 'mailgun_signing_key_encrypted' },
  google_client_id: { vars: ['GOOGLE_CLIENT_ID'], label: 'Google OAuth client id (Google Drive)', column: 'google_client_id' },
  google_client_secret: { vars: ['GOOGLE_CLIENT_SECRET'], label: 'Google OAuth client secret (Google Drive)', column: 'google_client_secret_encrypted' },
}

/** The AI providers, keyed as fund_settings.default_ai_provider names them. */
export const AI_PROVIDER_CREDENTIAL = { anthropic: 'anthropic', openai: 'openai', openrouter: 'openrouter' } as const

/** The value of a credential from the environment, or null when no variable for it is set. */
export function envCredential(name: EnvCredential, env: Record<string, string | undefined> = process.env): string | null {
  for (const v of ENV_CREDENTIALS[name].vars) {
    const value = env[v]?.trim()
    if (value) return value
  }
  return null
}

/** Whether a credential is available from either place: the fund's saved column, or the environment. */
export function hasCredential(
  settings: Record<string, unknown> | null | undefined,
  name: EnvCredential,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const column = ENV_CREDENTIALS[name].column
  if (column && settings?.[column]) return true
  return envCredential(name, env) !== null
}

/** Any server AI key at all, saved or from the environment. */
export function hasAnyAIKeyFrom(settings: Record<string, unknown> | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return hasCredential(settings, 'anthropic', env) || hasCredential(settings, 'openai', env) || hasCredential(settings, 'openrouter', env)
}

export type CredentialSource = 'settings' | 'environment' | null

/**
 * Where each credential comes from for this fund: its Settings (which wins), the environment, or
 * nowhere. Presence only, never a value, so it is safe to return to a chat.
 */
export function credentialSources(
  settings: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { name: EnvCredential; label: string; variables: string[]; source: CredentialSource }[] {
  return (Object.keys(ENV_CREDENTIALS) as EnvCredential[]).map(name => {
    const spec = ENV_CREDENTIALS[name]
    const saved = !!(spec.column && settings?.[spec.column])
    return {
      name,
      label: spec.label,
      variables: spec.vars,
      source: saved ? 'settings' : envCredential(name, env) ? 'environment' : null,
    }
  })
}
