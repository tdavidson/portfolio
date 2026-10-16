import { redirect } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient, getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClient, redirectUriAllowed, grantableScope } from '@/lib/oauth/store'
import { canWriteAnywhere, loadAccessContext } from '@/lib/access/effective'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthShell } from '@/components/auth-shell'
import { ConsentForm } from './consent-form'
import { fundCreationRefusal } from '@/lib/onboarding/create-fund'
import { audienceOf } from '@/lib/oauth/audience'
import { lpFundsFor, lpGrantableScope } from '@/lib/portal/principal'
import { InvestorConsentForm } from './investor-consent-form'

/**
 * The OAuth consent screen — where a human decides whether an agent may act on
 * their fund.
 *
 * Validation happens here so the PERSON sees a sensible error instead of a broken
 * redirect. It is not the security boundary: /api/oauth/consent re-validates
 * everything, because this page's checks live in a request a caller controls.
 *
 * The one rule that matters on this page: if the client or the redirect_uri
 * doesn't check out, render an error HERE and never bounce to the supplied URI.
 * Redirecting to an unvalidated URI with a code attached is the open-redirect that
 * this whole flow exists to avoid.
 */

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AuthorizePage(props: Props) {
  const searchParams = await props.searchParams;
  const q = (k: string): string | null => {
    const v = searchParams[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  const responseType = q('response_type')
  const clientId = q('client_id')
  const redirectUri = q('redirect_uri')
  const codeChallenge = q('code_challenge')
  const codeChallengeMethod = q('code_challenge_method') ?? 'S256'
  const scope = q('scope')
  const state = q('state')
  const resource = q('resource')

  // Require a signed-in human BEFORE anything else, and come back here afterwards.
  const supabase = await createClient()
  const user = await getUser()
  // This same request, to come back to after signing in, or after switching account.
  const self = `/oauth/authorize?${new URLSearchParams(
    Object.entries(searchParams).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v] as [string, string]] : []
    )
  ).toString()}`
  if (!user) {
    redirect(`/auth?next=${encodeURIComponent(self)}`)
  }

  if (!clientId || !redirectUri) {
    return <Problem title="Invalid request" detail="This authorization link is missing its client_id or redirect_uri." />
  }
  if (responseType !== 'code') {
    return <Problem title="Unsupported request" detail={`Only the authorization-code flow is supported (got response_type="${responseType ?? 'none'}").`} />
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return <Problem title="Insecure request" detail="This server requires PKCE with S256. The app that sent you here did not provide a valid code challenge." />
  }

  const admin = createAdminClient()
  const client = await getClient(admin, clientId)
  if (!client) {
    return <Problem title="Unknown application" detail="The app requesting access is not registered with this server." />
  }
  if (!redirectUriAllowed(client, redirectUri)) {
    return <Problem title="Invalid redirect" detail="The app asked to be sent back to an address it never registered. Refusing, in case someone is trying to steal the authorization." />
  }

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user!.id)
    .maybeSingle()

  // The investor connector (app/api/portal/mcp): the assistant asked for it by resource, or it
  // named none and this person is an investor with no fund membership, so the investor connector is
  // the only thing they could be connecting. Never falls through to the fund branches below, so an
  // investor can't be offered a new fund, and a fund member can't hand over the fund here.
  const lpFunds = audienceOf(resource) === 'portal' || (!resource && !membership)
    ? await lpFundsFor(admin, user!.id)
    : null
  if (audienceOf(resource) === 'portal' || (!resource && !membership && lpFunds)) {
    if (!lpFunds) {
      return <Problem title="No investor account" detail="This connector is for investors. Your sign-in has no active investor account here." />
    }
    const available = lpFunds.funds.filter(f => f.connectorOn)
    if (available.length === 0) {
      return (
        <Problem
          title="Not available yet"
          detail="Your fund hasn't turned on connecting an assistant to the investor portal. You can still use the portal on the web, or ask the fund to turn this on."
        />
      )
    }
    return (
      <InvestorConsentForm
        clientName={client.client_name ?? 'An external application'}
        funds={available.map(f => ({ id: f.fundId, name: f.name }))}
        willWrite={lpGrantableScope(scope).includes('write')}
        params={{
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          scope: lpGrantableScope(scope),
          state,
          resource,
        }}
      />
    )
  }

  if (!membership) {
    // No fund yet: name one here and the assistant sets the rest up (setup_status, setup_fund).
    // The consent route creates it on Allow, as its admin, with agent access on.
    const refusal = await fundCreationRefusal(admin, user!.id)
    if (refusal) return <Problem title="No fund" detail={refusal} />
    return (
      <ConsentForm
        userEmail={user!.email ?? ''}
        returnTo={self}
        clientName={client.client_name ?? 'An external application'}
        fundName=""
        newFund
        willWrite
        downgraded={false}
        params={{
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          scope: grantableScope(scope, 'admin', true),
          state,
          resource,
        }}
      />
    )
  }
  const { fund_id: fundId, role } = membership as { fund_id: string; role: string }

  if (role === 'viewer') {
    return <Problem title="Read-only demo" detail="The demo account cannot authorize external agents." />
  }

  if (!(await agentApiEnabled(admin, fundId))) {
    return (
      <Problem
        title="Agent access is turned off"
        detail="An admin of this fund has not enabled the agent API. Turn it on in Settings → Agent access, then try connecting again."
      />
    )
  }

  const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).maybeSingle()

  // What they'd actually get. The screen must say so rather than promise something it won't
  // deliver — so this consults the same grants the tool calls will, not just the role. A member
  // who is read-only everywhere sees "read", because that is what their token will do.
  const access = await loadAccessContext(admin, fundId, user!.id, role)
  const granted = grantableScope(scope, role, canWriteAnywhere(access))
  const willWrite = granted.includes('write')

  return (
    <ConsentForm
        userEmail={user!.email ?? ''}
        returnTo={self}
      clientName={client.client_name ?? 'An external application'}
      fundName={(fund as { name?: string } | null)?.name ?? 'your fund'}
      willWrite={willWrite}
      downgraded={!!scope?.includes('write') && !willWrite}
      params={{
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        scope: granted,
        state,
        resource,
      }}
    />
  )
}

/**
 * Every dead end in this flow — bad client, bad redirect, agent access switched off.
 *
 * It wears the same chrome as the consent screen and the sign-in page on purpose: the
 * person seeing this was midway through connecting an agent to their fund, and an
 * unstyled error page at that moment reads as "something is broken" or, worse, as a
 * phishing page. Note there is deliberately no way onward from here except home — we must
 * never offer a link back to a redirect_uri we just refused to trust.
 */
function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <AuthShell>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <CardTitle className="text-lg">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{detail}</p>
        </CardContent>
      </Card>
    </AuthShell>
  )
}
