'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * The LP portal's master switch, rendered as a row that matches the feature-access rows and sits
 * just above "LP documents & sharing" in the LP Reporting Access panel.
 *
 * It is NOT a visibility level: everything else in that panel decides what your TEAM sees, while
 * this decides whether your INVESTORS have a portal at all. When off, "LP documents & sharing" and
 * "LP activity log" are unavailable to everyone (their pages redirect), so those rows mean nothing
 * until this is on. Uses the same On/Off button styling as the feature rows for a consistent scan.
 */
export function LpPortalRow({ enabled, onSaved }: { enabled: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(enabled)
  const [saving, setSaving] = useState(false)

  const setValue = async (next: boolean) => {
    setOn(next)
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lpPortalEnabled: next }),
    })
    setSaving(false)
    if (res.ok) onSaved()
  }

  const options: { value: boolean; label: string }[] = [
    { value: true, label: 'On' },
    { value: false, label: 'Off' },
  ]

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">LP portal</div>
        <div className="text-xs text-muted-foreground">
          Portal to share documents and performance with LPs. Note, LP documents and sharing and LP activity log can be turned off to prepare materials before enabling the LP portal, thus why there are separate settings.
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {options.map(opt => (
          <button
            key={opt.label}
            onClick={() => setValue(opt.value)}
            disabled={saving}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${ on === opt.value ? 'border-foreground/30 bg-accent font-medium' : 'hover:bg-accent/30' }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The investor connector's switch (app/api/portal/mcp): whether investors may connect Claude,
 * ChatGPT or another assistant to their own portal. Off by default, and inert while the portal is
 * off. Each investor still signs in and consents, and only ever reaches their own investment in
 * this fund; turning it off cuts every connected assistant off on its next call.
 */
export function LpConnectorRow({ enabled, portalOn, onSaved }: { enabled: boolean; portalOn: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const url = typeof window === 'undefined' ? '/api/portal/mcp' : `${window.location.origin}/api/portal/mcp`

  const setValue = async (next: boolean) => {
    setOn(next)
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lpAgentEnabled: next }),
    })
    setSaving(false)
    if (res.ok) onSaved()
    else setOn(!next)
  }

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">Investor connector</div>
        <div className="text-xs text-muted-foreground">
          Lets investors connect Claude, ChatGPT or another assistant to their own portal: their statement, letters,
          documents, capital calls and messages. They can also acknowledge a wire and message you through it.
          {!portalOn && ' Needs the LP portal on.'}
        </div>
        {on && portalOn && (
          <div className="mt-1 text-xs text-muted-foreground">
            Investors add <span className="font-mono text-foreground">{url}</span> as a connector.
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {[{ value: true, label: 'On' }, { value: false, label: 'Off' }].map(opt => (
          <button
            key={opt.label}
            onClick={() => setValue(opt.value)}
            disabled={saving}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${ on === opt.value ? 'border-foreground/30 bg-accent font-medium' : 'hover:bg-accent/30' }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Whether the portal overview shows each fund's IRR (fund_settings.lp_portal_show_irr). Off by
 * default, since some managers prefer not to show IRR in a portal. Per fund only, never blended
 * across funds, and blank until a partner has held for a year (lib/accounting/reporting-irr.ts).
 */
export function LpPortalIrrRow({ enabled, portalOn, onSaved }: { enabled: boolean; portalOn: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(enabled)
  const [saving, setSaving] = useState(false)

  const setValue = async (next: boolean) => {
    setOn(next)
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lpPortalShowIrr: next }),
    })
    setSaving(false)
    if (res.ok) onSaved()
    else setOn(!next)
  }

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">IRR on the portal</div>
        <div className="text-xs text-muted-foreground">
          Shows each investor their IRR in each fund on the portal overview. It stays blank until they have held for a year,
          and is never combined across funds.
          {!portalOn && ' Needs the LP portal on.'}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {[{ value: true, label: 'On' }, { value: false, label: 'Off' }].map(opt => (
          <button
            key={opt.label}
            onClick={() => setValue(opt.value)}
            disabled={saving}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${ on === opt.value ? 'border-foreground/30 bg-accent font-medium' : 'hover:bg-accent/30' }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
