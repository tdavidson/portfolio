'use client'

import { useEffect, useState } from 'react'

interface Entity { id: string; name: string; kind: string; active: boolean }

/**
 * Pick one of the viewer's entities (funds, SPVs — not the management company, which makes no
 * investments). `/api/entities` lists only the entities the viewer can see, and needs no accounting grant, so this can never offer
 * one they cannot.
 */
export function EntityPicker({ value, onChange, allowUnassigned = false, disabled = false, id }: {
  value: string | null
  onChange: (vehicleId: string | null) => void
  /** Admins may leave a deal unassigned; a member must choose. */
  allowUnassigned?: boolean
  disabled?: boolean
  id?: string
}) {
  const [entities, setEntities] = useState<Entity[] | null>(null)

  useEffect(() => {
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Entity[]) => setEntities((rows ?? []).filter(e => e.kind !== 'manco')))
      .catch(() => setEntities([]))
  }, [])

  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled || entities === null}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm"
    >
      <option value="" disabled={!allowUnassigned}>{entities === null ? 'Loading…' : allowUnassigned ? 'Unassigned' : 'Choose an entity'}</option>
      {/* Active entities to choose from — plus the current one if it has since been wound down, so a
          deal on an inactive entity still shows where it sits instead of a blank. */}
      {(entities ?? []).filter(e => e.active || e.id === value).map(e => (
        <option key={e.id} value={e.id}>{e.active ? e.name : `${e.name} (inactive)`}</option>
      ))}
    </select>
  )
}
