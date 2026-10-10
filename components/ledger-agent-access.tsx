'use client'

import { useEffect, useState } from 'react'
import { Loader2, Copy, Check, Trash2, Lock, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AGENT_TOOL_MANIFEST } from '@/lib/accounting/agent-tools-manifest'
import { PORTFOLIO_TOOL_MANIFEST } from '@/lib/agent/portfolio-tools-manifest'
import { DILIGENCE_TOOL_MANIFEST } from '@/lib/agent/diligence-tools-manifest'
import { DEALS_TOOL_MANIFEST } from '@/lib/agent/deals-tools-manifest'
import { LP_TOOL_MANIFEST } from '@/lib/agent/lp-tools-manifest'
import { DASHBOARD_TOOL_MANIFEST } from '@/lib/agent/dashboard-tools-manifest'

// One surface, one key, the whole firm — deal flow at the top of the funnel, the deals
// under diligence, what the fund ended up owning, what the LPs hold, and what the books
// say. Grouped so the list reads as capability rather than a flat wall of names, and
// ordered the way the money actually travels.
const TOOL_GROUPS = [
  { label: 'Deal flow (inbound screening)', tools: DEALS_TOOL_MANIFEST },
  { label: 'Diligence (data room, checklist, memo)', tools: DILIGENCE_TOOL_MANIFEST },
  { label: 'Portfolio, companies and performance', tools: PORTFOLIO_TOOL_MANIFEST },
  { label: 'LP reporting and capital accounts', tools: LP_TOOL_MANIFEST },
  { label: 'Ledger and accounting', tools: AGENT_TOOL_MANIFEST },
  // Served over MCP only: the REST endpoint has nowhere to draw a view.
  { label: 'Dashboards in the conversation (MCP only)', tools: DASHBOARD_TOOL_MANIFEST },
]
const TOOL_COUNT = TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0)

interface Key { id: string; name: string; key_prefix: string; scopes: string; last_used_at: string | null; revoked_at: string | null; created_at: string }

/**
 * Agent access: the caller's own API keys plus the MCP/REST endpoints an agent connects
 * to. Keys act as their owner — any member's key can read; only an admin's key can
 * write. Non-admins can mint read-only keys only.
 */
