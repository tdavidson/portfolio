'use client'

import { useEffect, useState } from 'react'

interface NoteEntity { id: string; name: string }

/**
 * Which entity a new note is for. Every note belongs to one (there are no fund-wide notes), so the
 * composer always sends a `vehicleId` — chosen here when there is a choice, filled in silently when
 * there is only one (your only entity, or the only one of yours that holds the company).
 */
export function NoteEntitySelect({ companyId, value, onChange, autoSelect = true }: {
  companyId?: string | null
  value: string | null
  onChange: (vehicleId: string | null) => void
  /** Fill in the only choice silently (a new note). Off when choosing is itself the action. */
  autoSelect?: boolean
}) {
  const [options, setOptions] = useState<NoteEntity[] | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/notes/entities${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: NoteEntity[]) => {
        if (!live) return
        setOptions(rows ?? [])
        if (autoSelect && (rows ?? []).length === 1) onChange(rows[0].id)
      })
      .catch(() => live && setOptions([]))
    return () => { live = false }
    // onChange is a setter from the parent; re-run only when the company changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  if (!options || options.length === 0 || (autoSelect && options.length === 1)) return null
  return (
    <select
      aria-label="Entity this note is for"
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-lg border border-input bg-transparent px-2 py-1 text-xs text-muted-foreground"
    >
      <option value="" disabled>For which entity?</option>
      {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  )
}

// The viewer's entity names, fetched once per page load and shared by every tag.
let entityNames: Promise<Map<string, string>> | null = null
function loadEntityNames(): Promise<Map<string, string>> {
  entityNames ??= fetch('/api/entities')
    .then(r => (r.ok ? r.json() : []))
    .then((rows: NoteEntity[]) => new Map((rows ?? []).map(r => [r.id, r.name])))
    .catch(() => new Map())
  return entityNames
}

/**
 * Which entity a note belongs to — its audience. A note written before entities, that the backfill
 * could not attribute, offers a choice instead (only unscoped users see such notes).
 */
export function NoteEntityTag({ noteId, vehicleId, companyId }: {
  noteId: string
  vehicleId: string | null | undefined
  companyId?: string | null
}) {
  const [names, setNames] = useState<Map<string, string> | null>(null)
  const [current, setCurrent] = useState<string | null>(vehicleId ?? null)
  useEffect(() => { loadEntityNames().then(setNames) }, [])

  if (current) {
    const name = names?.get(current)
    return name ? <span className="text-[11px] text-muted-foreground" title="The entity this note is for">{name}</span> : null
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      No entity:
      <NoteEntitySelect
        companyId={companyId}
        value={null}
        autoSelect={false}
        onChange={async id => {
          if (!id) return
          const res = await fetch(`/api/dashboard/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vehicleId: id }),
          })
          if (res.ok) setCurrent(id)
        }}
      />
    </span>
  )
}
