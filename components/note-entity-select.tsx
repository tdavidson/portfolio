'use client'

import { useEffect, useState } from 'react'

interface NoteEntity { id: string; name: string }

/**
 * Which entity a new note is for. Every note belongs to one (there are no fund-wide notes), so the
 * composer always sends a `vehicleId` — chosen here when there is a choice, filled in silently when
 * there is only one (your only entity, or the only one of yours that holds the company).
 */
export function NoteEntitySelect({ companyId, value, onChange }: {
  companyId?: string | null
  value: string | null
  onChange: (vehicleId: string | null) => void
}) {
  const [options, setOptions] = useState<NoteEntity[] | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/notes/entities${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: NoteEntity[]) => {
        if (!live) return
        setOptions(rows ?? [])
        if ((rows ?? []).length === 1) onChange(rows[0].id)
      })
      .catch(() => live && setOptions([]))
    return () => { live = false }
    // onChange is a setter from the parent; re-run only when the company changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  if (!options || options.length <= 1) return null
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
