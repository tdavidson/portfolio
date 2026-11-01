'use client'

// The fund's records (lib/records): what people and their assistants filed from a working session.
// Lists what the viewer may see (read on the area, the entity in scope), opens one to read it, and
// files a new one through the same route the file_to_record tool's service backs.

import { useCallback, useEffect, useState } from 'react'
import { Archive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/ui/empty-state'

interface RecordRow {
  id: string
  area: string
  kind: string
  title: string
  body?: string
  entityName: string | null
  source: 'web' | 'api' | 'mcp'
  filedByEmail: string | null
  createdAt: string
}
interface Area { id: string; label: string }
interface Entity { id: string; name: string }

const KINDS = ['summary', 'decision', 'memo', 'transcript', 'note'] as const
const SOURCE: Record<string, string> = { web: 'web', api: 'API', mcp: 'assistant' }
const SELECT = 'h-9 rounded-sm border border-border bg-background px-2 text-sm text-foreground'

export function FundRecords() {
  const [rows, setRows] = useState<RecordRow[] | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [entityScoped, setEntityScoped] = useState(true)
  const [canFile, setCanFile] = useState(false)
  const [area, setArea] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [filing, setFiling] = useState(false)
  const [draft, setDraft] = useState({ area: '', entity: '', kind: 'summary', title: '', body: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const p = new URLSearchParams()
    if (area) p.set('area', area)
    if (q.trim()) p.set('q', q.trim())
    const res = await fetch(`/api/records?${p}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error ?? 'Could not load records.'); setRows([]); return }
    setError(null)
    setRows(data.records ?? [])
    setAreas(data.areas ?? [])
    setEntityScoped(!!data.entityScoped)
    setCanFile(!!data.canFile)
  }, [area, q])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/entities').then(r => (r.ok ? r.json() : [])).then(d => setEntities(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  async function toggle(id: string) {
    if (open[id] !== undefined) { setOpen(o => { const n = { ...o }; delete n[id]; return n }); return }
    const res = await fetch(`/api/records?id=${encodeURIComponent(id)}`)
    const data = await res.json().catch(() => ({}))
    setOpen(o => ({ ...o, [id]: res.ok ? data.record?.body ?? '' : data.error ?? 'Could not open this record.' }))
  }

  async function file() {
    setBusy(true); setError(null)
    const res = await fetch('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, entity: draft.entity || undefined }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(data.error ?? 'That did not save.'); return }
    setDraft({ area: '', entity: '', kind: 'summary', title: '', body: '' })
    setFiling(false)
    await load()
  }

  const label = (id: string) => areas.find(a => a.id === id)?.label ?? id

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={SELECT} value={area} onChange={e => setArea(e.target.value)} aria-label="Area">
          <option value="">Every area</option>
          {areas.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search titles and text" className="h-9 w-64" />
        {canFile && areas.length > 0 && !filing && (
          <Button size="sm" className="ml-auto" onClick={() => { setFiling(true); setDraft(d => ({ ...d, area: d.area || area || areas[0].id })) }}>
            File a record
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {filing && (
        <div className="rounded-card border p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <select className={SELECT} value={draft.area} onChange={e => setDraft(d => ({ ...d, area: e.target.value }))} aria-label="Area">
              {areas.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <select className={SELECT} value={draft.entity} onChange={e => setDraft(d => ({ ...d, entity: e.target.value }))} aria-label="Entity">
              <option value="">{entityScoped ? 'Choose an entity' : 'Fund-wide'}</option>
              {entities.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <select className={SELECT} value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))} aria-label="Kind">
              {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <Input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="Title" maxLength={200} />
          <Textarea
            value={draft.body}
            onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            placeholder="What was looked at, what was found, what was decided, what is still open"
            rows={8}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={file} disabled={busy || !draft.title.trim() || !draft.body.trim()}>
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}File it
            </Button>
            <Button size="sm" variant="outline" onClick={() => setFiling(false)} disabled={busy}>Cancel</Button>
          </div>
          <p className="text-xs text-muted-foreground">A record can&apos;t be edited or deleted once filed.</p>
        </div>
      )}

      {rows === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Archive}>
          No records yet. When a session ends, ask your assistant to file what was concluded, or file one here.
        </EmptyState>
      ) : (
        <div className="divide-y border border-border rounded-sm">
          {rows.map(r => (
            <div key={r.id} className="p-3 text-sm space-y-2">
              <button type="button" onClick={() => toggle(r.id)} className="group block w-full text-left">
                <span className="font-medium group-hover:underline underline-offset-4">{r.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {label(r.area)} · {r.kind} · {r.entityName ?? 'fund-wide'} · {r.filedByEmail ?? 'unknown'} via {SOURCE[r.source] ?? r.source} ·{' '}
                  <span className="tabular-nums">{r.createdAt.slice(0, 10)}</span>
                </span>
              </button>
              {open[r.id] !== undefined && <div className="whitespace-pre-wrap text-sm">{open[r.id]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
