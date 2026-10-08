// app/(app)/companies/[id]/holding-wallets.tsx
'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2, AlertTriangle, Check, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { HoldingEntity } from '@/lib/portfolio/holding-entities'
import { useCanWrite } from '@/components/access-context'
import { latestOnly } from '@/lib/portfolio/latest-only'
import { chainVarianceText } from './holding-panels'

interface WalletRow {
  id: string
  chain: string
  address: string
  label: string | null
  entity: string | null
  verified_at: string | null
  latestBalance: { as_of_date: string; units: number } | null
}
interface Variance { vehicleId: string; entity: string; observedUnits: number; recordedUnits: number; delta: number; asOf: string | null }

const CHAINS = ['ethereum', 'bitcoin', 'solana', 'base', 'arbitrum', 'polygon', 'avalanche']
const units = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 })
const shortAddress = (a: string) => (a.length <= 14 ? a : `${a.slice(0, 8)}…${a.slice(-4)}`)

/**
 * The public addresses this digital asset sits in, per entity. The variance is the headline: the
 * gap between the chain and the books is the one thing here that can tell you something new.
 */
export function HoldingWallets({ companyId, entities }: { companyId: string; entities: HoldingEntity[] }) {
  const url = `/api/companies/${companyId}/wallets`
  const [wallets, setWallets] = useState<WalletRow[]>([])
  const [variances, setVariances] = useState<Variance[]>([])
  const canWrite = useCanWrite('portfolio', 'investments')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const guardRef = useRef<ReturnType<typeof latestOnly> | null>(null)
  if (!guardRef.current) guardRef.current = latestOnly()
  const guard = guardRef.current
  const [loaded, setLoaded] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ vehicleId: entities.length === 1 ? entities[0].id : '', chain: 'ethereum', address: '', label: '' })
  const [balanceFor, setBalanceFor] = useState<string | null>(null)
  const [balanceForm, setBalanceForm] = useState({ asOfDate: '', units: '', blockHeight: '' })

  const load = useCallback(async () => {
    const current = guard.begin()
    try {
      const res = await fetch(url)
      const data = await res.json().catch(() => null)
      if (!current()) return
      if (!res.ok || !data) {
        setLoadError(data?.error ?? 'Could not load the wallets.')
        return
      }
      setWallets(data.wallets ?? [])
      setVariances(data.variances ?? [])
      setLoaded(true)
      setLoadError(null)
    } catch {
      if (current()) setLoadError('Could not load the wallets.')
    } finally {
      if (current()) setLoading(false)
    }
  }, [url, guard])
  useEffect(() => { void load() }, [load])

  const post = async (body: object) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'That did not save.'); return null }
      await load()
      return data
    } finally { setBusy(false) }
  }

  async function addWallet() {
    const d = await post({ action: 'add', vehicleId: form.vehicleId, chain: form.chain, address: form.address, label: form.label })
    if (d) {
      setAdding(false)
      setForm(f => ({ ...f, address: '', label: '' }))
      setNote('Now watching that address.')
    }
  }

  async function removeWallet(w: WalletRow) {
    setConfirmRemove(null)
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${url}?walletId=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Could not stop watching that address.')
        return
      }
      setNote(`No longer watching ${shortAddress(w.address)}.`)
      await load()
    } finally { setBusy(false) }
  }

  async function recordBalance(walletId: string) {
    const d = await post({
      action: 'record-balance',
      walletId,
      asOfDate: balanceForm.asOfDate,
      units: Number(balanceForm.units),
      blockHeight: balanceForm.blockHeight ? Number(balanceForm.blockHeight) : null,
    })
    if (d) { setBalanceFor(null); setBalanceForm({ asOfDate: '', units: '', blockHeight: '' }) }
  }

  if (loading && !loaded) {
    return <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading wallets…</div>
  }

  if (loadError && !loaded) {
    return (
      <section className="mt-6 space-y-3">
        <h2 className="text-base font-medium">Wallets</h2>
        <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{loadError}</p>
      </section>
    )
  }

  return (
    <section className="mt-6 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium">Wallets</h2>
        {canWrite && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAdding(a => !a)} disabled={busy || entities.length === 0}>
            <Plus className="h-3.5 w-3.5 mr-1" />Watch an address
          </Button>
        )}
      </div>

      {loadError && <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{loadError}</p>}
      {error && <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>}
      {note && <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><Check className="h-4 w-4 mt-0.5 shrink-0 text-success" />{note}</p>}

      {variances.length > 0 && (
        <div className="rounded-card border border-warning/40 bg-warning-subtle px-3 py-2 space-y-1">
          <p className="text-sm font-medium">The chain and the books disagree</p>
          {variances.map(v => <p key={v.vehicleId} className="text-sm tabular-nums">{chainVarianceText(v)}</p>)}
          <p className="text-xs text-muted-foreground pt-1">
            Often a transfer between your own wallets, an airdrop nobody has recorded, or staking rewards
            still accruing. The close reports it but does not block on it — the books may be right.
          </p>
        </div>
      )}

      {canWrite && adding && (
        <div className="rounded-card border p-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="w-entity" className="text-xs">Held by</Label>
              <select id="w-entity" value={form.vehicleId} onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))} className="border rounded-lg px-2 py-1 text-sm h-9 w-full bg-background">
                <option value="">Choose an entity…</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="w-chain" className="text-xs">Chain</Label>
              <select id="w-chain" value={form.chain} onChange={e => setForm(f => ({ ...f, chain: e.target.value }))} className="border rounded-lg px-2 py-1 text-sm h-9 w-full bg-background">
                {CHAINS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="w-address" className="text-xs">Address</Label>
              <Input id="w-address" className="font-mono text-xs" value={form.address} placeholder="0x…" onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="w-label" className="text-xs">Label</Label>
              <Input id="w-label" value={form.label} placeholder="Treasury, cold storage…" onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            A public, watch-only address — never a key or a seed phrase. Nothing here can move funds.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={addWallet} disabled={busy || !form.vehicleId || !form.address.trim()}>Watch it</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {wallets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No addresses watched. A digital asset can be tracked by hand like any other holding —
          watching an address adds a second opinion on the quantity.
        </p>
      ) : (
        <div className="border rounded-card overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">Address</th>
                <th className="text-left px-3 py-2 font-medium">Entity</th>
                <th className="text-right px-3 py-2 font-medium">Last read</th>
                <th className="text-left px-3 py-2 font-medium">On</th>
                <th className="text-left px-3 py-2 font-medium">Control</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {wallets.map(w => (
                <Fragment key={w.id}>
                  <tr className="border-b last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs">{shortAddress(w.address)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{w.label ?? w.chain}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{w.entity ?? 'Shared, no entity'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{w.latestBalance ? units(w.latestBalance.units) : '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{w.latestBalance?.as_of_date ?? 'never read'}</td>
                    <td className="px-3 py-2 text-xs">
                      {w.verified_at ? (
                        <span className="inline-flex items-center gap-1 text-success"><ShieldCheck className="h-3.5 w-3.5" />proven</span>
                      ) : !canWrite ? (
                        <span className="text-muted-foreground">unproven</span>
                      ) : (
                        <select
                          aria-label="Record proof of control"
                          value=""
                          onChange={e => { if (e.target.value) void post({ action: 'verify', walletId: w.id, method: e.target.value }) }}
                          disabled={busy}
                          className="border rounded-lg px-2 py-1 text-xs h-7 bg-background"
                        >
                          <option value="">Unproven</option>
                          <option value="signed_message">Signed message</option>
                          <option value="test_transaction">Test transaction</option>
                          <option value="custodian_statement">Custodian statement</option>
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canWrite && confirmRemove === w.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-sm">Stop watching this address?</span>
                          <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={busy} onClick={() => removeWallet(w)}>Stop watching</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(null)}>Keep</Button>
                        </span>
                      ) : canWrite && (
                        <>
                          <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setBalanceFor(balanceFor === w.id ? null : w.id)}>
                            Record a balance
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setConfirmRemove(w.id)} aria-label={`Stop watching ${w.address}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                  {canWrite && balanceFor === w.id && (
                    <tr className="border-b bg-muted/20">
                      <td colSpan={6} className="px-3 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="space-y-1">
                            <Label htmlFor={`b-date-${w.id}`} className="text-xs">As of</Label>
                            <Input id={`b-date-${w.id}`} className="w-40" type="date" value={balanceForm.asOfDate} onChange={e => setBalanceForm(b => ({ ...b, asOfDate: e.target.value }))} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`b-units-${w.id}`} className="text-xs">Units</Label>
                            <Input id={`b-units-${w.id}`} className="w-40 tabular-nums" type="number" step="any" value={balanceForm.units} onChange={e => setBalanceForm(b => ({ ...b, units: e.target.value }))} />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`b-block-${w.id}`} className="text-xs">Block height</Label>
                            <Input id={`b-block-${w.id}`} className="w-40 tabular-nums" type="number" placeholder="optional" value={balanceForm.blockHeight} onChange={e => setBalanceForm(b => ({ ...b, blockHeight: e.target.value }))} />
                          </div>
                          <Button size="sm" disabled={busy || !balanceForm.asOfDate || !balanceForm.units} onClick={() => recordBalance(w.id)}>Save reading</Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
