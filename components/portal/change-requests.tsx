'use client'

// The investor's record, and asking the fund to change it (lib/lps/change-requests.ts). Nothing
// changes here: each save is a request the fund approves or rejects, and its state is listed below.
// An authorized user sees the record but can't ask, since their access is read-only.

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ENTITY_TYPES, ENTITY_TYPE_LABEL } from '@/lib/lp-profile'

interface Signatory { name: string; title: string | null; email: string | null }
interface EntityRecord {
  id: string
  name: string
  entity_type: string | null
  formation_jurisdiction: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  notice_email: string | null
  signatories: Signatory[] | null
}
interface InvestorRecord {
  id: string
  name: string
  contact: { contact_name: string | null; contact_email: string | null; contact_phone: string | null }
  entities: EntityRecord[]
}
interface RequestRow {
  id: string
  kind: 'profile' | 'authorized_user'
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  entityName: string | null
  investorName: string | null
  payload: Record<string, any>
  createdAt: string
  decisionNote: string | null
}

const TEXT_FIELDS: [keyof EntityRecord, string][] = [
  ['formation_jurisdiction', 'Formed in'],
  ['address_line1', 'Address'],
  ['address_line2', 'Address line 2'],
  ['city', 'City'],
  ['region', 'State or region'],
  ['postal_code', 'Postal code'],
  ['country', 'Country'],
  ['notice_email', 'Email for notices'],
]

const STATUS_LABEL: Record<RequestRow['status'], string> = {
  pending: 'Waiting for the fund', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn',
}

/** Signatories as one per line, "Name, Title, email". */
const sigToText = (s: Signatory[] | null) => (s ?? []).map(x => [x.name, x.title ?? '', x.email ?? ''].join(', ').replace(/(, )+$/, '')).join('\n')
const textToSig = (t: string): Signatory[] => t.split('\n').map(l => l.split(',').map(p => p.trim())).filter(p => p[0])
  .map(([name, title, email]) => ({ name, title: title || null, email: email || null }))

