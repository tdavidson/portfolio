'use client'

// Outside firms the fund has brought in: a fund administrator, a tax preparer, an auditor, a
// compliance vendor. Each firm's people are ordinary members (their areas and entities are set in
// the access grid above); this groups them, gives them one end date, ends them together, and
// shows what they did. See lib/access/engagements.ts.

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Person { userId: string; email: string; accessExpiresAt: string | null }
interface Kind { key: string; label: string; preset: string | null }
interface Engagement {
  id: string
  name: string
  kind: string
  startsOn: string | null
  endsOn: string | null
  endedAt: string | null
  notes: string | null
  members: Person[]
}
interface Activity { at: string; actorEmail: string | null; action: string; source: 'audit' | 'activity'; subject: string | null; door: string | null }

const INPUT = 'h-8 rounded-sm border border-border bg-background px-2 text-sm text-foreground'

export function EngagementsPanel() {
  const [kinds, setKinds] = useState<Kind[]>([])
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [candidates, setCandidates] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', kind: 'fund_admin', endsOn: '' })
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [activity, setActivity] = useState<Record<string, Activity[]>>({})

  const load = useCallback(async () => {
    const res = await fetch('/api/settings/engagements')
    const data = await res.json().catch(() => ({}))
    if (!res.ok) setError(data.error ?? 'Could not load engagements.')
    else {
      setError(null)
      setKinds(data.kinds ?? [])
      setEngagements(data.engagements ?? [])
      setCandidates(data.candidates ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function send(method: 'POST' | 'PATCH', body: object, key: string): Promise<boolean> {
    setBusy(key); setError(null)
    const res = await fetch('/api/settings/engagements', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setError(data.error ?? 'That did not save.'); return false }
    await load()
    return true
  }

  async function create() {
    if (await send('POST', { name: draft.name, kind: draft.kind, endsOn: draft.endsOn || null }, 'create')) {
      setDraft({ name: '', kind: draft.kind, endsOn: '' })
    }
  }

  async function showActivity(id: string) {
    if (open === id) { setOpen(null); return }
    setOpen(id)
    if (activity[id]) return
    const res = await fetch(`/api/settings/engagements/${id}/activity`)
    const data = await res.json().catch(() => ({}))
    setActivity(prev => ({ ...prev, [id]: res.ok ? data.events ?? [] : [] }))
  }

  const kindLabel = (k: string) => kinds.find(x => x.key === k)?.label ?? k
  const presetFor = (k: string) => kinds.find(x => x.key === k)?.preset

  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
        An engagement is an outside firm working for the fund, for a period. Invite their people as members, set their areas
        and entities in the grid above, then add them here. They lose access on the engagement&apos;s end date, or as soon as you end it.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {engagements.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-sm">
          <table className="min-w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-normal">Firm</th>
                <th className="px-4 py-2 font-normal">People</th>
                <th className="px-4 py-2 font-normal">Ends</th>
                <th className="px-4 py-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {engagements.map(e => (
                <EngagementRow
                  key={e.id}
                  e={e}
                  kindLabel={kindLabel(e.kind)}
                  preset={presetFor(e.kind)}
                  candidates={candidates}
                  busy={busy}
                  confirming={confirmEnd === e.id}
                  open={open === e.id}
                  activity={activity[e.id]}
                  onAssign={userId => send('PATCH', { id: e.id, assign: userId }, `${e.id}:assign`)}
                  onUnassign={userId => send('PATCH', { id: e.id, unassign: userId }, `${e.id}:unassign:${userId}`)}
                  onEndsOn={endsOn => send('PATCH', { id: e.id, endsOn: endsOn || null }, `${e.id}:ends`)}
                  onEnd={async () => {
                    if (confirmEnd !== e.id) { setConfirmEnd(e.id); return }
                    setConfirmEnd(null)
                    await send('PATCH', { id: e.id, end: true }, `${e.id}:end`)
                  }}
                  onActivity={() => showActivity(e.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          <span className="block mb-1">Firm</span>
          <Input value={draft.name} onChange={ev => setDraft(d => ({ ...d, name: ev.target.value }))} placeholder="Example Fund Services" className="h-8 w-56 text-sm" />
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="block mb-1">Kind</span>
          <select value={draft.kind} onChange={ev => setDraft(d => ({ ...d, kind: ev.target.value }))} className={INPUT}>
            {kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="block mb-1">Last day (optional)</span>
          <input type="date" value={draft.endsOn} onChange={ev => setDraft(d => ({ ...d, endsOn: ev.target.value }))} className={INPUT} />
        </label>
        <Button size="sm" onClick={create} disabled={!draft.name.trim() || busy === 'create'}>
          {busy === 'create' && <Loader2 className="h-3 w-3 animate-spin" />}Add engagement
        </Button>
      </div>
    </div>
  )
}

function EngagementRow({
  e, kindLabel, preset, candidates, busy, confirming, open, activity,
  onAssign, onUnassign, onEndsOn, onEnd, onActivity,
}: {
  e: Engagement
  kindLabel: string
  preset: string | null | undefined
  candidates: Person[]
  busy: string | null
  confirming: boolean
  open: boolean
  activity: Activity[] | undefined
  onAssign: (userId: string) => void
  onUnassign: (userId: string) => void
  onEndsOn: (endsOn: string) => void
  onEnd: () => void
  onActivity: () => void
}) {
  const ended = !!e.endedAt
  return (
    <>
      <tr className="border-b last:border-0 align-top">
        <td className="px-4 py-2">
          <div className="font-medium">{e.name}</div>
          <div className="text-xs text-muted-foreground">
            {kindLabel}
            {preset && !ended ? `. Start their people from the ${kindLabel} preset.` : ''}
            {ended ? ` · Ended ${e.endedAt!.slice(0, 10)}` : ''}
          </div>
        </td>
        <td className="px-4 py-2">
          <ul className="space-y-1">
            {e.members.map(m => (
              <li key={m.userId} className="flex items-center gap-2">
                <span className="truncate">{m.email}</span>
                {!ended && (
                  <button
                    type="button"
                    onClick={() => onUnassign(m.userId)}
                    disabled={busy === `${e.id}:unassign:${m.userId}`}
                    className="text-xs text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
            {e.members.length === 0 && <li className="text-muted-foreground">{ended ? 'Access ended' : 'No one yet'}</li>}
          </ul>
          {!ended && candidates.length > 0 && (
            <select
              aria-label={`Add someone to ${e.name}`}
              value=""
              onChange={ev => ev.target.value && onAssign(ev.target.value)}
              disabled={busy === `${e.id}:assign`}
              className={`${INPUT} mt-2`}
            >
              <option value="">Add a member…</option>
              {candidates.map(c => <option key={c.userId} value={c.userId}>{c.email}</option>)}
            </select>
          )}
        </td>
        <td className="px-4 py-2 tabular-nums">
          {ended ? (
            <span className="text-muted-foreground">{e.endsOn ?? 'No date'}</span>
          ) : (
            <input
              type="date"
              aria-label={`Last day of ${e.name}`}
              defaultValue={e.endsOn ?? ''}
              onBlur={ev => { if ((ev.target.value || null) !== e.endsOn) onEndsOn(ev.target.value) }}
              className={INPUT}
            />
          )}
        </td>
        <td className="px-4 py-2 text-right whitespace-nowrap space-x-3">
          <button type="button" onClick={onActivity} className="text-xs text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors">
            {open ? 'Hide activity' : 'Activity'}
          </button>
          {!ended && (
            <button
              type="button"
              onClick={onEnd}
              disabled={busy === `${e.id}:end`}
              className="text-sm text-destructive underline underline-offset-4 hover:text-muted-foreground transition-colors"
            >
              {confirming ? 'Confirm: end everyone’s access now' : 'End engagement'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b last:border-0">
          <td colSpan={4} className="px-4 py-2">
            {!activity ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto space-y-1 text-xs">
                {activity.map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="tabular-nums text-muted-foreground shrink-0">{a.at.slice(0, 16).replace('T', ' ')}</span>
                    <span className="shrink-0">{a.actorEmail ?? 'Unknown'}</span>
                    <span>{a.action}{a.subject ? ` · ${a.subject}` : ''}</span>
                    {a.door && <span className="text-muted-foreground">via {a.door}</span>}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
