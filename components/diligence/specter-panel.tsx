'use client'

import { useEffect, useState } from 'react'
import { Loader2, FileText, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Save a Specter company profile into the deal's data room.
 *
 * Shown only to a member who has connected Specter in Settings, in a fund whose AI provider is
 * Claude. The profile is compiled with the member's own Specter sign-in and then ingested like any
 * upload, so the memo agent and the diligence assistant read it as evidence.
 */
export function SpecterPanel({ dealId, dealName, onSaved }: { dealId: string; dealName: string; onSaved: () => void }) {
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(dealName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/diligence/${dealId}/documents/from-specter`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setAvailable(!!d.connected && !!d.supported) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dealId])

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/documents/from-specter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error ?? 'Couldn’t save the profile.')
        return
      }
      setSaved(body.file_name ?? 'Specter profile')
      setOpen(false)
      onSaved()
    } catch {
      setError('Couldn’t reach the server.')
    } finally {
      setSaving(false)
    }
  }

  if (!available) return null

  return (
    <div className="mb-3 space-y-1">
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <FileText className="h-3.5 w-3.5 mr-1" /> Save Specter profile
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !saving) save() }}
            placeholder="Company website or name"
            className="h-8 max-w-xs"
            autoFocus
          />
          <Button size="sm" onClick={save} disabled={saving || !query.trim()}>
            {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Looking up…</> : 'Save to data room'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
        </div>
      )}
      {open && (
        <p className="text-xs text-muted-foreground">
          A website domain finds the right company most reliably. Takes up to a minute.
        </p>
      )}
      {saved && (
        <p className="text-xs text-success flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" /> Added {saved} and queued it for analysis.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
