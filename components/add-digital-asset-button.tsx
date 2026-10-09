'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useCanWrite } from '@/components/access-context'
import { holdingHref } from '@/lib/portfolio/holding-href'
import { investingEntities, type EntityChoice } from '@/lib/portfolio/investing-entities'

/**
 * Adds a holding that is a DIGITAL ASSET (companies.holding_type = 'crypto'). Its wallets and its
 * price feed are configured on its own page, which is where this goes once it exists.
 */
export function AddDigitalAssetButton() {
  const router = useRouter()
  const canWrite = useCanWrite('portfolio', 'investments')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [entity, setEntity] = useState('')
  const [entities, setEntities] = useState<EntityChoice[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    // Investing entities only: a management company or GP entity cannot hold an investment, and
    // derivation refuses every purchase recorded there.
    fetch('/api/entities')
      .then(r => { if (!r.ok) throw new Error('entities'); return r.json() })
      .then(rows => {
        if (cancelled) return
        const list = investingEntities(rows)
        setEntities(list)
        if (list.length === 1) setEntity(list[0].name)
      })
      .catch(() => { if (!cancelled) { setEntities([]); setError('Could not load your entities. Close this and try again.') } })
    return () => { cancelled = true }
  }, [open])

  if (!canWrite) return null

  async function save() {
    if (!name.trim()) { setError('A name is required.'); return }
    if (!entity) { setError('Choose which entity holds it.'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), holding_type: 'crypto', portfolio_group: [entity] }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json?.error ?? 'Could not add the digital asset.'); return }
      setOpen(false)
      setName('')
      setEntity('')
      router.push(holdingHref(json.id))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); setError(null) }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" />Add digital asset</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a digital asset</DialogTitle>
          <DialogDescription>
            A token the fund holds. Record its purchases on its page, and watch its wallets and
            attach a price feed there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="da-name">Name</Label>
            <Input id="da-name" value={name} onChange={e => setName(e.target.value)} placeholder="Ether" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="da-entity">Held by</Label>
            <select
              id="da-entity"
              value={entity}
              onChange={e => setEntity(e.target.value)}
              className="border rounded-lg px-2 py-1 text-sm h-9 w-full bg-background"
            >
              <option value="">Choose an entity…</option>
              {entities.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Add digital asset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
