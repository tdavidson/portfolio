'use client'

import { useState } from 'react'
import { Loader2, ShieldCheck, PencilLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AuthShell } from '@/components/auth-shell'
import { Label } from '@/components/ui/label'
import { RedirectHost } from './redirect-host'

/**
 * The approve/deny screen for the investor connector: an LP connecting an assistant to their own
 * portal for ONE fund. Read is what the web portal shows them; write is two things they can already
 * do there, acknowledging a capital call wire and messaging the fund.
 */

interface Props {
  clientName: string
  /** Funds they invest in whose connector is on. More than one: they pick. */
  funds: { id: string; name: string }[]
  willWrite: boolean
  params: {
    client_id: string
    redirect_uri: string
    code_challenge: string
    scope: string
    state: string | null
    resource: string | null
  }
}

export function InvestorConsentForm({ clientName, funds, willWrite, params }: Props) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fundId, setFundId] = useState(funds[0]?.id ?? '')
  const fundName = funds.find(f => f.id === fundId)?.name ?? 'your fund'

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny')
    setError(null)
    try {
      const res = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, approve, investor: true, fund_id: fundId }),
      })
      const body = await res.json()
      if (!res.ok || !body.redirect) {
        setError(body.error ?? 'Could not complete authorization.')
        setBusy(null)
        return
      }
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
          It can only see your own investment in {fundName}, never other investors or other funds. You
          can disconnect it at any time in the portal&apos;s settings, and it stops working if the fund
          turns this off.
        </p>
      }
    >
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Connect {clientName}?</CardTitle>
          <CardDescription>
            It is asking to open your investor portal for <span className="font-medium text-foreground">{fundName}</span> as you.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <RedirectHost redirectUri={params.redirect_uri} />
          {funds.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="lp-fund">Fund</Label>
              <select
                id="lp-fund"
                value={fundId}
                onChange={e => setFundId(e.target.value)}
                className="w-full h-9 rounded-md border bg-background px-3 text-sm"
              >
                {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}

          <div className="rounded-card border bg-muted/30 p-3 space-y-3">
            <div className="flex gap-2.5">
              <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-xs font-medium">Read your investment</p>
                <p className="text-xs text-muted-foreground">
                  Your capital account statement, letters and documents the fund has shared with you,
                  capital call notices, your messages with the fund, and your onboarding status.
                </p>
              </div>
            </div>

            {willWrite ? (
              <div className="flex gap-2.5 border-t pt-3">
                <PencilLine className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-warning">Act for you</p>
                  <p className="text-xs text-muted-foreground">
                    Tell the fund you&apos;ve wired a capital call, and send the fund a message in your name.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex gap-2.5 border-t pt-3">
                <PencilLine className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Read-only.</span> It cannot send anything to the fund.
                </p>
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2 pt-1">
            <Button onClick={() => decide(true)} disabled={busy !== null || !fundId} className="flex-1">
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
