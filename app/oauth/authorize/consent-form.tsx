'use client'

import { useState } from 'react'
import { Loader2, ShieldCheck, PencilLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AuthShell } from '@/components/auth-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RedirectHost } from './redirect-host'

/**
 * The approve/deny screen. Deliberately blunt about what is being handed over:
 * this grant lets an agent read the fund's whole portfolio and ledger, and — for
 * an admin — post journal entries and close periods. A vague "authorize app?"
 * prompt would be doing the user a disservice.
 */

interface Props {
  clientName: string
  fundName: string
  willWrite: boolean
  /** They asked for write but aren't an admin, so we're granting read. Say so. */
  downgraded: boolean
  /** Who is signed in, so they can see which account (and so which fund) they're about to hand over. */
  userEmail: string
  /** This authorization request, to resume after "Switch account". */
  returnTo: string
  /** They belong to no fund yet: Allow creates one, named here, with them as its admin. */
  newFund?: boolean
  params: {
    client_id: string
    redirect_uri: string
    code_challenge: string
    scope: string
    state: string | null
    resource: string | null
  }
}

export function ConsentForm({ clientName, fundName, userEmail, returnTo, willWrite, downgraded, newFund, params }: Props) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newFundName, setNewFundName] = useState('')
  const shownFundName = newFund ? newFundName.trim() || 'your new fund' : fundName

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny')
    setError(null)
    try {
      const res = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, approve, ...(newFund ? { fund_name: newFundName.trim() } : {}) }),
      })
      const body = await res.json()
      if (!res.ok || !body.redirect) {
        setError(body.error ?? 'Could not complete authorization.')
        setBusy(null)
        return
      }
      // Hand control back to the app that sent us here.
      window.location.href = body.redirect
    } catch {
      setError('Could not reach the server.')
      setBusy(null)
    }
  }

  return (
    <AuthShell
      wide
      footer={
        <p className="text-center text-xs text-muted-foreground">
          It can only ever see {shownFundName}, never another fund. You can revoke this at any time in
          Settings, and access ends automatically if you leave the fund.
        </p>
      }
    >
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Connect {clientName}?</CardTitle>
          <CardDescription>
            {newFund
              ? <>You don&apos;t have a fund here yet. Name it, and {clientName} can set up the rest with you as its admin.</>
              : <>It is asking to act on <span className="font-medium text-foreground">{fundName}</span> as you.</>}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* One email is one fund, so the account IS the choice of fund. Say which, and offer the
              way to the other one before Allow, not after. */}
          {userEmail && (
            <form action="/api/auth/logout" method="POST" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
              <span className="text-xs text-muted-foreground min-w-0 truncate">
                Signed in as <span className="font-medium text-foreground">{userEmail}</span>
              </span>
              <input type="hidden" name="switch" value="1" />
              <input type="hidden" name="next" value={returnTo} />
              <button type="submit" className="text-xs text-primary underline underline-offset-4 hover:text-primary/80">
                Not this account? Switch
              </button>
            </form>
          )}
          <RedirectHost redirectUri={params.redirect_uri} />
          {newFund && (
            <div className="space-y-1.5">
              <Label htmlFor="fund-name">Fund or firm name</Label>
              <Input id="fund-name" value={newFundName} onChange={e => setNewFundName(e.target.value)} placeholder="e.g. Hemrock Ventures" maxLength={200} autoFocus />
            </div>
          )}
          {/* The permissions, split read vs write. The write block is the one that matters,
              so it gets its own visual weight rather than being a third bullet in a list —
              "post journal entries and close periods" is not a detail. */}
          <div className="rounded-card border bg-muted/30 p-3 space-y-3">
            <div className="flex gap-2.5">
              <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-xs font-medium">Read your fund</p>
                <p className="text-xs text-muted-foreground">
                  Deal flow and diligence, the portfolio, companies and investments, LP positions and
                  fund performance, and the ledger — chart of accounts, journal entries, capital
                  accounts and financial statements.
                </p>
              </div>
            </div>

            {willWrite ? (
              <div className="flex gap-2.5 border-t pt-3">
                <PencilLine className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-warning">Make changes</p>
                  <p className="text-xs text-muted-foreground">
                    Record investments, post journal entries, run allocations, import bank transactions,
                    and close accounting periods.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex gap-2.5 border-t pt-3">
                <PencilLine className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Read-only.</span> It cannot change anything.
                </p>
              </div>
            )}
          </div>

          {downgraded && (
            <Alert className="border-warning bg-warning-subtle">
              <AlertDescription className="text-warning text-sm">
                It asked for write access, but only fund admins can grant that — so it will get read-only.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2 pt-1">
            <Button onClick={() => decide(true)} disabled={busy !== null || (!!newFund && !newFundName.trim())} className="flex-1">
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Allow'}
            </Button>
            <Button variant="outline" onClick={() => decide(false)} disabled={busy !== null} className="flex-1">
              {busy === 'deny' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Deny'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </AuthShell>
  )
}
