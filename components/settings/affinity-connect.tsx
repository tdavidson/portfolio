'use client'

import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Connect an Affinity API key.
 *
 * This is PER USER, not per fund — Affinity issues one key per person and scopes
 * it to what that person can see. That's a feature, not a limitation: the
 * assistant and the sync can never surface CRM records the user couldn't open
 * themselves. The notes they import still land in the shared data room.
 */

interface Status {
  connected: boolean
  affinity_user_email: string | null
  affinity_user_name: string | null
  last_verified_at: string | null
  last_error: string | null
}

export function AffinityConnect() {
  const [status, setStatus] = useState<Status | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The assistant's Affinity transport is a FUND setting, so it rides on /api/settings
  // rather than the per-user key endpoint, and only an admin may change it.
  const [isAdmin, setIsAdmin] = useState(false)
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [savingMcp, setSavingMcp] = useState(false)

  useEffect(() => {
    fetch('/api/settings/affinity')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, affinity_user_email: null, affinity_user_name: null, last_verified_at: null, last_error: null }))

    fetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(s => {
        if (!s) return
        setIsAdmin(!!s.isAdmin)
        setMcpEnabled(!!s.affinityMcpEnabled)
      })
      .catch(() => {})
  }, [])

  async function setMcp(next: boolean) {
    setSavingMcp(true)
    setMcpEnabled(next) // optimistic
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ affinityMcpEnabled: next }),
    })
    if (!res.ok) setMcpEnabled(!next) // roll back rather than lie about the state
    setSavingMcp(false)
  }

  async function connect() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/affinity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Could not connect')
        return
      }
      setStatus({
        connected: true,
        affinity_user_email: body.affinity_user_email,
        affinity_user_name: body.affinity_user_name,
        last_verified_at: new Date().toISOString(),
        last_error: null,
      })
      setApiKey('')
    } catch {
      setError('Could not reach Affinity.')
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    setSaving(true)
    await fetch('/api/settings/affinity', { method: 'DELETE' })
    setStatus({ connected: false, affinity_user_email: null, affinity_user_name: null, last_verified_at: null, last_error: null })
    setSaving(false)
  }

  if (!status) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Affinity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Connect your Affinity account to pull company notes and attached files into diligence
          data rooms, and to let the diligence assistant answer questions about your relationship
          history.
        </p>
        <p className="text-xs text-muted-foreground">
          Affinity issues one key per person, scoped to what you can see. Yours is stored encrypted
          and is never shown again after you save it. Notes you import go into the shared data room
          for the whole fund.
        </p>

        {status.connected ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span>
                Connected as {status.affinity_user_name ?? status.affinity_user_email ?? 'your Affinity account'}
                {status.affinity_user_name && status.affinity_user_email && (
                  <span className="text-muted-foreground"> ({status.affinity_user_email})</span>
                )}
              </span>
            </div>

            {status.last_error && (
              <div className="flex items-start gap-2 text-sm text-warning">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{status.last_error} Re-enter your key below to reconnect.</span>
              </div>
            )}

            <div className="flex gap-2">
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Replace with a new key…"
                autoComplete="off"
              />
              <Button onClick={connect} disabled={saving || !apiKey.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
              </Button>
              <Button variant="outline" onClick={disconnect} disabled={saving}>
                Disconnect
              </Button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && apiKey.trim()) connect() }}
              placeholder="Affinity API key"
              autoComplete="off"
            />
            <Button onClick={connect} disabled={saving || !apiKey.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="text-xs text-muted-foreground">
          Generate a key in Affinity under Settings → API. Requires the “Generate an API key”
          permission from your Affinity admin.
        </p>

        {/* How the sync actually behaves. It was doing all of this already and saying none
            of it, so nobody could tell whether they had to press anything. */}
        {status.connected && (
          <div className="rounded-card border bg-muted/30 p-3 space-y-1.5">
            <p className="text-xs font-medium">How the sync works</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc ml-4">
              <li>
                <strong>Link a deal once</strong> to an Affinity organization on the deal&rsquo;s
                Diligence page. Nothing syncs until you do — the app will not guess which CRM
                record a deal is.
              </li>
              <li>
                <strong>Then it pulls automatically, hourly</strong>, for every active deal:
                new notes and attached files land in that deal&rsquo;s data room. Passed and won
                deals stop syncing.
              </li>
              <li>
                <strong>&ldquo;Import now&rdquo;</strong> on the deal forces an immediate pull if you
                don&rsquo;t want to wait for the hour.
              </li>
            </ul>
          </div>
        )}

        {/* The assistant's Affinity transport. This flag existed and was read by the
            diligence chat, but nothing could ever set it — so the MCP path was dead code. */}
        {status.connected && isAdmin && (
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={mcpEnabled}
              onChange={e => setMcp(e.target.checked)}
              disabled={savingMcp}
              className="mt-1 h-3.5 w-3.5"
            />
            <span>
              Let the assistant query Affinity live
              <span className="block text-xs text-muted-foreground">
                Uses Affinity&rsquo;s hosted MCP server rather than the three built-in REST tools, so
                the assistant can reach lists, fields and relationship data instead of just notes and
                files. Fund-wide — but each person still authenticates with their own key, so nobody
                sees a CRM record they couldn&rsquo;t open in Affinity themselves. Only its read-only
                tools are turned on: the assistant reads Affinity, it never changes it.
              </span>
            </span>
            {savingMcp && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
          </label>
        )}
      </CardContent>
    </Card>
  )
}
