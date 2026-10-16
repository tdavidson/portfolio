'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { AuthShell } from '@/components/auth-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { OtpCodeForm } from '@/components/auth/otp-code-form'
import { safeNextPath } from '@/lib/safe-redirect'

export default function MagicLinkPage() {
  return (
    <Suspense>
      <MagicLinkForm />
    </Suspense>
  )
}

function MagicLinkForm() {
  // Carried over from the sign-in page: the account picked there, and where to land afterwards
  // (e.g. the agent consent screen a "Switch account" started from).
  const searchParams = useSearchParams()
  const next = safeNextPath(searchParams.get('next')) ?? '/'
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '')
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const supabase = createClient()

  async function handleSend() {
    if (!email.trim()) {
      setError('Enter your email address.')
      return
    }
    setError(null)
    setLoading(true)
    // Sign-in only — don't create accounts from this flow.
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    })
    if (error) setError(error.message)
    else setSent(true)
    setLoading(false)
  }

  async function handleVerify(code: string) {
    setError(null)
    setVerifying(true)
    const { error } = await supabase.auth.verifyOtp({
      type: 'email',
      email: email.trim().toLowerCase(),
      token: code,
    })
    if (error) {
      setError(error.message)
      setVerifying(false)
    } else {
      // Run server-side post-login side effects, then land the user.
      window.location.href = `/auth/post-login?method=magic_link&next=${encodeURIComponent(next)}`
    }
  }

  return (
    <AuthShell>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Sign in with a one-time code</CardTitle>
            <CardDescription>
              {sent
                ? 'Enter the 6-digit code we emailed you.'
                : "We'll email you a 6-digit code that signs you in, no password needed."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sent ? (
              <OtpCodeForm
                email={email.trim().toLowerCase()}
                onVerify={handleVerify}
                onResend={handleSend}
                verifying={verifying}
                error={error}
              />
            ) : (
              <>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                    autoComplete="email"
                    autoFocus
                  />
                </div>
                <Button className="w-full" onClick={handleSend} disabled={loading}>
                  {loading ? 'Sending…' : 'Email me a code'}
                </Button>
              </>
            )}

            <p className="text-center text-sm text-muted-foreground">
              <Link href={next === '/' ? '/auth' : `/auth?next=${encodeURIComponent(next)}`} className="text-primary underline underline-offset-4 hover:text-primary/80">
                Sign in with password
              </Link>
            </p>
          </CardContent>
        </Card>
    </AuthShell>
  )
}
