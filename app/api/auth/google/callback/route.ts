import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt } from '@/lib/crypto'
import { getGoogleCredentials } from '@/lib/google/credentials'
import { assertAdminAccess } from '@/lib/api-helpers'
import { safeNextPath } from '@/lib/safe-redirect'
import { requestOrigin } from '@/lib/site-links'
import {
  consumeGoogleOAuthTransaction,
  GOOGLE_OAUTH_STATE_COOKIE,
} from '@/lib/google/oauth-state'

function redirectAndClearState(req: NextRequest, target: string) {
  // Every target is either a literal here or a returnTo that consumeGoogleOAuthTransaction already
  // ran through safeNextPath; re-check anyway, since new URL(target, origin) is what would honour
  // an escape.
  const response = NextResponse.redirect(new URL(safeNextPath(target) ?? '/settings', requestOrigin(req)))
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/api/auth/google/callback',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  return response
}

function withError(returnTo: string, code: string): string {
  return `${returnTo}${returnTo.includes('?') ? '&' : '?'}drive_error=${code}`
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/auth', requestOrigin(req)))

  const code = req.nextUrl.searchParams.get('code')
  const stateParam = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  if (!stateParam) return redirectAndClearState(req, '/settings?drive_error=missing_params')
  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) return redirectAndClearState(req, '/settings?drive_error=server_error')
  const transaction = consumeGoogleOAuthTransaction({
    cookie: req.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value,
    encryptionKey,
    state: stateParam,
    userId: user.id,
  })
  if (!transaction) return redirectAndClearState(req, '/settings?drive_error=invalid_state')
  const { codeVerifier, fundId, returnTo } = transaction
  if (error) return redirectAndClearState(req, withError(returnTo, 'consent_denied'))
  if (!code) return redirectAndClearState(req, withError(returnTo, 'missing_params'))

  // Re-check current admin membership at callback time; starting a flow never grants a durable
  // right to finish it after demotion or removal.
  const admin = createAdminClient()
  const access = await assertAdminAccess(admin, user.id)
  if (access instanceof NextResponse || access.fundId !== fundId) {
    return redirectAndClearState(req, '/settings?drive_error=forbidden')
  }

  // Get Google credentials from DB or env
  const creds = await getGoogleCredentials(admin, fundId)
  if (!creds) {
    return redirectAndClearState(req, withError(returnTo, 'not_configured'))
  }

  // Must produce the same string as /api/auth/google built — Google enforces
  // exact-match between the initial redirect_uri and the one supplied at
  // token exchange. Normalize https + trim trailing slash so a misconfigured
  // env var can't desync the two halves of the flow.
  let baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000'
  baseUrl = baseUrl.replace(/\/$/, '')
  if (baseUrl.startsWith('http://') && !baseUrl.startsWith('http://localhost')) {
    baseUrl = baseUrl.replace(/^http:\/\//, 'https://')
  }
  const redirectUri = `${baseUrl}/api/auth/google/callback`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) {
    console.error('[google-oauth] Token exchange failed:', await tokenRes.text())
    return redirectAndClearState(req, withError(returnTo, 'token_exchange_failed'))
  }

  const tokens = await tokenRes.json()
  const refreshToken = tokens.refresh_token

  if (!refreshToken) {
    return redirectAndClearState(req, withError(returnTo, 'no_refresh_token'))
  }

  // Encrypt and store refresh token using the fund's encryption key
  const { data: settings } = await admin
    .from('fund_settings')
    .select('encryption_key_encrypted')
    .eq('fund_id', fundId)
    .single()

  if (!settings?.encryption_key_encrypted) {
    return redirectAndClearState(req, withError(returnTo, 'no_encryption_key'))
  }

  const kek = process.env.ENCRYPTION_KEY
  if (!kek) {
    return redirectAndClearState(req, withError(returnTo, 'server_error'))
  }

  // Decrypt the DEK, then encrypt the refresh token with it
  const { decrypt } = await import('@/lib/crypto')
  const dek = decrypt(settings.encryption_key_encrypted, kek)
  const encryptedRefreshToken = encrypt(refreshToken, dek)

  const { error: updateError } = await admin
    .from('fund_settings')
    .update({ google_refresh_token_encrypted: encryptedRefreshToken })
    .eq('fund_id', fundId)
  if (updateError) return redirectAndClearState(req, withError(returnTo, 'save_failed'))

  const separator = returnTo.includes('?') ? '&' : '?'
  return redirectAndClearState(req, `${returnTo}${separator}google_connected=true`)
}