export function LedgerAgentAccess({ isAdmin, section = 'keys' }: { isAdmin: boolean; section?: 'toggle' | 'keys' }) {
  const [keys, setKeys] = useState<Key[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [mcpUrl, setMcpUrl] = useState('')
  const [restUrl, setRestUrl] = useState('')
  const [showTools, setShowTools] = useState(false)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [savingEnabled, setSavingEnabled] = useState(false)

  useEffect(() => {
    // The canonical addresses. Both surfaces long outgrew the "accounting" name —
    // they serve the whole portfolio too — so neither is under /api/accounting any
    // more. The legacy /api/accounting/mcp still works for keys and configs already
    // pointed at it; the REST endpoint moved outright, since nothing used it yet.
    setMcpUrl(`${window.location.origin}/api/mcp`)
    setRestUrl(`${window.location.origin}/api/agent`)

    fetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(s => setEnabled(!!s?.agentApiEnabled))
      .catch(() => setEnabled(false))

    load()
  }, [])

  async function setAgentApi(next: boolean) {
    setSavingEnabled(true)
    setEnabled(next) // optimistic
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentApiEnabled: next }),
    })
    if (!res.ok) setEnabled(!next) // roll back rather than lie about the state
    else if (next) load()
    setSavingEnabled(false)
  }

  function load() {
    setLoading(true)
    fetch('/api/accounting/keys').then(r => (r.ok ? r.json() : [])).then(d => setKeys(Array.isArray(d) ? d : [])).finally(() => setLoading(false))
  }

  async function create() {
    if (!name.trim()) return
    setCreating(true); setNewToken(null)
    const res = await fetch('/api/accounting/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, readOnly }) })
    const data = await res.json()
    if (res.ok) { setNewToken(data.token); setName(''); load() }
    setCreating(false)
  }

  async function revoke(id: string) {
    await fetch(`/api/accounting/keys?id=${id}`, { method: 'DELETE' })
    load()
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 1500)
  }

  const active = keys.filter(k => !k.revoked_at)

  // The master switch, shown only to admins. Split out so it can render on its own
  // (in Organization settings) while the per-user keys UI below lives in Account.
  if (section === 'toggle') {
    if (!isAdmin) return null
    return (
      <label className="flex items-start gap-2 text-sm cursor-pointer rounded-card border border-warning/40 bg-warning/5 p-3">
        <input
          type="checkbox"
          checked={!!enabled}
          onChange={e => setAgentApi(e.target.checked)}
          disabled={savingEnabled || enabled === null}
          className="mt-1 h-3.5 w-3.5"
        />
        <span>
          <span className="flex items-center gap-2 font-medium">
            Allow agents to reach this fund
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-warning">
              <Lock className="h-3 w-3" />Admin only
            </span>
          </span>
          <span className="block text-xs text-muted-foreground">
            Turns the MCP endpoint, the REST API, and API keys on or off for the whole fund. Off by
            default. Turning it off makes every existing key and connected app inert immediately —
            nothing is deleted, and switching it back on restores them exactly as they were.
          </span>
        </span>
        {savingEnabled && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
      </label>
    )
  }

  // section === 'keys': per-user API keys + endpoints. The admin toggle lives elsewhere
  // (Organization settings); non-admins (and admins, before they flip it on) get a hint
  // here instead of the control they can't use.
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Connect an AI agent (Claude, or anything that speaks MCP) to your fund over MCP or REST.
        It can ask what the fund owns, how each company and vehicle is performing, who the LPs are,
        and what the books say. Agents act as the person who authorized them: {isAdmin
          ? 'as an admin, yours can read everything and write — record investments, post entries, run allocations and closes.'
          : 'yours can read the portfolio, performance and the ledger; writing requires an admin.'}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Agent writes to the ledger land as <strong>drafts</strong> for you to review — recording an
        investment drafts the journal entry it implies rather than posting it.
      </p>

      {enabled === false && (
        <div className="rounded-card border bg-muted/30 p-3 text-xs text-muted-foreground">
          Agent access is turned off for this fund. An admin can enable it here in Settings.
        </div>
      )}

      {enabled && (
      <>
      {/* Endpoints */}
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-12 shrink-0 text-xs">MCP</span>
          <code className="flex-1 bg-muted rounded px-2 py-1 text-xs font-mono truncate">{mcpUrl || '…'}</code>
          <button onClick={() => copy(mcpUrl, 'mcp')} className="text-muted-foreground hover:text-foreground">{copied === 'mcp' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}</button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-12 shrink-0 text-xs">REST</span>
          <code className="flex-1 bg-muted rounded px-2 py-1 text-xs font-mono truncate">{restUrl || '…'}</code>
          <button onClick={() => copy(restUrl, 'rest')} className="text-muted-foreground hover:text-foreground">{copied === 'rest' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}</button>
        </div>
      </div>

      {/* How to actually connect. This was the missing piece: people pasted the MCP
          URL into Claude's connector, hit the OAuth wall, and had nothing to go on. */}
      <div className="rounded-card border bg-muted/30 p-3 space-y-2">
        <p className="text-xs font-medium">Connecting Claude</p>
        <ul className="text-xs text-muted-foreground space-y-1.5 list-disc ml-4">
          <li>
            <strong>claude.ai / Claude Desktop</strong> — add the MCP URL above as a custom connector.
            It signs you in through this app and asks you to approve the connection; no API key needed,
            and nothing to paste into the &ldquo;OAuth Client ID&rdquo; box, which you can leave empty.
          </li>
          <li>
            <strong>Claude Code / other CLI clients</strong> — these pass a key in a header instead:
            <code className="block bg-background rounded px-2 py-1 mt-1 font-mono text-[11px] whitespace-pre-wrap break-all">
              claude mcp add --transport http fund {mcpUrl} --header &quot;Authorization: Bearer YOUR_KEY&quot;
            </code>
          </li>
        </ul>
      </div>

      {/* The plugin: the same connector plus the skills that tell an assistant when to open a
          dashboard and how to save one. Built by this deployment for this address, because a
          plugin's connector URL is fixed inside the package (lib/plugin/build.ts). */}
      <div className="rounded-card border bg-muted/30 p-3 space-y-2">
        <p className="text-xs font-medium">Dashboards in Claude and ChatGPT</p>
        <p className="text-xs text-muted-foreground">
          Open the portfolio, a company, the financial statements or LP capital as a dashboard inside
          the conversation, ask questions about what you see, and save a dashboard to reopen it any
          time. Saved dashboards are kept here, so they open on current figures in either assistant.
          The plugin is built for this address and contains no key: you sign in when you connect it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href="/api/plugin?target=claude" download><Download className="h-3.5 w-3.5" />Plugin for Claude</a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/api/plugin?target=chatgpt" download><Download className="h-3.5 w-3.5" />Plugin for ChatGPT</a>
          </Button>
        </div>
        <ul className="text-xs text-muted-foreground space-y-1.5 list-disc ml-4">
          <li>
            <strong>Claude</strong> — in Customize, open Plugins, choose Add, then Upload plugin, and
            select the file. Open the plugin&rsquo;s Connectors tab, connect it and sign in. Then ask
            Claude to &ldquo;show me the portfolio&rdquo;.
          </li>
          <li>
            <strong>ChatGPT</strong> — in Plugins, choose the plus button, then Add custom MCP server,
            paste the MCP URL above and create it as a plugin. That is all the dashboards need. The
            download adds the skills for the ChatGPT desktop app: unzip it into a plugin marketplace
            folder (DOCS.md has the steps).
          </li>
        </ul>
      </div>

      {newToken && (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="text-warning mb-1">Copy this token now — it won&rsquo;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-background rounded px-2 py-1 text-xs font-mono truncate">{newToken}</code>
            <button onClick={() => copy(newToken, 'token')} className="text-muted-foreground hover:text-foreground">{copied === 'token' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Key name (e.g. Claude agent)" className="border rounded px-2 py-1.5 text-sm flex-1 bg-transparent" />
        {isAdmin && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />read-only</label>
        )}
        <Button size="sm" onClick={create} disabled={creating || !name.trim()}>{creating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Create key</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">You can create as many keys as you need — one per agent or integration.</p>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active keys.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {active.map(k => (
              <tr key={k.id} className="border-t">
                <td className="py-1.5">{k.name}</td>
                <td className="py-1.5 font-mono text-xs text-muted-foreground">{k.key_prefix}…</td>
                <td className="py-1.5 text-xs text-muted-foreground">{k.scopes}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{k.last_used_at ? 'used' : 'unused'}</td>
                <td className="py-1.5 text-right"><button onClick={() => revoke(k.id)} className="text-muted-foreground hover:text-destructive" title="Revoke"><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button onClick={() => setShowTools(v => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        {showTools ? 'Hide' : 'Show'} available tools ({TOOL_COUNT})
      </button>
      {showTools && (
        <div className="space-y-4">
          {TOOL_GROUPS.map(g => (
            <div key={g.label} className="space-y-1.5">
              <p className="text-xs font-medium">{g.label} <span className="text-muted-foreground font-normal">({g.tools.length})</span></p>
              {g.tools.map(t => (
                <div key={t.name} className="text-sm flex gap-2">
                  <code className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono shrink-0">{t.name}</code>
                  <span className={`text-[10px] uppercase tracking-wider px-1 py-0.5 rounded self-center shrink-0 ${t.scope === 'write' ? 'bg-warning-subtle text-warning dark:bg-warning-subtle/30 dark:text-warning' : 'bg-muted text-muted-foreground'}`}>{t.scope}</span>
                  <span className="text-muted-foreground text-xs self-center">{t.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  )
}