export function PortalChangeRequests() {
  const [loading, setLoading] = useState(true)
  const [canRequest, setCanRequest] = useState(false)
  const [investors, setInvestors] = useState<InvestorRecord[]>([])
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/portal/change-requests')
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      setCanRequest(!!data.record?.canRequest)
      setInvestors(data.record?.investors ?? [])
      setRequests(data.requests ?? [])
    }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function submit(body: object): Promise<boolean> {
    setErr(null); setMsg(null)
    const res = await fetch('/api/portal/change-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setErr(data.error ?? 'Your request could not be sent.'); return false }
    setMsg('Sent to the fund. Nothing changes until they approve it.')
    await load()
    return true
  }

  async function withdraw(id: string) {
    const res = await fetch(`/api/portal/change-requests?id=${id}`, { method: 'DELETE' })
    if (res.ok) await load()
  }

  if (loading) return <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
  if (!canRequest) {
    return <p className="text-sm text-muted-foreground">Your access is read-only. The investor can ask the fund to change their record, or you can message the fund.</p>
  }

  const pending = new Set(requests.filter(r => r.status === 'pending' && r.kind === 'profile').map(r => r.entityName))

  return (
    <div className="space-y-5">
      {msg && <p className="text-sm text-success">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}

      {investors.map(inv => (
        <div key={inv.id} className="space-y-3">
          {investors.length > 1 && <p className="text-xs uppercase tracking-widest text-muted-foreground">{inv.name}</p>}
          {inv.entities.map(e => (
            <div key={e.id} className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm flex-1 min-w-0 truncate">{e.name}</span>
                {pending.has(e.name) && <span className="text-xs text-muted-foreground">Change waiting for the fund</span>}
                {editing !== e.id && (
                  <button type="button" onClick={() => setEditing(e.id)} className="text-sm text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors">
                    Ask to change
                  </button>
                )}
              </div>
              {editing === e.id ? (
                <EntityForm
                  entity={e}
                  contact={inv.contact}
                  onCancel={() => setEditing(null)}
                  onSubmit={async body => { if (await submit({ kind: 'profile', entity_id: e.id, ...body })) setEditing(null) }}
                />
              ) : (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Type</dt>
                  <dd>{e.entity_type ? ENTITY_TYPE_LABEL[e.entity_type as keyof typeof ENTITY_TYPE_LABEL] ?? e.entity_type : 'Not set'}</dd>
                  <dt className="text-muted-foreground">Address</dt>
                  <dd>{[e.address_line1, e.address_line2, e.city, e.region, e.postal_code, e.country].filter(Boolean).join(', ') || 'Not set'}</dd>
                  <dt className="text-muted-foreground">Notices to</dt>
                  <dd>{e.notice_email ?? inv.contact.contact_email ?? 'Not set'}</dd>
                  <dt className="text-muted-foreground">Signatories</dt>
                  <dd>{(e.signatories ?? []).map(s => s.name).join(', ') || 'None on file'}</dd>
                </dl>
              )}
            </div>
          ))}
          <AccessRequest investorId={inv.id} onSubmit={body => submit({ kind: 'authorized_user', investor_id: inv.id, ...body })} />
        </div>
      ))}

      {requests.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Your requests</p>
          <div className="rounded-md border divide-y">
            {requests.map(r => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="truncate">
                    {r.kind === 'profile' ? `Change to ${r.entityName ?? 'your record'}` : `Access for ${r.payload?.email ?? 'someone'}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {STATUS_LABEL[r.status]} · <span className="tabular-nums">{r.createdAt.slice(0, 10)}</span>
                    {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                  </div>
                </div>
                {r.status === 'pending' && (
                  <button type="button" onClick={() => withdraw(r.id)} className="text-sm text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors">
                    Withdraw
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function EntityForm({
  entity, contact, onCancel, onSubmit,
}: {
  entity: EntityRecord
  contact: InvestorRecord['contact']
  onCancel: () => void
  onSubmit: (body: { entity: Record<string, unknown>; contact: Record<string, unknown>; note: string }) => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    TEXT_FIELDS.map(([k]) => [k, (entity[k] as string | null) ?? '']).concat([['entity_type', entity.entity_type ?? '']]),
  ))
  const [sigs, setSigs] = useState(sigToText(entity.signatories))
  const [c, setC] = useState({ contact_name: contact.contact_name ?? '', contact_email: contact.contact_email ?? '', contact_phone: contact.contact_phone ?? '' })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    setBusy(true)
    // Send everything; the server keeps only what differs from the record.
    await onSubmit({
      entity: { ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() || null])), signatories: textToSig(sigs) },
      contact: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.trim() || null])),
      note,
    })
    setBusy(false)
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Entity type</Label>
          <select
            value={values.entity_type}
            onChange={ev => setValues(v => ({ ...v, entity_type: ev.target.value }))}
            className="h-9 w-full rounded-sm border border-border bg-background px-3 text-sm text-foreground"
          >
            <option value="">Not set</option>
            {ENTITY_TYPES.map(t => <option key={t} value={t}>{ENTITY_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        {TEXT_FIELDS.map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label className="text-xs">{label}</Label>
            <Input value={values[k]} onChange={ev => setValues(v => ({ ...v, [k]: ev.target.value }))} />
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Signatories, one per line: name, title, email</Label>
        <textarea value={sigs} onChange={ev => setSigs(ev.target.value)} rows={3} className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label className="text-xs">Contact name</Label><Input value={c.contact_name} onChange={ev => setC({ ...c, contact_name: ev.target.value })} /></div>
        <div className="space-y-1"><Label className="text-xs">Contact email</Label><Input value={c.contact_email} onChange={ev => setC({ ...c, contact_email: ev.target.value })} /></div>
        <div className="space-y-1"><Label className="text-xs">Contact phone</Label><Input value={c.contact_phone} onChange={ev => setC({ ...c, contact_phone: ev.target.value })} /></div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Note for the fund (optional)</Label>
        <Input value={note} onChange={ev => setNote(ev.target.value)} placeholder="For example, we moved offices in October" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={send} disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Send to the fund</Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

function AccessRequest({ investorId, onSubmit }: { investorId: string; onSubmit: (body: { email: string; name: string; note: string }) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-foreground underline underline-offset-4 hover:text-muted-foreground transition-colors">
        Ask the fund to give someone access
      </button>
    )
  }
  return (
    <div className="rounded-md border p-3 space-y-3" data-investor={investorId}>
      <p className="text-xs text-muted-foreground">An advisor or accountant gets read-only access to your account once the fund approves it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label className="text-xs">Their name</Label><Input value={name} onChange={ev => setName(ev.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Their email</Label><Input type="email" value={email} onChange={ev => setEmail(ev.target.value)} /></div>
      </div>
      <div className="space-y-1"><Label className="text-xs">Note for the fund (optional)</Label><Input value={note} onChange={ev => setNote(ev.target.value)} /></div>
      <div className="flex gap-2">
        <Button
          size="sm"
         
          disabled={busy || !email.trim()}
          onClick={async () => {
            setBusy(true)
            if (await onSubmit({ email, name, note })) { setOpen(false); setEmail(''); setName(''); setNote('') }
            setBusy(false)
          }}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Send to the fund
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}
