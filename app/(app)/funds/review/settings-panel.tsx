'use client'

// A vehicle's statement review settings (lib/statement-review/settings.ts): materiality, the
// reviewer's own instructions, the accounts to watch every period, and the adjustments they already
// know about. They apply from the next run.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { CollapsibleSection } from '@/components/collapsible-section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { CHECK_IDS, CHECK_LABELS } from '@/lib/statement-review/types'

interface Watch { account: string; note: string; threshold: string }
interface Adjustment { description: string; check: string; subject: string; amount: string }
interface Loaded {
  materiality: { amount: number; navShare: number }
  instructions: string
  watchAccounts: { account: string; note?: string; threshold?: number }[]
  adjustments: { description: string; check?: string; subject?: string; amount?: number }[]
}

const selectCls = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

export function ReviewSettingsPanel({ canEdit, onSaved }: { canEdit: boolean; onSaved?: () => void }) {
  const lf = useLedgerFetch()
  const [loaded, setLoaded] = useState(false)
  const [amount, setAmount] = useState('')
  const [navShare, setNavShare] = useState('')
  const [instructions, setInstructions] = useState('')
  const [watch, setWatch] = useState<Watch[]>([])
  const [adjustments, setAdjustments] = useState<Adjustment[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((d: Loaded) => {
    setAmount(d.materiality.amount ? String(d.materiality.amount) : '')
    setNavShare(d.materiality.navShare ? `${+(d.materiality.navShare * 100).toFixed(4)}%` : '')
    setInstructions(d.instructions ?? '')
    setWatch((d.watchAccounts ?? []).map(w => ({ account: w.account, note: w.note ?? '', threshold: w.threshold != null ? String(w.threshold) : '' })))
    setAdjustments((d.adjustments ?? []).map(a => ({ description: a.description, check: a.check ?? '', subject: a.subject ?? '', amount: a.amount != null ? String(a.amount) : '' })))
    setLoaded(true)
  }, [])

  useEffect(() => {
    lf('/api/accounting/statement-review/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) apply(d) })
      .catch(() => {})
  }, [lf, apply])

  async function save() {
    setBusy(true); setError(null); setMsg(null)
    try {
      const share = navShare.trim().endsWith('%') ? Number(navShare.replace('%', '')) / 100 : navShare.trim() ? Number(navShare) : 0
      const res = await lf('/api/accounting/statement-review/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materiality: { amount: amount.trim() || 0, nav_share: Number.isFinite(share) ? share : navShare },
          instructions,
          watch_accounts: watch.filter(w => w.account.trim()).map(w => ({ account: w.account, note: w.note || undefined, threshold: w.threshold || undefined })),
          adjustments: adjustments.filter(a => a.description.trim()).map(a => ({
            description: a.description, check: a.check || undefined, subject: a.subject || undefined, amount: a.amount || undefined,
          })),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Could not save.'); return }
      apply(d)
      setMsg('Saved. The settings apply from the next run.')
      onSaved?.()
    } finally { setBusy(false) }
  }

  if (!loaded) return null
  const subtitle = [
    watch.length ? `${watch.length} watched account${watch.length === 1 ? '' : 's'}` : null,
    adjustments.length ? `${adjustments.length} known adjustment${adjustments.length === 1 ? '' : 's'}` : null,
    instructions.trim() ? 'instructions' : null,
  ].filter(Boolean).join(' · ') || 'Materiality, instructions, watched accounts and known adjustments'

  return (
    <CollapsibleSection title="Review settings" subtitle={subtitle}>
      <div className="space-y-5 p-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium">Materiality</h3>
          <p className="text-xs text-muted-foreground">Differences above the larger of these are errors; smaller ones are shown as information.</p>
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Amount</span>
              <Input value={amount} onChange={e => setAmount(e.target.value)} disabled={!canEdit} placeholder="0" className="h-9 w-36 tabular-nums" />
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Share of NAV</span>
              <Input value={navShare} onChange={e => setNavShare(e.target.value)} disabled={!canEdit} placeholder="0.1%" className="h-9 w-28 tabular-nums" />
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <h3 className="text-base font-medium">Instructions</h3>
          <p className="text-xs text-muted-foreground">
            In your own words: what to pay attention to, how the administrator presents things, what to ask about. The assistant
            reads these before it reviews a package.
          </p>
          <Textarea value={instructions} onChange={e => setInstructions(e.target.value)} disabled={!canEdit} rows={4} maxLength={8000}
            placeholder="For example: the administrator books the management fee a quarter in arrears; check the fee offset every quarter." />
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-base font-medium">Accounts to watch</h3>
            <p className="text-xs text-muted-foreground">
              Reported every period with their balance and movement. A threshold flags the account when it moves by more than that.
            </p>
          </div>
          {watch.map((w, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={w.account} onChange={e => setWatch(l => l.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} disabled={!canEdit} placeholder="Code or name" className="h-9 w-40" aria-label="Account" />
              <Input value={w.note} onChange={e => setWatch(l => l.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} disabled={!canEdit} placeholder="What to look for" className="h-9 flex-1 min-w-48" aria-label="Note" />
              <Input value={w.threshold} onChange={e => setWatch(l => l.map((x, j) => (j === i ? { ...x, threshold: e.target.value } : x)))} disabled={!canEdit} placeholder="Threshold" className="h-9 w-32 tabular-nums" aria-label="Threshold" />
              {canEdit && <Button size="icon" variant="ghost" onClick={() => setWatch(l => l.filter((_, j) => j !== i))} aria-label="Remove"><X className="h-4 w-4" /></Button>}
            </div>
          ))}
          {canEdit && <Button size="sm" variant="outline" onClick={() => setWatch(l => [...l, { account: '', note: '', threshold: '' }])}><Plus className="h-4 w-4 mr-1" /> Add an account</Button>}
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-base font-medium">Known adjustments</h3>
            <p className="text-xs text-muted-foreground">
              Differences you already expect. A finding that matches one is marked explained, with your description, instead of
              raised again. Each needs the partner, holding or statement it applies to, or the amount, or both.
            </p>
          </div>
          {adjustments.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={a.description} onChange={e => setAdjustments(l => l.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} disabled={!canEdit} placeholder="Why it's expected" className="h-9 flex-1 min-w-48" aria-label="Description" />
              <select value={a.check} onChange={e => setAdjustments(l => l.map((x, j) => (j === i ? { ...x, check: e.target.value } : x)))} disabled={!canEdit} className={selectCls} aria-label="Check">
                <option value="">Any check</option>
                {CHECK_IDS.map(c => <option key={c} value={c}>{CHECK_LABELS[c]}</option>)}
              </select>
              <Input value={a.subject} onChange={e => setAdjustments(l => l.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} disabled={!canEdit} placeholder="Applies to" className="h-9 w-44" aria-label="Applies to" />
              <Input value={a.amount} onChange={e => setAdjustments(l => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} disabled={!canEdit} placeholder="Amount" className="h-9 w-32 tabular-nums" aria-label="Amount" />
              {canEdit && <Button size="icon" variant="ghost" onClick={() => setAdjustments(l => l.filter((_, j) => j !== i))} aria-label="Remove"><X className="h-4 w-4" /></Button>}
            </div>
          ))}
          {canEdit && <Button size="sm" variant="outline" onClick={() => setAdjustments(l => [...l, { description: '', check: '', subject: '', amount: '' }])}><Plus className="h-4 w-4 mr-1" /> Add an adjustment</Button>}
        </div>

        {canEdit && (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Save settings</Button>
            {msg && <p role="status" className="text-xs text-success">{msg}</p>}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </CollapsibleSection>
  )
}
