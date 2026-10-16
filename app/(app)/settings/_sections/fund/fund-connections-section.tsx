'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/settings/section'

interface ConnectionView {
  id: string
  status: 'pending' | 'active'
  direction: 'outgoing' | 'incoming'
  otherFundName: string
  pairs: { approved: number; awaitingUs: number; awaitingThem: number }
}
interface Named { id: string; name: string }
interface PairView { id: string; ours: Named; theirs: Named; ourApproval: boolean; theirApproval: boolean; approved: boolean }
interface Suggestion { ours: Named; theirs: Named; reason: 'email' | 'name' }
interface PairsPayload { pairs: PairView[]; suggestions: Suggestion[]; unpaired: Named[] }

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  return { ok: !!res?.ok, data: data ?? {} }
}

/**
 * Connected funds: another fund on this platform whose LPs overlap with ours. An admin asks the
 * other fund to connect (by one of its admins' email), that fund's admin accepts, and then each LP
 * pair is approved by both funds' admins. A report card shows an LP's positions in the other fund
 * only through a pair both sides approved. Nothing happens until an admin sends a request.
 */
export function FundConnectionsSection() {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { ok, data } = await send('/api/settings/fund-connections', 'GET')
    if (!ok) { setError(data.error ?? 'Could not load connected funds.'); setConnections([]); return }
    setConnections(data.connections ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  async function act(key: string, url: string, method: string, body?: unknown, done?: string) {
    setBusy(key); setError(null); setNotice(null)
    const { ok, data } = await send(url, method, body)
    setBusy(null)
    if (!ok) { setError(data.error ?? 'Could not save.'); return false }
    if (done) setNotice(done)
    await load()
    return true
  }

  async function request() {
    if (!email.trim()) return
    const { ok, data } = await send('/api/settings/fund-connections', 'POST', { email })
    if (!ok) { setError(data.error ?? 'Could not send the request.'); return }
    setEmail(''); setError(null); setNotice(`Request sent to ${data.otherFundName}. Their admin needs to accept it.`)
    await load()
  }

  function end(c: ConnectionView) {
    const msg = c.status === 'active'
      ? `Disconnect from ${c.otherFundName}? Every LP pair is removed, and report cards stop showing their positions.`
      : c.direction === 'outgoing' ? `Cancel the request to ${c.otherFundName}?` : `Decline the request from ${c.otherFundName}?`
    if (!confirm(msg)) return
    act(`end-${c.id}`, `/api/settings/fund-connections/${c.id}`, 'DELETE')
  }

  return (
    <Section title="Connected funds">
      <p className="text-xs text-muted-foreground mb-3">
        For LPs who also invest with another fund on this platform. Connect with that fund, then pair
        each shared LP. Their report card shows positions from both funds only after both funds&apos;
        admins approve the pair. Either fund can remove a pair or disconnect at any time.
      </p>
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}
      {notice && <p className="text-sm text-success mb-2">{notice}</p>}

      {connections === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : (
        <div className="space-y-4">
          {connections.length > 0 && (
            <ul className="rounded-card border divide-y">
              {connections.map(c => (
                <li key={c.id} className="px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    {c.status === 'active' ? (
                      <button onClick={() => setOpen(open === c.id ? null : c.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                        {open === c.id ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate">{c.otherFundName}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {c.pairs.approved} linked{c.pairs.awaitingUs > 0 ? ` · ${c.pairs.awaitingUs} to approve` : ''}{c.pairs.awaitingThem > 0 ? ` · ${c.pairs.awaitingThem} waiting on them` : ''}
                        </span>
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">
                        {c.otherFundName}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {c.direction === 'outgoing' ? 'Waiting for them to accept' : 'Wants to connect'}
                        </span>
                      </span>
                    )}
                    {busy === `end-${c.id}` || busy === `answer-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                    {c.status === 'pending' && c.direction === 'incoming' && (
                      <Button size="sm" disabled={busy !== null}
                        onClick={() => act(`answer-${c.id}`, `/api/settings/fund-connections/${c.id}`, 'PATCH', { action: 'accept' }, `Connected with ${c.otherFundName}.`)}>
                        Accept
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => end(c)}>
                      {c.status === 'active' ? 'Disconnect' : c.direction === 'outgoing' ? 'Cancel' : 'Decline'}
                    </Button>
                  </div>
                  {c.status === 'active' && open === c.id && (
                    <ConnectionPairs connection={c} onChanged={load} />
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Input
              value={email} type="email" placeholder="Email of the other fund's admin"
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') request() }}
              className="h-8 max-w-sm"
            />
            <Button size="sm" variant="outline" onClick={request} disabled={!email.trim() || busy !== null}>Request to connect</Button>
          </div>
        </div>
      )}
    </Section>
  )
}

function ConnectionPairs({ connection, onChanged }: { connection: ConnectionView; onChanged: () => Promise<void> }) {
  const url = `/api/settings/fund-connections/${connection.id}/pairs`
  const [data, setData] = useState<PairsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [manual, setManual] = useState<{ ours: string; theirs: string }>({ ours: '', theirs: '' })

  const load = useCallback(async () => {
    const { ok, data } = await send(url, 'GET')
    if (!ok) { setError(data.error ?? 'Could not load the LP pairs.'); return }
    setData(data)
  }, [url])
  useEffect(() => { load() }, [load])

  async function approve(key: string, pairs: { ourInvestorId: string; theirInvestorId?: string; theirMatch?: string }[]) {
    if (pairs.length === 0) return
    setBusy(key); setError(null)
    const { ok, data: res } = await send(url, 'POST', { pairs })
    setBusy(null)
    if (!ok) { setError(res.error ?? 'Could not save.'); return false }
    if (res.skipped?.length) setError(res.skipped.map((s: { reason: string }) => s.reason).filter((r: string, i: number, a: string[]) => a.indexOf(r) === i).join(' '))
    await Promise.all([load(), onChanged()])
    return res.changed > 0
  }

  async function remove(p: PairView) {
    if (!confirm(`Remove the pair ${p.ours.name} ↔ ${p.theirs.name}?`)) return
    setBusy(`remove-${p.id}`); setError(null)
    const { ok, data: res } = await send(url, 'DELETE', { linkId: p.id })
    setBusy(null)
    if (!ok) { setError(res.error ?? 'Could not remove the pair.'); return }
    await Promise.all([load(), onChanged()])
  }

  if (!data) {
    return error
      ? <p className="mt-2 text-sm text-destructive">{error}</p>
      : <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
  }

  const awaitingUs = data.pairs.filter(p => !p.ourApproval)
  const status = (p: PairView) => p.approved ? 'Linked' : p.ourApproval ? 'Waiting on them' : 'Waiting on you'

  return (
    <div className="mt-3 space-y-4 pl-5">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {data.pairs.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs font-medium text-muted-foreground">LP pairs</p>
            {awaitingUs.length > 1 && (
              <Button size="sm" variant="outline" disabled={busy !== null}
                onClick={() => approve('approve-all', awaitingUs.map(p => ({ ourInvestorId: p.ours.id, theirInvestorId: p.theirs.id })))}>
                Approve all {awaitingUs.length}
              </Button>
            )}
          </div>
          <ul className="rounded-card border divide-y">
            {data.pairs.map(p => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{p.ours.name} <span className="text-muted-foreground">↔ {p.theirs.name}</span></span>
                <span className={`text-xs ${p.approved ? 'text-success' : 'text-muted-foreground'}`}>{status(p)}</span>
                {!p.ourApproval && (
                  <button title="Approve" disabled={busy !== null} className="text-muted-foreground hover:text-foreground"
                    onClick={() => approve(`approve-${p.id}`, [{ ourInvestorId: p.ours.id, theirInvestorId: p.theirs.id }])}>
                    {busy === `approve-${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                )}
                <button title="Remove" disabled={busy !== null} className="text-muted-foreground hover:text-foreground" onClick={() => remove(p)}>
                  {busy === `remove-${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.suggestions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs font-medium text-muted-foreground">Suggested pairs (same email or name)</p>
            <Button size="sm" variant="outline" disabled={busy !== null}
              onClick={() => approve('suggest-all', data.suggestions.map(s => ({ ourInvestorId: s.ours.id, theirInvestorId: s.theirs.id })))}>
              {busy === 'suggest-all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Propose all ${data.suggestions.length}`}
            </Button>
          </div>
          <ul className="rounded-card border divide-y">
            {data.suggestions.map(s => (
              <li key={s.ours.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{s.ours.name} <span className="text-muted-foreground">↔ {s.theirs.name}</span></span>
                <span className="text-xs text-muted-foreground">{s.reason === 'email' ? 'Same email' : 'Same name'}</span>
                <Button size="sm" variant="ghost" disabled={busy !== null}
                  onClick={() => approve(`suggest-${s.ours.id}`, [{ ourInvestorId: s.ours.id, theirInvestorId: s.theirs.id }])}>
                  {busy === `suggest-${s.ours.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Propose'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.unpaired.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Pair an LP by hand</p>
          <div className="flex flex-wrap gap-2">
            <select
              value={manual.ours} onChange={e => setManual({ ...manual, ours: e.target.value })}
              aria-label="Our LP" className="h-8 px-2 rounded-md border border-input bg-background text-sm min-w-[180px]"
            >
              <option value="">Our LP…</option>
              {data.unpaired.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <Input
              value={manual.theirs} placeholder="Their LP's exact name or email"
              onChange={e => setManual({ ...manual, theirs: e.target.value })} className="h-8 max-w-xs"
            />
            <Button size="sm" variant="outline" disabled={!manual.ours || !manual.theirs.trim() || busy !== null}
              onClick={async () => { if (await approve('manual', [{ ourInvestorId: manual.ours, theirMatch: manual.theirs }])) setManual({ ours: '', theirs: '' }) }}>
              Propose
            </Button>
          </div>
        </div>
      )}

      {data.pairs.length === 0 && data.suggestions.length === 0 && data.unpaired.length === 0 && (
        <p className="text-xs text-muted-foreground">This fund has no LPs to pair yet.</p>
      )}
    </div>
  )
}
