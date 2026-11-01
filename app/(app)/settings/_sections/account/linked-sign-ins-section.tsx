'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/confirm-dialog'
import { Section } from '@/components/settings/section'

interface Link { userId: string; email: string | null; fundName: string | null; allowed: boolean; isYou: boolean }

/**
 * Linked sign-ins (lib/account-links.ts). For someone who works for several funds here, usually an
 * outside fund administrator, tax preparer or auditor: link the sign-in you hold in each, and one
 * assistant connection switches between those funds, acting in each with that fund's access.
 */
export function LinkedSignInsSection() {
  const confirm = useConfirm()
  const [links, setLinks] = useState<Link[]>([])
  const [allowed, setAllowed] = useState(true)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)
  const [entered, setEntered] = useState('')
  const [pending, setPending] = useState<{ email: string | null; fundName: string | null } | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/account/links')
    if (!res.ok) return
    const d = await res.json().catch(() => ({}))
    setLinks(Array.isArray(d.links) ? d.links : [])
    setAllowed(d.allowed !== false)
    setPending(d.pending ?? null)
  }, [])
  useEffect(() => { load() }, [load])

  async function post(body: Record<string, unknown>) {
    setBusy(true); setError(null)
    const res = await fetch('/api/account/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(d.error ?? 'That did not work. Try again.'); return null }
    return d
  }

  async function getCode() {
    const d = await post({ action: 'code' })
    if (d) setCode(d)
  }

  async function link() {
    const d = await post({ action: 'link', code: entered })
    if (d) { setEntered(''); setWaiting(true); await load() }
  }

  async function decide(action: 'confirm' | 'decline') {
    const d = await post({ action })
    if (d) { setCode(null); await load() }
  }

  async function unlink() {
    const ok = await confirm({
      title: 'Unlink this sign-in?',
      description: 'Connections made with your other sign-ins stop reaching this fund, and this one stops reaching theirs.',
      confirmLabel: 'Unlink',
      variant: 'destructive',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch('/api/account/links', { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) { setError('Could not unlink. Try again.'); return }
    await load()
  }

  return (
    <Section title="Linked sign-ins">
      <p className="text-sm text-muted-foreground mb-3">
        Work for more than one fund here? Link the sign-in you use for each, and one Claude or ChatGPT connection can switch
        between those funds. In each fund it can do only what you can do there.
      </p>
      {!allowed && <p className="text-sm text-warning mb-3">This fund has switched linking off, so linked connections can&apos;t reach it.</p>}

      {pending && (
        <div className="rounded-card border border-warning bg-warning-subtle p-3 mb-3 text-sm space-y-2">
          <p>
            <span className="font-medium">{pending.email ?? 'Another sign-in'}</span>
            {pending.fundName ? <> in <span className="font-medium">{pending.fundName}</span></> : null} entered your link code.
            Confirm only if that is you: once linked, a connection made with either sign-in can work in both funds.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => decide('confirm')} disabled={busy}>Link these sign-ins</Button>
            <Button size="sm" variant="outline" onClick={() => decide('decline')} disabled={busy}>That wasn&apos;t me</Button>
          </div>
        </div>
      )}
      {waiting && !pending && (
        <p className="text-sm text-muted-foreground mb-3">Code accepted. Now confirm the link from the sign-in that showed it.</p>
      )}

      {links.length > 0 && (
        <ul className="divide-y mb-3">
          {links.map(l => (
            <li key={l.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{l.fundName ?? 'No fund'}</span>
                <span className="text-muted-foreground"> · {l.email ?? 'unknown'}{l.isYou ? ' (this sign-in)' : ''}</span>
              </span>
              {!l.allowed && <span className="text-xs text-muted-foreground">linking off</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={getCode} disabled={busy}>Get a link code</Button>
          {code && (
            <span className="text-sm">
              <span className="font-mono tracking-widest">{code.code}</span>
              <span className="text-muted-foreground"> · sign in with your other account and enter it there within 10 minutes</span>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={entered} onChange={e => setEntered(e.target.value)} placeholder="Code from your other sign-in" className="h-9 w-56 font-mono" />
          <Button size="sm" onClick={link} disabled={busy || entered.replace(/[^A-Za-z0-9]/g, '').length !== 8}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Link
          </Button>
          {links.length > 0 && <Button size="sm" variant="outline" onClick={unlink} disabled={busy}>Unlink this sign-in</Button>}
        </div>
      </div>
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
    </Section>
  )
}
