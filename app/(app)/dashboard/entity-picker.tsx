'use client'

import { useState } from 'react'
import { Building2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { resolveExcluded, selectionLabel, type EntityOption } from '@/lib/dashboard/entity-selection'

/**
 * The dashboard's entity filter: a button naming the selection, opening a checklist of the viewer's
 * entities that hold an active position. Saving stores the selection on the person's account
 * (api/dashboard/entities), so it follows them to the next visit and every device.
 */
export function EntityPicker({ options, excluded, hasSaved, onChange }: {
  options: EntityOption[]
  excluded: string[]
  hasSaved: boolean
  onChange: (excluded: string[], hasSaved: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function openDialog() {
    setDraft(new Set(options.filter(o => !excluded.includes(o.id)).map(o => o.id)))
    setError(null)
    setOpen(true)
  }

  function toggle(id: string) {
    setDraft(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save() {
    const nextExcluded = options.filter(o => !draft.has(o.id)).map(o => o.id)
    setSaving(true)
    setError(null)
    const res = await fetch('/api/dashboard/entities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluded: nextExcluded }),
    }).catch(() => null)
    setSaving(false)
    if (!res?.ok) { setError('Could not save your selection.'); return }
    // The read-only demo applies the selection for this visit only (the route answers saved: false).
    const { saved } = await res.json().catch(() => ({ saved: true }))
    onChange(nextExcluded, saved !== false)
    setOpen(false)
  }

  async function reset() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/dashboard/entities', { method: 'DELETE' }).catch(() => null)
    setSaving(false)
    if (!res?.ok) { setError('Could not reset your selection.'); return }
    const { fundDefault } = await res.json().catch(() => ({ fundDefault: [] }))
    onChange(resolveExcluded({ options, saved: null, fundDefault: Array.isArray(fundDefault) ? fundDefault : [] }).excluded, false)
    setOpen(false)
  }

  const allSelected = draft.size === options.length

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 max-w-[14rem] gap-1.5 text-xs font-normal"
        onClick={openDialog}
        aria-label="Choose entities"
      >
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{selectionLabel(options, excluded)}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Entities</DialogTitle>
            <DialogDescription>
              Show holdings in these entities. Only entities with an active investment are listed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3 text-xs">
            <button type="button" className="underline underline-offset-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={allSelected} onClick={() => setDraft(new Set(options.map(o => o.id)))}>
              Select all
            </button>
            <button type="button" className="underline underline-offset-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={draft.size === 0} onClick={() => setDraft(new Set())}>
              Select none
            </button>
          </div>

          <ul className="max-h-72 overflow-y-auto rounded-card border divide-y">
            {options.map(o => (
              <li key={o.id}>
                <label className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent/50">
                  <input type="checkbox" className="h-3.5 w-3.5 shrink-0" checked={draft.has(o.id)} onChange={() => toggle(o.id)} />
                  <span className="truncate">{o.name}</span>
                </label>
              </li>
            ))}
          </ul>

          {draft.size === 0 && <p className="text-xs text-muted-foreground">Choose at least one entity.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2 sm:justify-between">
            {hasSaved ? (
              <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>Use fund default</Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving || draft.size === 0}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
