'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Check, Loader2 } from 'lucide-react'
import { Section } from '@/components/settings/section'

/**
 * Set or change the signed-in user's password. People who sign in with one-time email codes
 * have no password; this lets them add one without going through "Forgot password".
 * Mirrors the card on the LP portal's settings page.
 */
export function PasswordSection() {
  const supabase = createClient()
  // null = unknown (the lookup function is missing or failed): show neutral wording.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('current_user_has_password').then(({ data, error }) => {
      if (!cancelled && !error && typeof data === 'boolean') setHasPassword(data)
    })
    return () => { cancelled = true }
  }, [supabase])

  async function save() {
    setErr(null); setMsg(null)
    if (pw.length < 8) { setErr('Use at least 8 characters.'); return }
    if (pw !== pw2) { setErr('Passwords don’t match.'); return }
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setPw(''); setPw2('')
    setMsg(hasPassword === false ? 'Password set. You can now sign in with it or with a code.' : 'Password updated.')
    setHasPassword(true)
  }

  const title = hasPassword === false ? 'Set password' : hasPassword ? 'Change password' : 'Password'
  const description = hasPassword === false
    ? 'You sign in with one-time codes. Add a password to sign in with it as well.'
    : 'You can always sign in with a one-time code instead.'

  return (
    <Section title={title}>
      <p className="text-xs text-muted-foreground mb-3">{description}</p>
      <div className="space-y-3 max-w-sm">
        <div className="space-y-1.5">
          <Label htmlFor="settings-pw">New password</Label>
          <Input id="settings-pw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-pw2">Confirm password</Label>
          <Input id="settings-pw2" type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" onKeyDown={e => e.key === 'Enter' && save()} />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {msg && <p className="text-xs text-success inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> {msg}</p>}
        <Button size="sm" onClick={save} disabled={busy || !pw || !pw2}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          {hasPassword === false ? 'Set password' : 'Update password'}
        </Button>
      </div>
    </Section>
  )
}
