'use client'

// The Audit page (lib/audit-log): each outside firm's log, newest first. A filed note opens in
// place through /api/records?id=. Nothing here writes: the log keeps itself.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Archive, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { useIsAdmin } from '@/components/access-context'

interface Entry {
  at: string
  person: string | null
  door: 'web' | 'mcp' | 'api' | null
  type: 'change' | 'session' | 'note'
  summary: string
  subject: string | null
  recordId?: string
}
interface Firm {
  id: string | null
  name: string
  kindLabel: string | null
  startsOn: string | null
  endsOn: string | null
  endedAt: string | null
  people: { id: string; email: string | null; current: boolean }[]
  entries: Entry[]
  truncated: boolean
}

const DOOR: Record<string, string> = { web: 'Web', mcp: 'Assistant', api: 'API' }
const SELECT = 'h-9 rounded-sm border border-border bg-background px-2 text-sm text-foreground'

const when = (iso: string) => {
  const d = new Date(iso)
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`
}

export function AuditLogView() {
  const isAdmin = useIsAdmin()
  const [firms, setFirms] = useState<Firm[] | null>(null)
  const [visibility, setVisibility] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [firm, setFirm] = useState('')
  const [since, setSince] = useState('')
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const p = new URLSearchParams()
    if (since) p.set('since', since)
    const res = await fetch(`/api/audit?${p}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error ?? 'Could not load the audit log.'); setFirms([]); return }
    setError(null)
    setFirms(data.firms ?? [])
    setVisibility(data.visibility ?? null)
  }, [since])
  useEffect(() => { load() }, [load])

  async function openNote(id: string) {
    if (notes[id] !== undefined) { setNotes(n => { const c = { ...n }; delete c[id]; return c }); return }
    const res = await fetch(`/api/records?id=${encodeURIComponent(id)}`)
    const data = await res.json().catch(() => ({}))
    setNotes(n => ({ ...n, [id]: res.ok ? data.record?.body ?? '' : data.error ?? 'Could not open this note.' }))
  }

  if (firms === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />

  if (error) {
    return (
      <EmptyState icon={Archive} action={isAdmin ? <Button asChild size="sm"><Link href="/settings">Open Settings</Link></Button> : undefined}>
        {error}
      </EmptyState>
    )
  }

  const shown = firm ? firms.filter(f => (f.id ?? 'fund') === firm) : firms

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {firms.length > 1 && (
          <select className={SELECT} value={firm} onChange={e => setFirm(e.target.value)} aria-label="Firm">
            <option value="">Every firm</option>
            {firms.map(f => <option key={f.id ?? 'fund'} value={f.id ?? 'fund'}>{f.name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Since
          <Input title="Empty: the last 90 days" type="date" value={since} onChange={e => setSince(e.target.value)} className="h-9 w-40 tabular-nums" />
        </label>
        {isAdmin && visibility && (
          <span className="ml-auto text-xs text-muted-foreground">
            Shown to {visibility === 'members' ? 'members' : 'admins only'}.{' '}
            <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">Change in Settings</Link>
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Archive}
          action={isAdmin ? <Button asChild size="sm" variant="outline"><Link href="/settings">Add an outside firm in Settings</Link></Button> : undefined}
        >
          No outside firms yet. When you bring in a fund administrator, auditor or tax preparer as an engagement, what their people do is logged here.
        </EmptyState>
      ) : (
        shown.map(f => {
          const key = f.id ?? 'fund'
          const isClosed = closed[key]
          return (
            <div key={key} className="rounded-card border">
              <button
                type="button"
                onClick={() => setClosed(c => ({ ...c, [key]: !c[key] }))}
                className="flex w-full items-start gap-2 p-4 text-left"
              >
                {isClosed ? <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.name}</span>
                    {f.kindLabel && <Badge variant="outline">{f.kindLabel}</Badge>}
                    {f.endedAt && <Badge variant="secondary">Ended {f.endedAt.slice(0, 10)}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {f.people.length > 0 && <>{f.people.map(p => p.email ?? 'removed user').join(', ')} · </>}
                    <span className="tabular-nums">{f.entries.length}{f.truncated ? '+' : ''}</span> entries
                  </div>
                </div>
              </button>
              {!isClosed && (
                f.entries.length === 0 ? (
                  <p className="border-t px-4 py-3 text-sm text-muted-foreground">Nothing logged in this period.</p>
                ) : (
                  <div className="divide-y border-t">
                    {f.entries.map((e, i) => (
                      <div key={`${e.at}-${i}`} className="grid grid-cols-1 gap-1 px-4 py-2 text-sm md:grid-cols-[9rem_1fr_6rem]">
                        <span className="text-xs text-muted-foreground tabular-nums">{when(e.at)}</span>
                        <div className="min-w-0">
                          {e.recordId ? (
                            <button type="button" onClick={() => openNote(e.recordId!)} className="text-left hover:underline underline-offset-4">
                              {e.summary}
                            </button>
                          ) : (
                            <span>{e.summary}</span>
                          )}
                          <span className="block truncate text-xs text-muted-foreground">
                            {e.person ?? 'unknown'}{e.subject ? ` · ${e.subject}` : ''}
                          </span>
                          {e.recordId && notes[e.recordId] !== undefined && (
                            <div className="mt-2 whitespace-pre-wrap text-sm">{notes[e.recordId]}</div>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground md:text-right">
                          {e.type === 'session' ? 'Session' : e.type === 'note' ? 'Note' : 'Change'}{e.door ? ` · ${DOOR[e.door]}` : ''}
                        </span>
                      </div>
                    ))}
                    {f.truncated && <p className="px-4 py-2 text-xs text-muted-foreground">Showing the latest entries. Pick a later Since date to see the rest.</p>}
                  </div>
                )
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
