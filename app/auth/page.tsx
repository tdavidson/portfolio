'use client'

import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { safeNextPath } from '@/lib/safe-redirect'
import { PRIVACY_URL, PRODUCT_LICENSE, TERMS_URL } from '@/lib/site-links'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { AuthShell } from '@/components/auth-shell'
import { X } from 'lucide-react'
import { forgetAccount, useRecentAccounts, type RecentAccount } from '@/lib/recent-accounts'

export default function AuthPage() {
  return (
    <Suspense>
      <AuthForm />
    </Suspense>
  )
}

function AuthForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')
  const emailConfirmed = searchParams.get('confirmed') === 'true'
  const switching = searchParams.get('switch') === '1'
  const passwordRef = useRef<HTMLInputElement>(null)

  const recent = useRecentAccounts()

  function pick(account: RecentAccount) {
    setEmail(account.email)
    setError(null)
    passwordRef.current?.focus()
  }

  // Where to land after signing in. Set when a page bounced the user here to log
  // in first — notably the OAuth consent screen (/oauth/authorize), which must
  // resume the exact authorization request afterwards, query string and all.
  //
  // Validated by safeNextPath, NOT by an inline startsWith check: a redirect fired
  // straight after a successful login is a phishing primitive, and the obvious
  // check misses `/\evil.com` (a backslash is a slash for http(s), so it resolves
  // off-origin). See lib/safe-redirect.ts.
  const nextPath = safeNextPath(searchParams.get('next'))

  const supabase = createClient()

  // Handle code param (e.g. password reset link landing on /auth instead of /auth/callback)
  useEffect(() => {
    const code = searchParams.get('code')
    if (!code) return

    async function exchangeCode() {
      const { error } = await supabase.auth.exchangeCodeForSession(code!)
      if (error) {
        setError('Invalid or expired link. Please try again.')
        return
      }
      // Check if this is a recovery session — redirect to set new password
      const { data: { session } } = await supabase.auth.getSession()
      let destination = session?.user?.recovery_sent_at ? '/auth/reset-password' : (nextPath ?? '/')
      // If user has no fund, send to onboarding. A password recovery keeps its own
      // destination; everything else (including a pending OAuth authorization)
      // still needs a fund to land in.
      if (destination !== '/auth/reset-password') {
        const { data: fund } = await supabase.from('funds').select('id').limit(1).maybeSingle()
        if (!fund) destination = '/onboarding?confirmed=true'
      }
      // If MFA is enrolled, verify first then continue to destination
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        router.replace(`/auth/mfa-verify?next=${encodeURIComponent(destination)}`)
      } else {
        router.replace(destination)
      }
    }
    exchangeCode()
  }, [searchParams, supabase, router])

  async function signIn() {
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
    } else {
      fetch('/api/auth/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'password' }) }).catch(() => {})
      // Check if user has a fund — if not, go to onboarding. A pending `next`
      // (e.g. an OAuth authorization to resume) wins, but only for a user who
      // actually has a fund — there is nothing to authorize otherwise.
      const { data: fund } = await supabase.from('funds').select('id').limit(1).maybeSingle()
      const destination = fund ? (nextPath ?? '/') : '/onboarding'
      // Check if user has MFA enrolled and needs to verify
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        router.push(`/auth/mfa-verify?next=${encodeURIComponent(destination)}`)
      } else {
        router.push(destination)
      }
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <AuthShell
      footer={
        <>
          <p className="text-center text-xs text-muted-foreground">
            <a href={PRODUCT_LICENSE} target="_blank" rel="noopener noreferrer" className="hover:text-foreground underline underline-offset-4">License</a>
            {TERMS_URL && (
              <>
                {' · '}
                <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground underline underline-offset-4">Terms</a>
              </>
            )}
            {PRIVACY_URL && (
              <>
                {' · '}
                <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground underline underline-offset-4">Privacy</a>
              </>
            )}
          </p>
        </>
      }
    >
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">{switching ? 'Switch account' : 'Sign in with your account'}</CardTitle>
            <CardDescription>
              {switching
                ? 'Each fund has its own sign-in. Pick the account to switch to.'
                : 'Sign in with password or a one-time code.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {emailConfirmed && (
              <Alert className="border-success bg-success-subtle">
                <AlertDescription className="text-success">
                  Your email has been confirmed. Please sign in to continue.
                </AlertDescription>
              </Alert>
            )}
            {(error || urlError) && (
              <Alert variant="destructive">
                <AlertDescription>{error || urlError}</AlertDescription>
              </Alert>
            )}

            {recent.length > 0 && (
              <div className="space-y-1.5">
                {recent.map(account => (
                  <div
                    key={account.email}
                    className={`flex items-center rounded-lg border ${account.email === email ? 'border-primary bg-muted/40' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => pick(account)}
                      className="flex-1 min-w-0 px-3 py-2 text-left"
                    >
                      <span className="block text-sm font-medium truncate">{account.fundName || account.email}</span>
                      {account.fundName && <span className="block text-xs text-muted-foreground truncate">{account.email}</span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => forgetAccount(account.email)}
                      className="p-2 mr-1 text-muted-foreground hover:text-foreground"
                      title="Forget this account on this browser"
                      aria-label={`Forget ${account.email}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && signIn()}
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/auth/forgot-password" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-primary">
                  Forgot password?
                </Link>
              </div>
              <Input
                ref={passwordRef}
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && signIn()}
                autoComplete="current-password"
              />
            </div>

            <Button className="w-full" onClick={signIn} disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>

            <div className="flex items-center gap-3 pt-1 pb-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <Link href={`/auth/magic-link${magicLinkQuery(email, nextPath)}`}>
              <Button variant="outline" className="w-full">
                Sign in with a one-time code
              </Button>
            </Link>

            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/auth/signup" className="text-primary underline underline-offset-4 hover:text-primary/80">
                Create an account
              </Link>
            </p>
          </CardContent>
        </Card>
    </AuthShell>
  )
}

/** Carries the chosen address and any pending destination over to the one-time-code page. */
function magicLinkQuery(email: string, next: string | null): string {
  const q = new URLSearchParams()
  if (email.trim()) q.set('email', email.trim())
  if (next) q.set('next', next)
  const s = q.toString()
  return s ? `?${s}` : ''
}
