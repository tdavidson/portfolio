'use client'

// An entity's letter profile (lib/lp-letters/profile.ts): the fixed facts its letters copy, edited
// here, proposed from its last sent letter, and saved to the fund's data. And bringing in a letter
// as it was sent, which then counts as the entity's last letter.

import { useEffect, useState } from 'react'
import { Loader2, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { LetterProfile } from '@/lib/lp-letters/profile'

interface Company { id: string; name: string; portfolioGroup: string[] | null }

const FIRM = '__firm__'

/** The fund's entities and companies, as the new-letter page reads them. */
function useEntities(open: boolean) {
  const [groups, setGroups] = useState<string[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  useEffect(() => {
    if (!open) return
    fetch('/api/dashboard/table-data').then(r => r.json()).then(data => {
      const list: Company[] = Array.isArray(data?.companies) ? data.companies : []
      setCompanies(list)
      setGroups(Array.from(new Set(list.flatMap(c => c.portfolioGroup ?? []))).sort())
    }).catch(() => {})
  }, [open])
  return { groups, companies }
}

const linesOf = (p: LetterProfile) => p.signatories.map(s => (s.title ? `${s.name}, ${s.title}` : s.name)).join('\n')
const signatoriesOf = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const i = l.indexOf(',')
  return i === -1 ? { name: l, title: null } : { name: l.slice(0, i).trim(), title: l.slice(i + 1).trim() || null }
})

