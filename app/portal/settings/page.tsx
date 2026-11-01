'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MfaSettings } from '@/components/account/mfa-settings'
import { PortalChangeRequests } from '@/components/portal/change-requests'
import { useTheme } from 'next-themes'
import { Loader2, Check, UserCheck, Trash2, Monitor, Sun, Moon, Copy, Plug } from 'lucide-react'

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

// Supabase embeds can arrive as an object or a single-element array depending on
// the relation; normalize to a plain object.
const one = (v: any) => (Array.isArray(v) ? v[0] : v) ?? null

export default function PortalSettingsPage() {
  const supabase = createClient()

  // ── Appearance ──
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const currentTheme = mounted && theme && ['system', 'light', 'dark'].includes(theme) ? theme : 'system'

  // ── Change password ──
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<string | null>(null)
  const [pwErr, setPwErr] = useState<string | null>(null)

  async function changePassword() {
    setPwErr(null); setPwMsg(null)
    if (pw.length < 8) { setPwErr('Use at least 8 characters.'); return }
    if (pw !== pw2) { setPwErr('Passwords don’t match.'); return }
    setPwBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setPwBusy(false)
    if (error) { setPwErr(error.message); return }
    setPw(''); setPw2(''); setPwMsg('Password updated.')
  }

  // ── Authorized users ──
  const [rows, setRows] = useState<any[]>([])
  const [loadingAu, setLoadingAu] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/portal/authorized-users')
      .then(r => (r.ok ? r.json() : { authorized_users: [] }))
      .then(b => setRows(b.authorized_users ?? []))
      .finally(() => setLoadingAu(false))
  }, [])

  async function revoke(id: string) {
    setRevoking(id)
    const res = await fetch(`/api/portal/authorized-users?id=${id}`, { method: 'DELETE' })
    setRevoking(null)
    if (res.ok) setRows(prev => prev.filter(r => r.id !== id))
  }

  // ── Assistant connector (app/api/portal/mcp) ──
  const [conn, setConn] = useState<{ funds: { fundId: string; name: string; connectorOn: boolean }[]; connections: any[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const connectorUrl = mounted ? `${window.location.origin}/api/portal/mcp` : '/api/portal/mcp'

  useEffect(() => {
    fetch('/api/portal/connections')
      .then(r => (r.ok ? r.json() : null))
      .then(b => setConn(b))
      .catch(() => setConn(null))
  }, [])

  async function disconnect(c: { clientId: string; fundId: string }) {
    const key = `${c.clientId}:${c.fundId}`
    setDisconnecting(key)
    const res = await fetch(`/api/portal/connections?client_id=${encodeURIComponent(c.clientId)}&fund_id=${encodeURIComponent(c.fundId)}`, { method: 'DELETE' })
    setDisconnecting(null)
    if (res.ok) setConn(prev => prev && { ...prev, connections: prev.connections.filter(x => `${x.clientId}:${x.fundId}` !== key) })
  }

  const connectorOn = !!conn?.funds.some(f => f.connectorOn)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage how the portal looks, your sign-in security, and who can access your account.</p>
      </div>

      <SettingsCard title="Your details" description="What the fund has on file for you. Ask for a change, or for access for an advisor; the fund approves each request.">
        <PortalChangeRequests />
      </SettingsCard>

      <SettingsCard title="Appearance" description="Choose how the portal looks on this device.">
        <div className="inline-flex rounded-md border p-0.5 gap-0.5">
          {([['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const).map(([val, Icon, label]) => (
            <button
              key={val}
              onClick={() => setTheme(val)}
              disabled={!mounted}
              className={`inline-flex items-center gap-1.5 px-3 h-8 rounded text-sm transition-colors ${currentTheme === val ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </SettingsCard>

      {conn && (connectorOn || conn.connections.length > 0) && (
        <SettingsCard title="Connect an assistant" description="Ask Claude, ChatGPT or another assistant about your investment: your statement, letters, documents, capital calls and messages.">
          <div className="space-y-3">
            {connectorOn && (
              <>
                <p className="text-xs text-muted-foreground">
                  Add this address as a custom connector in your assistant&apos;s settings, then sign in with your portal account when it asks.
                  It only sees your own investment, and only in the fund you choose.
                </p>
                <div className="flex items-center gap-2 max-w-lg">
                  <Input readOnly value={connectorUrl} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { navigator.clipboard?.writeText(connectorUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </>
            )}
            {conn.connections.length > 0 && (
              <div className="rounded-md border divide-y">
                {conn.connections.map(c => {
                  const key = `${c.clientId}:${c.fundId}`
                  return (
                    <div key={key} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Plug className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{c.clientName}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.fundName} · {c.canAct ? 'can acknowledge wires and message the fund' : 'read-only'}
                        </div>
                      </div>
                      <button onClick={() => disconnect(c)} disabled={disconnecting === key} className="text-sm text-muted-foreground hover:text-destructive inline-flex items-center gap-1 shrink-0">
                        {disconnecting === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Disconnect
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Change password">
        <div className="space-y-3 max-w-sm">
          <div className="space-y-1.5">
            <Label htmlFor="pw">New password</Label>
            <Input id="pw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw2">Confirm password</Label>
            <Input id="pw2" type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" onKeyDown={e => e.key === 'Enter' && changePassword()} />
          </div>
          {pwErr && <p className="text-sm text-destructive">{pwErr}</p>}
          {pwMsg && <p className="text-xs text-success inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> {pwMsg}</p>}
          <Button size="sm" onClick={changePassword} disabled={pwBusy || !pw || !pw2}>
            {pwBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null} Update password
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard title="Two-factor authentication">
        <MfaSettings />
      </SettingsCard>

      <SettingsCard title="Authorized users" description="People your fund has granted access to your account. Revoke access at any time.">
        {loadingAu ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground">No one else has access to your account.</div>
        ) : (
          <div className="rounded-md border divide-y">
            {rows.map(r => {
              const account = one(r.lp_accounts)
              const investor = one(r.lp_investors)
              return (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <UserCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{account?.email ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      Access to {investor?.name ?? 'your account'}
                      {account?.status && account.status !== 'active' && <span className="uppercase tracking-wide ml-2">{account.status}</span>}
                    </div>
                  </div>
                  <button onClick={() => revoke(r.id)} disabled={revoking === r.id} className="text-sm text-muted-foreground hover:text-destructive inline-flex items-center gap-1 shrink-0">
                    {revoking === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Revoke
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}
