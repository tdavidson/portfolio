'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

/**
 * Reusable 6-digit one-time-code entry. Used by every email OTP flow
 * (magic-link sign-in, password recovery, signup confirmation) and, later, by
 * the LP-portal invite flow. The parent owns sending the code; this owns the
 * code input, verify, and resend.
 */
export function OtpCodeForm({
  email,
  onVerify,
  onResend,
  verifying = false,
  error = null,
}: {
  email: string
  onVerify: (code: string) => void
  onResend: () => void
  verifying?: boolean
  error?: string | null
}) {
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertDescription>
          We emailed a 6-digit code to <strong>{email}</strong>. Enter it below, it expires in 10 minutes.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="otp-code">Verification code</Label>
        <Input
          id="otp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={e => { if (e.key === 'Enter' && code.length === 6) onVerify(code) }}
          autoFocus
          className="text-center text-lg tracking-[0.5em]"
        />
      </div>

      <Button className="w-full" onClick={() => onVerify(code)} disabled={verifying || code.length !== 6}>
        {verifying ? 'Verifying…' : 'Verify & continue'}
      </Button>

      <button
        type="button"
        onClick={() => { onResend(); setResent(true) }}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        {resent ? 'Code resent, check your email' : "Didn't get a code? Resend"}
      </button>
    </div>
  )
}
