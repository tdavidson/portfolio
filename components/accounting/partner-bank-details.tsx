'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, Loader2, Mail, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'

interface WireSummary {
  lpEntityId: string
  beneficiaryName: string
  bankName: string
  routingMasked: string | null
  swiftCode: string | null
  accountMasked: string
  reference: string | null
  status: 'unverified' | 'verified'
  enteredBy: string | null
  enteredAt: string
  verifiedBy: string | null
  verifiedAt: string | null
  verificationNote: string | null
}

const EMPTY = { beneficiaryName: '', beneficiaryAddress: '', bankName: '', bankAddress: '', routingNumber: '', swiftCode: '', accountNumber: '', intermediaryBank: '', intermediarySwift: '', reference: '', currency: '' }
type Form = typeof EMPTY

/**
 * Each partner's bank details for distributions: masked, with whether they were verified by
 * callback. Admins enter or change them (any change clears the verification), verify them (not
 * the person who entered them), reveal the full numbers with a logged reason, and ask partners for
 * them by email. Numbers are never shown in full here except on an explicit reveal.
 */
export function PartnerBankDetails({ partners, isAdmin }: { partners: { id: string; name: string }[]; isAdmin: boolean }) {
  const lf = useLedgerFetch()
  const [wires, setWires] = useState<Record<string, WireSummary>>({})
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<{ id: string; mode: 'edit' | 'verify' | 'reveal' } | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [cb, setCb] = useState({ calledName: '', calledNumber: '', calledOn: new Date().toISOString().slice(0, 10), note: '' })
  const [reason, setReason] = useState('')
  const [revealed, setRevealed] = useState<Record<string, { accountNumber: string; routingNumber: string | null }>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [requestSel, setRequestSel] = useState<Set<string>>(new Set())

  const ids = partners.map(p => p.id).join(',')
  const load = useCallback(async () => {
    if (!ids) { setLoading(false); return }
    setLoading(true)
    const res = await lf(`/api/lps/wire-instructions?lp_entity_ids=${encodeURIComponent(ids)}`)
    const data = await res.json().catch(() => ({}))
    setWires(res.ok ? data.wires ?? {} : {})
    setLoading(false)
  }, [lf, ids])
  useEffect(() => { void load() }, [load])

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null)
    const res = await lf('/api/lps/wire-instructions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? 'Something went wrong.' }); return null }
    return data
  }

  async function save(id: string) {
    const data = await post({ action: 'save', lp_entity_id: id, wire: form })
    if (!data) return
    setMsg({ ok: true, text: data.changed?.length ? `Saved. Changed: ${data.changed.join(', ')}. Someone else now has to verify them by callback.` : data.created ? 'Saved. Someone else now has to verify them by callback.' : 'No change.' })
    setOpen(null); setForm(EMPTY); setRevealed(r => { const n = { ...r }; delete n[id]; return n })
    void load()
  }
  async function verify(id: string) {
    const data = await post({ action: 'verify', lp_entity_id: id, callback: cb })
    if (!data) return
    setMsg({ ok: true, text: 'Verified.' }); setOpen(null); void load()
  }
  async function reveal(id: string) {
    const data = await post({ action: 'reveal', lp_entity_id: id, reason })
    if (!data) return
    setRevealed(r => ({ ...r, [id]: data })); setOpen(null); setReason('')
  }
  async function request(preview: boolean) {
    setBusy(true); setMsg(null)
    const res = await lf('/api/lps/wire-instructions/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lp_entity_ids: Array.from(requestSel), preview }) })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? 'Could not send.' }); return }
    if (preview) {
      const who = (data.recipients ?? []).map((r: any) => `${r.to} (${r.entities.map((e: any) => e.name).join(', ')}${r.via === 'contact' ? ', no portal account' : ''})`)
      const extra = [
        data.unreachable?.length ? `Nobody to email for: ${data.unreachable.join(', ')}.` : '',
        data.alreadyVerified?.length ? `Left out, already verified: ${data.alreadyVerified.join(', ')}.` : '',
      ].filter(Boolean).join(' ')
      setMsg({ ok: true, text: who.length ? `Would email ${who.join('; ')}. ${extra}` : `Nobody would be emailed. ${extra}` })
      return
    }
    setMsg({ ok: data.failures?.length === 0, text: `Sent ${data.sent}.${data.failures?.length ? ` Failed: ${data.failures.join('; ')}.` : ''}${data.unreachable?.length ? ` Nobody to email for: ${data.unreachable.join(', ')}.` : ''}` })
    setRequestSel(new Set())
  }

  const f = (label: string, k: keyof Form, placeholder = '', className = '') => (
    <label className={`text-muted-foreground ${className}`}>{label}
      <Input value={form[k]} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} placeholder={placeholder} className="mt-1 h-8 text-xs" autoComplete="off" />
    </label>
  )

  if (loading) return <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading bank details…</div>

  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">
        Account and routing numbers are encrypted and shown masked. Any change clears the verification, and whoever enters or changes
        details cannot verify them: someone else confirms them by calling a number the fund already holds. The payout sheet prints only verified details.
      </p>
      {msg && <div className={`text-sm ${msg.ok ? 'text-success' : 'text-destructive'}`}>{msg.text}</div>}
      <div className="divide-y rounded-card border">
        {partners.map(p => {
          const w = wires[p.id]
          const r = revealed[p.id]
          const mode = open?.id === p.id ? open.mode : null
          return (
            <div key={p.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                {isAdmin && (
                  <input type="checkbox" aria-label={`Ask ${p.name} for bank details`} checked={requestSel.has(p.id)}
                    onChange={e => setRequestSel(s => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n })} />
                )}
                <span className="font-medium">{p.name}</span>
                {!w && <span className="text-xs text-muted-foreground">No bank details on file</span>}
                {w && (
                  <span className="text-xs text-muted-foreground">
                    {w.bankName} · {w.beneficiaryName} · account <span className="tabular-nums">{r ? r.accountNumber : w.accountMasked}</span>
                    {w.routingMasked && <> · ABA <span className="tabular-nums">{r ? r.routingNumber : w.routingMasked}</span></>}
                    {w.swiftCode && <> · SWIFT {w.swiftCode}</>}
                    {w.reference && <> · ref {w.reference}</>}
                  </span>
                )}
                {w?.status === 'verified' && (
                  <span className="inline-flex items-center gap-1 text-xs text-success" title={w.verificationNote ?? undefined}>
                    <CheckCircle2 className="h-3.5 w-3.5" />Verified {w.verifiedAt?.slice(0, 10)}{w.verifiedBy ? ` by ${w.verifiedBy}` : ''}
                  </span>
                )}
                {w?.status === 'unverified' && (
                  <span className="inline-flex items-center gap-1 text-sm text-warning"><ShieldAlert className="h-3.5 w-3.5" />Not verified · entered {w.enteredAt.slice(0, 10)}{w.enteredBy ? ` by ${w.enteredBy}` : ''}</span>
                )}
                {isAdmin && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setOpen({ id: p.id, mode: 'edit' }); setForm(w ? { ...EMPTY, beneficiaryName: w.beneficiaryName, bankName: w.bankName, swiftCode: w.swiftCode ?? '', reference: w.reference ?? '' } : EMPTY) }}>{w ? 'Change' : 'Enter'}</Button>
                    {w?.status === 'unverified' && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setOpen({ id: p.id, mode: 'verify' })}>Verify</Button>}
                    {w && !r && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setOpen({ id: p.id, mode: 'reveal' })}>Reveal</Button>}
                  </span>
                )}
              </div>
              {mode === 'edit' && (
                <div className="mt-2 rounded-md border bg-muted/20 p-3 text-xs space-y-2">
                  <div className="text-muted-foreground">Enter the details from the partner's signed instructions. Re-type the account and routing numbers in full; nothing is kept from before.</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {f('Beneficiary (account holder)', 'beneficiaryName')}
                    {f('Beneficiary address', 'beneficiaryAddress', '', 'sm:col-span-2')}
                    {f('Bank', 'bankName')}
                    {f('Bank address', 'bankAddress', '', 'sm:col-span-2')}
                    {f('ABA routing number', 'routingNumber', '9 digits')}
                    {f('SWIFT/BIC', 'swiftCode', 'International wires')}
                    {f('Account number or IBAN', 'accountNumber')}
                    {f('Reference / for further credit', 'reference')}
                    {f('Intermediary bank', 'intermediaryBank')}
                    {f('Intermediary SWIFT/BIC', 'intermediarySwift')}
                    {f('Currency', 'currency', 'USD')}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => save(p.id)} disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)} disabled={busy}>Cancel</Button>
                  </div>
                </div>
              )}
              {mode === 'verify' && (
                <div className="mt-2 rounded-md border bg-muted/20 p-3 text-xs space-y-2">
                  <div className="text-muted-foreground">Call a number the fund already holds for this investor, not one given with these details, and read back the bank, account and routing numbers.</div>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <label className="text-muted-foreground">Who you spoke to<Input value={cb.calledName} onChange={e => setCb(c => ({ ...c, calledName: e.target.value }))} className="mt-1 h-8 text-xs" /></label>
                    <label className="text-muted-foreground">Number you called<Input value={cb.calledNumber} onChange={e => setCb(c => ({ ...c, calledNumber: e.target.value }))} className="mt-1 h-8 text-xs" /></label>
                    <label className="text-muted-foreground">Date<Input type="date" value={cb.calledOn} onChange={e => setCb(c => ({ ...c, calledOn: e.target.value }))} className="mt-1 h-8 text-xs" /></label>
                    <label className="text-muted-foreground">Note (optional)<Input value={cb.note} onChange={e => setCb(c => ({ ...c, note: e.target.value }))} className="mt-1 h-8 text-xs" /></label>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => verify(p.id)} disabled={busy}>Record callback and verify</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)} disabled={busy}>Cancel</Button>
                  </div>
                </div>
              )}
              {mode === 'reveal' && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why you need the full numbers (logged)" className="h-8 text-xs min-w-0 flex-1" />
                  <Button size="sm" onClick={() => reveal(p.id)} disabled={busy || !reason.trim()}>Reveal</Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)} disabled={busy}>Cancel</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {isAdmin && requestSel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{requestSel.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => request(true)} disabled={busy}>Preview request</Button>
          <Button size="sm" onClick={() => request(false)} disabled={busy} className="gap-1.5"><Mail className="h-3.5 w-3.5" />Email a request for bank details</Button>
        </div>
      )}
    </div>
  )
}

/** The payout sheet for a declared distribution: admins only, and every export is logged. */
export function DistributionPayoutLink({ id }: { id: string }) {
  const { group } = useVehicle()
  const qs = new URLSearchParams(group ? { group, id } : { id })
  return (
    <Button size="sm" variant="outline" asChild className="gap-1.5" title="Each partner's net payable and verified bank details. Contains full account numbers; the export is logged.">
      <a href={`/api/accounting/distributions/payouts?${qs.toString()}`}><Download className="h-3.5 w-3.5" />Payout sheet (.xlsx)</a>
    </Button>
  )
}
