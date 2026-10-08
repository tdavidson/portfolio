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
  /** Offer "Unassigned" — shown only to callers who can see unassigned items (admins, All-entities
   *  members); anyone else must choose one of their entities. */
  allowUnassigned?: boolean
  disabled?: boolean
  id?: string
}) {
  const [entities, setEntities] = useState<Entity[] | null>(null)
  const [unscoped, setUnscoped] = useState(false)

  useEffect(() => {
    fetch('/api/entities?scope=1')
      .then(r => (r.ok ? r.json() : { entities: [], all: false }))
      .then((body: { entities: Entity[]; all: boolean }) => {
        setEntities((body.entities ?? []).filter(e => e.kind !== 'manco'))
        setUnscoped(!!body.all)
      })
      .catch(() => setEntities([]))
  }, [])
  const canLeaveUnassigned = allowUnassigned && unscoped

  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled || entities === null}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm"
    >
      <option value="" disabled={!canLeaveUnassigned}>{entities === null ? 'Loading…' : canLeaveUnassigned ? 'Unassigned' : 'Choose an entity'}</option>
      {/* Active entities to choose from — plus the current one if it has since been wound down, so a
          deal on an inactive entity still shows where it sits instead of a blank. */}
      {(entities ?? []).filter(e => e.active || e.id === value).map(e => (
        <option key={e.id} value={e.id}>{e.active ? e.name : `${e.name} (inactive)`}</option>
      ))}
    </select>
  )
}
