'use client'

// Bring a draft back from the Google Doc the partners edited: paste the link, see what changes,
// then replace the draft's text. Nothing syncs on its own, so the app stays the record of what
// was sent. The internal notes are kept.

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

interface Diff {
  added: number
  removed: number
  unchanged: number
  changes: { kind: 'added' | 'removed'; line: string }[]
}

interface Props {
  letterId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onReplaced: (letter: any) => void
}

export function PullDialog({ letterId, open, onOpenChange, onReplaced }: Props) {
  const [url, setUrl] = useState('')
  const [diff, setDiff] = useState<Diff | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) { setDiff(null); setError(null) }
  }

  const call = async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'preview')
    setError(null)
    try {
      const res = await fetch(`/api/lp-letters/${letterId}/pull-google-doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apply }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body?.error ?? 'Something went wrong. Try again.'); return }
      if (apply) { onReplaced(body.letter); close(false); setUrl('') }
      else setDiff(body.diff)
    } finally {
      setBusy(null)
    }
  }

  const same = diff && diff.added === 0 && diff.removed === 0

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pull from Google Doc</DialogTitle>
          <DialogDescription>
            Replace this draft with the text of the Google Doc the partners edited. You see what changes first. The internal notes are kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gdoc-url">Google Doc link</Label>
            <div className="flex gap-2">
              <Input
                id="gdoc-url"
                value={url}
                onChange={e => { setUrl(e.target.value); setDiff(null) }}
                placeholder="https://docs.google.com/document/d/…"
              />
              <Button size="sm" variant="outline" onClick={() => call(false)} disabled={!url.trim() || !!busy}>
                {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Compare'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">The fund&apos;s connected Google account must be able to open it.</p>
          </div>

          {error && <p className="rounded-card border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

          {diff && (
            same ? (
              <p className="text-sm text-muted-foreground">The Google Doc matches this draft. There is nothing to bring back.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm">
                  <span className="tabular-nums">{diff.added}</span> {diff.added === 1 ? 'line' : 'lines'} added,{' '}
                  <span className="tabular-nums">{diff.removed}</span> removed,{' '}
                  <span className="tabular-nums">{diff.unchanged}</span> unchanged.
                </p>
                <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-card border p-3 text-sm">
                  {diff.changes.map((c, i) => (
                    <p
                      key={i}
                      className={c.kind === 'added' ? 'bg-success-subtle px-1 text-success' : 'bg-destructive/10 px-1 text-destructive line-through'}
                    >
                      {c.kind === 'added' ? '+ ' : '− '}{c.line}
                    </p>
                  ))}
                  {diff.added + diff.removed > diff.changes.length && (
                    <p className="text-xs text-muted-foreground">And more changes not shown.</p>
                  )}
                </div>
              </div>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)} disabled={!!busy}>Cancel</Button>
          <Button size="sm" onClick={() => call(true)} disabled={!diff || !!same || !!busy}>
            {busy === 'apply' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Replace the draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
