'use client'

import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/settings/section'
import type { EntityOption } from '@/lib/dashboard/entity-selection'

// ──────────────────────────── Dashboard entities (fund default) ────────────────────────────

/**
 * The entities the portfolio dashboard shows by default. Stored as the UNCHECKED ones, so an
 * entity added later is shown until someone unchecks it here.
 */
export function DashboardEntitiesSection() {
  const [options, setOptions] = useState<EntityOption[] | null>(null)
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/dashboard-entities')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((d: { options: EntityOption[]; excluded: string[] }) => {
        setOptions(d.options)
        setShown(new Set(d.options.filter(o => !d.excluded.includes(o.id)).map(o => o.id)))
      })
      .catch(() => setError('Could not load entities.'))
  }, [])

  function toggle(id: string) {
    setShown(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save() {
    if (!options) return
    setSaving(true)
    setError(null)
    const res = await fetch('/api/settings/dashboard-entities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded: options.filter(o => !shown.has(o.id)).map(o => o.id) }),
    }).catch(() => null)
    setSaving(false)
    if (!res?.ok) { setError('Could not save.'); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Section title="Dashboard entities">
      <p className="text-xs text-muted-foreground mb-3">
        The entities the portfolio dashboard shows by default. Everyone starts from this until they
        choose their own on the dashboard. Only entities with an active investment are listed, and a
        new entity is shown until you uncheck it here.
      </p>
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}
      {options === null ? (
        !error && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">No entity holds an active investment yet.</p>
      ) : (
        <>
          <ul className="rounded-card border divide-y">
            {options.map(o => (
              <li key={o.id}>
                <label className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent/50">
                  <input type="checkbox" className="h-3.5 w-3.5 shrink-0" checked={shown.has(o.id)} onChange={() => toggle(o.id)} />
                  <span className="truncate">{o.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" onClick={save} disabled={saving || shown.size === 0}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
            </Button>
            {shown.size === 0 && <span className="text-xs text-muted-foreground">Keep at least one entity.</span>}
          </div>
        </>
      )}
    </Section>
  )
}
