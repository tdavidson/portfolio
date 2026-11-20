'use client'

// Shared LP rename dialog — used on /lps (has an investorId) and from accounting pages
// (which only have an entityId). Error-first: a name collision is reported as an error,
// not silently merged. Merging is an explicit, double-confirmed action the user opts into.
// With `alternateName` (null = none set) it also edits the investor's second name, which
// searches match but reports never print.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

export function RenameInvestorDialog({ target, onClose, onSaved }: {
  target: { investorId?: string; entityId?: string; name: string; alternateName?: string | null }
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(target.name)
  const editsAlternate = target.alternateName !== undefined
  const [alternate, setAlternate] = useState(target.alternateName ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ conflictId: string; sourceId: string } | null>(null)
  const [confirmMerge, setConfirmMerge] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true); setErr(null)
    const body: Record<string, any> = { name: name.trim() }
    if (editsAlternate && alternate.trim() !== (target.alternateName ?? '')) body.alternateName = alternate.trim() || null
    if (target.investorId) body.id = target.investorId
    else if (target.entityId) body.entityId = target.entityId

    const res = await fetch('/api/lps/investors', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSaving(false)

    if (res.ok) { onSaved(); return }

    const d = await res.json().catch(() => ({}))
    if (d.error === 'duplicate_name' && d.conflictId && d.sourceId) {
      setConflict({ conflictId: d.conflictId, sourceId: d.sourceId })
      return
    }
    setErr(d.error === 'duplicate_name' ? 'An investor with that name already exists.' : (d.error ?? 'Could not rename'))
  }

  async function merge() {
    if (!conflict) return
    setSaving(true); setErr(null)
    const res = await fetch('/api/lps/investors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: conflict.sourceId, targetId: conflict.conflictId }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error ?? 'Could not merge'); return }
    onSaved()
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{editsAlternate ? 'Edit investor names' : 'Rename investor'}</DialogTitle></DialogHeader>

        <div className="space-y-1">
          {editsAlternate && <label htmlFor="investor-name" className="text-sm font-medium">Name</label>}
          <Input
            id="investor-name"
            value={name}
            onChange={e => { setName(e.target.value); setConflict(null); setConfirmMerge(false); setErr(null) }}
            onKeyDown={e => e.key === 'Enter' && !conflict && save()}
            autoFocus
            disabled={saving}
          />
        </div>

        {editsAlternate && (
          <div className="space-y-1">
            <label htmlFor="investor-alternate-name" className="text-sm font-medium">Also known as</label>
            <Input
              id="investor-alternate-name"
              value={alternate}
              onChange={e => setAlternate(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !conflict && save()}
              placeholder="The person behind the entity, or the entity behind the person"
              disabled={saving || !!conflict}
            />
            <p className="text-xs text-muted-foreground">Search finds the investor by either name. Reports print the name above.</p>
          </div>
        )}

        {err && <p className="text-sm text-destructive">{err}</p>}

        {conflict && !confirmMerge && (
          <div className="space-y-2 rounded-card border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">
              An investor named &ldquo;{name.trim()}&rdquo; already exists. Rename won&rsquo;t merge them.
            </p>
            <Button variant="outline" size="sm" onClick={() => setConfirmMerge(true)} disabled={saving}>
              Merge instead…
            </Button>
          </div>
        )}

        {conflict && confirmMerge && (
          <div className="space-y-2 rounded-card border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">
              This deletes this investor and moves its positions into &ldquo;{name.trim()}&rdquo;. This can&rsquo;t be undone.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmMerge(false)} disabled={saving}>Back</Button>
              <Button variant="destructive" size="sm" onClick={merge} disabled={saving}>
                {saving ? 'Merging…' : 'Confirm merge'}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {!conflict && (
            <Button onClick={save} disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
