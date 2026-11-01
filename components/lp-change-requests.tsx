'use client'

// What LPs have asked to change from their portal or connector: their record, or portal access for
// someone acting for them (lib/lps/change-requests.ts). Shown only while something is waiting.
// Approving makes the change as the person approving; access for an authorized user needs an admin.

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface RequestRow {
  id: string
  kind: 'profile' | 'authorized_user'
  investorName: string | null
  entityName: string | null
  payload: Record<string, any>
  current: Record<string, any>
  note: string | null
  requestedByEmail: string | null
  createdAt: string
}

const LABEL: Record<string, string> = {
  entity_type: 'Entity type', formation_jurisdiction: 'Formed in', address_line1: 'Address', address_line2: 'Address line 2',
  city: 'City', region: 'State or region', postal_code: 'Postal code', country: 'Country', notice_email: 'Notice email',
  signatories: 'Signatories', contact_name: 'Contact name', contact_email: 'Contact email', contact_phone: 'Contact phone',
}

function show(v: unknown): string {
  if (v == null || v === '') return 'blank'
  if (Array.isArray(v)) return v.map((s: any) => [s.name, s.title, s.email].filter(Boolean).join(', ')).join('; ') || 'none'
  return String(v)
}

/** Each field asked for, from what is on file to what they asked. */
function changes(r: RequestRow): { field: string; from: string; to: string }[] {
  const out: { field: string; from: string; to: string }[] = []
  for (const part of ['entity', 'investor'] as const) {
    for (const [k, v] of Object.entries(r.payload?.[part] ?? {})) {
      out.push({ field: LABEL[k] ?? k, from: show(r.current?.[part]?.[k]), to: show(v) })
    }
  }
  return out
}

export function LpChangeRequests() {
  const [rows, setRows] = useState<RequestRow[]>([])
  const [canDecide, setCanDecide] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/lps/change-requests')
    if (!res.ok) return
    const data = await res.json().catch(() => ({}))
    setRows(data.requests ?? [])
    setCanDecide(!!data.canDecide)
    setIsAdmin(!!data.isAdmin)
  }, [])
  useEffect(() => { load() }, [load])

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(`${id}:${decision}`); setError(null)
    const res = await fetch('/api/lps/change-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, decision, note: notes[id] || undefined }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setError(data.error ?? 'That did not save.'); return }
    await load()
  }

  if (rows.length === 0) return null

  return (
    <section className="mb-6 rounded-card border p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Change requests from LPs</h2>
        <p className="text-sm text-muted-foreground">Nothing changes until you approve. Approving makes the change as you.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="divide-y border border-border rounded-sm">
        {rows.map(r => {
          const allowed = canDecide && (r.kind === 'profile' || isAdmin)
          return (
            <div key={r.id} className="p-3 space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{r.entityName ?? r.investorName ?? 'An investor'}</span>
                <span className="text-xs text-muted-foreground">
                  {r.kind === 'profile' ? 'record change' : 'portal access'} · {r.requestedByEmail ?? 'unknown'} ·{' '}
                  <span className="tabular-nums">{r.createdAt.slice(0, 10)}</span>
                </span>
              </div>
              {r.kind === 'profile' ? (
                <ul className="text-xs space-y-0.5">
                  {changes(r).map(c => (
                    <li key={c.field}><span className="text-muted-foreground">{c.field}:</span> {c.from} → <span className="font-medium">{c.to}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs">
                  Read-only access for <span className="font-medium">{r.payload?.display_name ? `${r.payload.display_name} (${r.payload.email})` : r.payload?.email}</span>.
                  Approving invites them.
                </p>
              )}
              {r.note && <p className="text-xs text-muted-foreground">“{r.note}”</p>}
              {allowed ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={notes[r.id] ?? ''}
                    onChange={ev => setNotes(n => ({ ...n, [r.id]: ev.target.value }))}
                    placeholder="Note to the LP (optional)"
                    className="h-8 w-64 text-xs"
                  />
                  <Button size="sm" onClick={() => decide(r.id, 'approve')} disabled={!!busy}>
                    {busy === `${r.id}:approve` && <Loader2 className="h-3 w-3 animate-spin" />}Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide(r.id, 'reject')} disabled={!!busy}>
                    {busy === `${r.id}:reject` && <Loader2 className="h-3 w-3 animate-spin" />}Reject
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {r.kind === 'authorized_user' ? 'An admin approves portal access.' : 'Someone with write access to LP capital approves this.'}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
