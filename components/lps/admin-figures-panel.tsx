'use client'

// The administrator's figures for an admin-reported vehicle (lib/admin-reporting): who keeps the
// vehicle's books, the pulls saved for it, and a pull checked before saving: from any fund
// administrator's MCP server the app has a built-in pull for, or a CSV.
// Nothing here recalculates a figure: the preview shows what the administrator states, and what
// stops a save is only a partner who isn't matched or a figure that is missing.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Building2, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface PullSummary {
  id: string; asOf: string; source: string; channel: string; status: 'saved' | 'superseded'
  partners: number; fund: { irr: number | null; tvpi: number | null; dpi: number | null } | null; savedAt: string
}
interface Administrator { id: string; name: string; builtInPull: boolean }
interface State { recordSource: 'books' | 'admin'; provider: string | null; fundRef: string | null; administrators: Administrator[]; pulls: PullSummary[] }
interface Position { externalId: string; name: string; commitment: number | null; paidIn: number | null; distributions: number | null; nav: number | null }
interface Preview {
  figures: { asOf: string; source: string; positions: Position[]; fund: { irr: number | null; tvpi: number | null; dpi: number | null } }
  flags: { blocking: string[]; warnings: string[]; matches: { externalId: string; lpEntityId: string | null; by: string | null }[]; changes: { name: string; field: string; from: number | null; to: number | null }[] }
  ready: boolean
  raw?: unknown
}

const money = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`)
const mult = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(2)}x`)