export function ProfileDialog({ open, onOpenChange, templates }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: { id: string; name: string }[]
}) {
  const { groups, companies } = useEntities(open)
  const [vehicle, setVehicle] = useState<string>(FIRM)
  const [profile, setProfile] = useState<LetterProfile | null>(null)
  const [signers, setSigners] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'save' | 'seed' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [seededFrom, setSeededFrom] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true); setMessage(null); setSeededFrom(null)
    const q = vehicle === FIRM ? '' : `?vehicle=${encodeURIComponent(vehicle)}`
    fetch(`/api/lp-letters/profiles${q}`).then(r => r.json()).then(data => {
      const own: LetterProfile = data?.own ?? {
        legal_name: null, short_name: null, firm_name: null, fund_stage: null, signatories: [], company_names: [],
        footnotes: null, parties: null, fixed_text: [], template_id: null,
      }
      setProfile(own)
      setSigners(linesOf(own))
    }).finally(() => setLoading(false))
  }, [open, vehicle])

  const set = <K extends keyof LetterProfile>(k: K, v: LetterProfile[K]) => setProfile(p => (p ? { ...p, [k]: v } : p))
  const held = vehicle === FIRM ? [] : companies.filter(c => c.portfolioGroup?.includes(vehicle))
  const nameOf = (id: string) => profile?.company_names.find(c => c.company_id === id)
  const setName = (id: string, change: Partial<LetterProfile['company_names'][number]>) => {
    if (!profile) return
    const current = nameOf(id) ?? { company_id: id, display_name: null, former_names: [], status: null }
    const next = { ...current, ...change }
    const rest = profile.company_names.filter(c => c.company_id !== id)
    set('company_names', next.display_name || next.former_names.length || next.status ? [...rest, next] : rest)
  }

  const seed = async () => {
    setBusy('seed'); setMessage(null)
    const res = await fetch('/api/lp-letters/profiles/seed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      // A proposal: the person reviews it here before saving. Fields the letter didn't give keep what was there.
      const merged: LetterProfile = { ...(profile as LetterProfile) }
      for (const [k, v] of Object.entries(data.profile ?? {})) {
        if (v !== null && !(Array.isArray(v) && !v.length) && k !== 'template_id') (merged as any)[k] = v
      }
      setProfile(merged)
      setSigners(linesOf(merged))
      setSeededFrom(data.letter?.id ?? null)
      setMessage(`Proposed from the ${data.letter?.period ?? 'last'} letter. Check each field, then save.`)
    } else setMessage(data?.error ?? 'Reading the letter failed.')
    setBusy(null)
  }

  const save = async () => {
    if (!profile) return
    setBusy('save'); setMessage(null)
    const q = vehicle === FIRM ? '' : `?vehicle=${encodeURIComponent(vehicle)}`
    const res = await fetch(`/api/lp-letters/profiles${q}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { ...profile, signatories: signatoriesOf(signers) }, seeded_from: seededFrom }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) { setProfile(data.own); setSigners(linesOf(data.own)); setMessage('Saved.'); setSeededFrom(null) }
    else setMessage(data?.error ?? 'Saving failed.')
    setBusy(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Letter profiles</DialogTitle>
          <DialogDescription>
            The fixed facts each entity&apos;s letters copy rather than write. The firm-wide profile holds defaults; an entity&apos;s
            own profile fills in or overrides each field. They stay in your fund&apos;s data.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[200px]">
            <Label>Entity</Label>
            <Select value={vehicle} onValueChange={setVehicle}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FIRM}>Firm-wide defaults</SelectItem>
                {groups.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {vehicle !== FIRM && (
            <Button size="sm" variant="outline" onClick={seed} disabled={!!busy || loading} title="Read the entity's last sent letter and propose its profile">
              {busy === 'seed' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
              Propose from last sent letter
            </Button>
          )}
        </div>

        {loading || !profile ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Legal name" value={profile.legal_name} onChange={v => set('legal_name', v)} />
              <Field label="Short name" value={profile.short_name} onChange={v => set('short_name', v)} />
              <Field label="Firm name" value={profile.firm_name} onChange={v => set('firm_name', v)} />
              <div className="space-y-1.5">
                <Label>Stage</Label>
                <Select value={profile.fund_stage ?? 'none'} onValueChange={v => set('fund_stage', v === 'none' ? null : (v as 'investing' | 'harvesting'))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    <SelectItem value="investing">Investing</SelectItem>
                    <SelectItem value="harvesting">Harvesting</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Letter template</Label>
              <Select value={profile.template_id ?? 'default'} onValueChange={v => set('template_id', v === 'default' ? null : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">The fund&apos;s default voice</SelectItem>
                  {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Signatories</Label>
              <p className="text-xs text-muted-foreground">One per line, in signing order: name, then a comma and the title.</p>
              <Textarea rows={3} value={signers} onChange={e => setSigners(e.target.value)} placeholder={'Jane Doe, Managing Partner\nJohn Roe, Partner'} />
            </div>

            {held.length > 0 && (
              <div className="space-y-1.5">
                <Label>Company names</Label>
                <p className="text-xs text-muted-foreground">Only where the letter names a company differently from the books, or gives a status they can&apos;t.</p>
                <div className="rounded-lg border divide-y">
                  {held.map(c => {
                    const n = nameOf(c.id)
                    return (
                      <div key={c.id} className="grid gap-2 p-2 sm:grid-cols-[1fr_1fr_1fr_120px] items-center text-sm">
                        <span className="truncate">{c.name}</span>
                        <Input className="h-8 text-xs" placeholder="Display name" value={n?.display_name ?? ''} onChange={e => setName(c.id, { display_name: e.target.value || null })} />
                        <Input className="h-8 text-xs" placeholder="Former names, comma separated" value={(n?.former_names ?? []).join(', ')}
                          onChange={e => setName(c.id, { former_names: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
                        <Input className="h-8 text-xs" placeholder="Status" value={n?.status ?? ''} onChange={e => setName(c.id, { status: e.target.value || null })} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <Area label="Standing footnotes" value={profile.footnotes} onChange={v => set('footnotes', v)} rows={3} />
            <Field label="Parties the letter names" value={profile.parties} onChange={v => set('parties', v)} placeholder="Fund administrator, auditor" />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Fixed paragraphs</Label>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => set('fixed_text', [...profile.fixed_text, { heading: '', text: '' }])}>
                  <Plus className="h-3 w-3 mr-1" />Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Paragraphs the letter repeats each quarter, under their heading. They are copied unless the facts change.</p>
              {profile.fixed_text.map((f, i) => (
                <div key={i} className="rounded-lg border p-2 space-y-2">
                  <div className="flex gap-2">
                    <Input className="h-8 text-xs" placeholder="Heading" value={f.heading}
                      onChange={e => set('fixed_text', profile.fixed_text.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} />
                    <Button size="sm" variant="outline" className="h-8" aria-label="Remove" onClick={() => set('fixed_text', profile.fixed_text.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Textarea rows={3} className="text-xs" value={f.text}
                    onChange={e => set('fixed_text', profile.fixed_text.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="items-center gap-2">
          {message && <p className="text-xs text-muted-foreground mr-auto">{message}</p>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={save} disabled={!!busy || loading || !profile}>
            {busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string | null; onChange: (v: string | null) => void; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value ?? ''} onChange={e => onChange(e.target.value || null)} placeholder={placeholder} />
    </div>
  )
}

function Area({ label, value, onChange, rows }: { label: string; value: string | null; onChange: (v: string | null) => void; rows: number }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea rows={rows} value={value ?? ''} onChange={e => onChange(e.target.value || null)} />
    </div>
  )
}

export function ImportLetterDialog({ open, onOpenChange, onImported }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (letter: { id: string }) => void
}) {
  const { groups } = useEntities(open)
  const [vehicle, setVehicle] = useState('')
  const thisYear = new Date().getUTCFullYear()
  const [year, setYear] = useState(String(thisYear))
  const [quarter, setQuarter] = useState('1')
  const [yearEnd, setYearEnd] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (open && !vehicle && groups.length) setVehicle(groups[0]) }, [open, groups, vehicle])

  const submit = async () => {
    if (!file || !vehicle) return
    setBusy(true); setError(null)
    const form = new FormData()
    form.append('file', file)
    form.append('vehicle', vehicle)
    form.append('year', year)
    form.append('quarter', quarter)
    form.append('year_end', String(yearEnd))
    const res = await fetch('/api/lp-letters/import', { method: 'POST', body: form })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) { onOpenChange(false); setFile(null); onImported(data) }
    else setError(data?.error ?? 'The import failed.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import a sent letter</DialogTitle>
          <DialogDescription>
            A letter as it went to investors (PDF or Word). It is saved as final, the file is kept as sent, and the next
            letter for this entity starts from it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Entity</Label>
            <Select value={vehicle} onValueChange={setVehicle}>
              <SelectTrigger><SelectValue placeholder="Choose the entity" /></SelectTrigger>
              <SelectContent>{groups.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Year</Label>
              <Input type="number" className="tabular-nums" value={year} onChange={e => setYear(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Quarter</Label>
              <Select value={quarter} onValueChange={setQuarter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{['1', '2', '3', '4'].map(q => <SelectItem key={q} value={q}>Q{q}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {quarter === '4' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={yearEnd} onChange={e => setYearEnd(e.target.checked)} />
              Also the year-end letter
            </label>
          )}
          <label className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm cursor-pointer hover:bg-muted">
            <Upload className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{file ? file.name : 'Choose the letter file'}</span>
            <input type="file" className="hidden" accept=".pdf,.docx,.txt,.md" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !file || !vehicle}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
