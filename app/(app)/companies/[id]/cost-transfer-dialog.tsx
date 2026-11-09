'use client'

// Move cost from this holding to another one in the same entity, with no cash and no gain. Posts one
// journal entry (Dr Investment — target / Cr Investment — source), recorded as a cost transfer:
// lib/portfolio/cost-transfer.ts, through POST /api/portfolio/cost-transfers.

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  portfolioGroups: string[]
  onSaved: () => void
}

export function CostTransferDialog({ open, onOpenChange, companyId, portfolioGroups, onSaved }: Props) {
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [toCompanyId, setToCompanyId] = useState('')
  const [vehicle, setVehicle] = useState(portfolioGroups[0] ?? '')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [memo, setMemo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/companies').then(r => (r.ok ? r.json() : [])).then(data => {
      if (Array.isArray(data)) {
        setCompanies(data.filter((c: any) => c.id !== companyId).map((c: any) => ({ id: c.id, name: c.name }))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)))
      }
    }).catch(() => {})
  }, [open, companyId])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/portfolio/cost-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record', from_company_id: companyId, to_company_id: toCompanyId, amount: Number(amount), date, vehicle, memo: memo || undefined }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'The transfer was not recorded.'); return }
      setAmount(''); setMemo(''); setToCompanyId('')
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const ready = !!toCompanyId && !!vehicle && Number(amount) > 0 && !!date

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer cost to another holding</DialogTitle>
          <DialogDescription>
            Moves cost basis to another holding in the same entity, with no cash and no gain. This holding&apos;s invested capital
            and cost go down without any proceeds; the other holding&apos;s cost starts on the date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>To holding</Label>
            <Select value={toCompanyId} onValueChange={setToCompanyId}>
              <SelectTrigger><SelectValue placeholder="Choose a holding" /></SelectTrigger>
              <SelectContent>
                {companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {portfolioGroups.length > 1 && (
            <div className="space-y-1">
              <Label>Entity</Label>
              <Select value={vehicle} onValueChange={setVehicle}>
                <SelectTrigger><SelectValue placeholder="Choose an entity" /></SelectTrigger>
                <SelectContent>
                  {portfolioGroups.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Cost moved</Label>
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="tabular-nums" />
            </div>
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Memo (optional)</Label>
            <Input value={memo} onChange={e => setMemo(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={!ready || saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Transfer cost
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