export function AdminFiguresPanel({ group, canEdit, onSaved }: { group: string; canEdit: boolean; onSaved: () => void }) {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Pull inputs.
  const [asOf, setAsOf] = useState('')
  const [csv, setCsv] = useState<string | null>(null)
  const [csvName, setCsvName] = useState('')
  const [source, setSource] = useState('')
  const [fund, setFund] = useState({ irr: '', tvpi: '', dpi: '' })
  // Setup inputs.
  const [setup, setSetup] = useState(false)
  const [provider, setProvider] = useState('')
  const [fundRef, setFundRef] = useState('')

  const load = useCallback(() => {
    if (!group) return
    fetch(`/api/accounting/admin-figures?group=${encodeURIComponent(group)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setState(d ? { recordSource: d.recordSource, provider: d.provider, fundRef: d.fundRef, administrators: d.administrators ?? [], pulls: d.pulls ?? [] } : null))
      .catch(() => setState(null))
  }, [group])
  // The view keys this panel by entity, so switching entity starts it fresh.
  useEffect(() => { load() }, [load])

  async function post(body: Record<string, unknown>): Promise<any> {
    setBusy(true); setError(null); setMsg(null)
    try {
      const res = await fetch('/api/accounting/admin-figures', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, ...body }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? 'Something went wrong.'); if (d.flags) setPreview(p => (p ? { ...p, flags: d.flags, ready: false } : p)); return null }
      return d
    } finally { setBusy(false) }
  }

  async function saveSetup(recordSource: 'books' | 'admin') {
    setBusy(true); setError(null)
    const res = await fetch('/api/accounting/admin-figures', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, record_source: recordSource, provider: provider || state?.administrators[0]?.id || 'csv', fund_ref: fundRef }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(d.error ?? 'Could not save.'); return }
    setSetup(false); load(); onSaved()
  }

  async function pull() {
    const d = await post({ step: 'pull', as_of: asOf })
    if (d) setPreview(d)
  }
  async function check() {
    const d = await post({
      step: 'preview', csv, as_of: asOf, source: source || 'CSV upload',
      fund: { irr: fund.irr || null, tvpi: fund.tvpi || null, dpi: fund.dpi || null },
    })
    if (d) setPreview(d)
  }
  async function save() {
    if (!preview) return
    const figures = {
      ...preview.figures,
      positions: preview.figures.positions.map((p, i) => ({ ...p, lpEntityId: preview.flags.matches[i]?.lpEntityId ?? undefined })),
    }
    const d = await post({ step: 'save', figures, raw: preview.raw })
    if (!d) return
    setPreview(null)
    setMsg(`Saved ${d.partners} partners as of ${d.asOf}.${d.superseded ? ' The earlier pull for that date is kept as superseded.' : ''}`)
    load(); onSaved()
  }

  if (!state) return null
  // The vehicle's administrator, when it is one of the deployment's fund-admin MCP servers.
  const current = state.administrators.find(a => a.id === state.provider) ?? null
  const chosen = provider || state.administrators[0]?.id || 'csv'
  const chosenAdmin = state.administrators.find(a => a.id === chosen) ?? null

  if (state.recordSource === 'books') {
    if (!canEdit) return null
    return (
      <div className="rounded-card border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium">Administrator figures</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          This entity reports from its own books. If a fund administrator keeps its books instead, its LP cards can show the
          administrator&apos;s figures as stated, with nothing recalculated.
        </p>
        {!setup ? (
          <Button size="sm" variant="outline" onClick={() => setSetup(true)}>Report from an administrator</Button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Administrator</span>
              <select value={chosen} onChange={e => setProvider(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                {state.administrators.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="csv">CSV export</option>
                <option value="other">Other (figures given by hand)</option>
              </select>
            </label>
            {chosenAdmin && (
              <label className="text-xs text-muted-foreground space-y-1">
                <span className="block">Fund id at {chosenAdmin.name}{chosenAdmin.builtInPull ? '' : ' (optional)'}</span>
                <Input value={fundRef} onChange={e => setFundRef(e.target.value)} className="h-9 w-80" />
              </label>
            )}
            <Button size="sm" onClick={() => saveSetup('admin')} disabled={busy || (!!chosenAdmin?.builtInPull && !fundRef.trim())}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setSetup(false)}>Cancel</Button>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  const latest = state.pulls.find(p => p.status === 'saved')
  return (
    <div className="rounded-card border p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium">Administrator figures</h2>
        </div>
        {canEdit && (
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => saveSetup('books')} disabled={busy}>
            Report from the books instead
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The LP cards for this entity show {current?.name ?? 'the administrator'}&apos;s figures as stated: each
        partner&apos;s commitment, paid-in, distributions and NAV, and the fund&apos;s net LP-only IRR, TVPI and DPI on every row.
        {latest ? ` Latest saved: ${latest.asOf} (${latest.source}).` : ' Nothing is saved yet.'}
      </p>

      {state.pulls.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="text-left font-normal py-1">As of</th><th className="text-left font-normal">Source</th><th className="text-right font-normal">Partners</th><th className="text-right font-normal">Net IRR</th><th className="text-right font-normal">TVPI</th><th className="text-right font-normal">DPI</th><th className="text-left font-normal pl-3">Saved</th></tr>
            </thead>
            <tbody>
              {state.pulls.slice(0, 12).map(p => (
                <tr key={p.id} className={`border-t ${p.status === 'superseded' ? 'text-muted-foreground' : ''}`}>
                  <td className="py-1 tabular-nums">{p.asOf}</td>
                  <td>{p.source}{p.status === 'superseded' ? ' (superseded)' : ''}</td>
                  <td className="text-right tabular-nums">{p.partners}</td>
                  <td className="text-right tabular-nums">{pct(p.fund?.irr)}</td>
                  <td className="text-right tabular-nums">{mult(p.fund?.tvpi)}</td>
                  <td className="text-right tabular-nums">{mult(p.fund?.dpi)}</td>
                  <td className="pl-3 tabular-nums text-muted-foreground">{p.savedAt.slice(0, 10)}{p.channel === 'assistant' ? ' · assistant' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">As of (quarter end)</span>
              <Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="h-9 w-40" />
            </label>
            {current?.builtInPull ? (
              <Button size="sm" onClick={pull} disabled={busy || !asOf}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} Pull from {current.name}
              </Button>
            ) : (
              <>
                <label className="text-xs text-muted-foreground space-y-1">
                  <span className="block">Source</span>
                  <Input value={source} onChange={e => setSource(e.target.value)} placeholder="Administrator name" className="h-9 w-44" />
                </label>
                {(['irr', 'tvpi', 'dpi'] as const).map(k => (
                  <label key={k} className="text-xs text-muted-foreground space-y-1">
                    <span className="block">{k === 'irr' ? 'Net IRR' : k.toUpperCase()}</span>
                    <Input value={fund[k]} onChange={e => setFund(f => ({ ...f, [k]: e.target.value }))} placeholder={k === 'irr' ? '6.08%' : '1.25x'} className="h-9 w-24 tabular-nums" />
                  </label>
                ))}
                <label className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-input px-3 text-sm">
                  <Upload className="h-4 w-4" /> {csvName || 'Choose CSV'}
                  <input type="file" accept=".csv,text/csv,text/tab-separated-values" className="sr-only" onChange={async e => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    setCsvName(f.name); setCsv(await f.text())
                  }} />
                </label>
                <Button size="sm" onClick={check} disabled={busy || !asOf || !csv}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Check
                </Button>
              </>
            )}
          </div>
          {current && !current.builtInPull && (
            <p className="text-xs text-muted-foreground">
              The app has no built-in pull for {current.name} yet. Ask the assistant to pull it: it reads {current.name} with your own
              connection and stages the figures for approval. Or upload a CSV here.
            </p>
          )}
          {!current?.builtInPull && (
            <p className="text-xs text-muted-foreground">The CSV needs columns Name, Commitment, Paid-in, Distributions and NAV; Partner ID and Receivable are optional.</p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {msg && <p role="status" className="text-xs text-success">{msg}</p>}

      {preview && (
        <div className="space-y-3 rounded-card border p-3">
          <p className="text-sm">
            <span className="font-medium">{preview.figures.source}</span>, as of <span className="tabular-nums">{preview.figures.asOf}</span>:{' '}
            {preview.figures.positions.length} partners. Net IRR {pct(preview.figures.fund.irr)}, TVPI {mult(preview.figures.fund.tvpi)}, DPI {mult(preview.figures.fund.dpi)}.
          </p>
          {preview.flags.blocking.map((b, i) => <p key={`b${i}`} role="alert" className="rounded-md bg-destructive/10 px-2 py-1 text-sm text-destructive">{b}</p>)}
          {preview.flags.warnings.map((w, i) => <p key={`w${i}`} className="rounded-md bg-warning-subtle px-2 py-1 text-sm">{w}</p>)}
          {preview.flags.changes.length > 0 && (
            <p className="text-xs text-muted-foreground">{preview.flags.changes.length} figure{preview.flags.changes.length === 1 ? '' : 's'} differ from the pull already saved for this date; saving replaces it.</p>
          )}
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground sticky top-0 bg-background">
                <tr><th className="text-left font-normal py-1">Partner</th><th className="text-right font-normal">Commitment</th><th className="text-right font-normal">Paid-in</th><th className="text-right font-normal">Distributions</th><th className="text-right font-normal">NAV</th><th className="text-left font-normal pl-3">Match</th></tr>
              </thead>
              <tbody>
                {preview.figures.positions.map((p, i) => {
                  const m = preview.flags.matches[i]
                  return (
                    <tr key={p.externalId} className="border-t">
                      <td className="py-1">{p.name}</td>
                      <td className="text-right tabular-nums">{money(p.commitment)}</td>
                      <td className="text-right tabular-nums">{money(p.paidIn)}</td>
                      <td className="text-right tabular-nums">{money(p.distributions)}</td>
                      <td className="text-right tabular-nums">{money(p.nav)}</td>
                      <td className={`pl-3 text-sm ${m?.lpEntityId ? 'text-muted-foreground' : 'text-destructive'}`}>
                        {m?.lpEntityId ? (m.by === 'name' ? 'by name' : m.by === 'link' ? 'known' : 'given') : 'not matched'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={busy || !preview.ready}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Save as of {preview.figures.asOf}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Discard</Button>
          </div>
        </div>
      )}
    </div>
  )
}
