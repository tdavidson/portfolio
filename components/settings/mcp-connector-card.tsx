'use client'

import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MCP_SERVERS, type McpServerDefinition } from '@/lib/mcp-client/servers'

/**
 * Connect your own account on an outside MCP server (lib/mcp-client/servers.ts).
 *
 * Per USER, like Affinity: each member signs in to the outside service themselves, and the
 * assistant reaches it only with the asking member's own sign-in, so nobody sees data they
 * couldn't open there.
 */

interface Status {
  connected: boolean
  readTools: number
  lastError: string | null
  connectedAt: string | null
}

const ERRORS: Record<string, string> = {
  registration_unsupported: 'This service doesn’t let apps register for sign-in yet.',
  registration_failed: 'The service refused to register this app for sign-in.',
  discovery_failed: 'Couldn’t find the service’s sign-in page.',
  consent_denied: 'Sign-in was cancelled.',
  invalid_state: 'The sign-in expired or came from another browser. Try again.',
  token_exchange_failed: 'The service didn’t finish the sign-in. Try again.',
}

function McpConnectorCard({ server }: { server: McpServerDefinition }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const empty: Status = { connected: false, readTools: 0, lastError: null, connectedAt: null }
    fetch(`/api/settings/connectors/${server.id}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(s => {
        setStatus(s ?? empty)
        // The callback lands back on /settings with the outcome in the query string.
        const params = new URLSearchParams(window.location.search)
        if (params.get('connector') !== server.id) return
        const error = params.get('connector_error')
        if (error) setNotice({ ok: false, text: ERRORS[error] ?? `Couldn’t connect to ${server.name}. Try again.` })
        else if (params.get('connector_connected')) setNotice({ ok: true, text: `Connected to ${server.name}.` })
      })
  }, [server.id, server.name])

  async function disconnect() {
    setBusy(true)
    await fetch(`/api/settings/connectors/${server.id}`, { method: 'DELETE' })
    setStatus({ connected: false, readTools: 0, lastError: null, connectedAt: null })
    setNotice(null)
    setBusy(false)
  }

  // A plain link: the connect route answers with a redirect to the service's sign-in page.
  const connectHref = `/api/settings/connectors/${server.id}/connect`

  if (!status) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{server.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{server.description}</p>
        <p className="text-xs text-muted-foreground">
          {server.usedFor} You sign in with your own {server.name} account, so it only sees what you
          can. The assistant may only read from {server.name}: it can’t create or change anything
          there. Works when the fund’s AI provider is Claude.
        </p>

        {notice && (
          <div className={`flex items-start gap-2 text-sm ${notice.ok ? 'text-success' : 'text-destructive'}`}>
            {notice.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
            <span>{notice.text}</span>
          </div>
        )}

        {status.connected ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span>
                Connected
                {status.readTools > 0 && (
                  <span className="text-muted-foreground"> · {status.readTools} read-only tools available</span>
                )}
              </span>
            </div>
            {status.lastError && (
              <div className="flex items-start gap-2 text-sm text-warning">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{status.lastError}</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" asChild disabled={busy}><a href={connectHref}>Reconnect</a></Button>
              <Button variant="outline" onClick={disconnect} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Disconnect'}
              </Button>
            </div>
          </>
        ) : (
          <Button asChild><a href={connectHref}>Connect {server.name}</a></Button>
        )}
      </CardContent>
    </Card>
  )
}

/** One card per connector the app knows about. */
export function McpConnectors() {
  return <>{MCP_SERVERS.map(s => <McpConnectorCard key={s.id} server={s} />)}</>
}
