'use client'

// Bring a draft back from the Word file the partners edited: choose the file, see which sections
// it changes and how, then replace the draft's text. Each section keeps its sources and charts, and
// the internal notes are kept. Nothing syncs on its own, so the app stays the record of what was sent.

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

interface Comparison {
  sections: { section_id: string; heading: string | null; change: 'changed' | 'added' | 'removed' }[]
  unchanged_sections: number
  internal: string | null
  diff: { added: number; removed: number; unchanged: number; changes: { kind: 'added' | 'removed'; line: string }[] }
}

interface Props {
  letterId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onReplaced: (letter: any) => void
}

const CHANGE_LABEL = { changed: 'Changed', added: 'New', removed: 'Gone' } as const

export function WordDialog({ letterId, open, onOpenChange, onReplaced }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) { setCmp(null); setError(null); setFile(null) }
  }

  const call = async (apply: boolean, f = file) => {
    if (!f) return
    setBusy(apply ? 'apply' : 'preview')
    setError(null)
    try {
      const form = new FormData()
      form.append('file', f)
      if (apply) form.append('apply', 'true')
      const res = await fetch(`/api/lp-letters/${letterId}/pull-word`, { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body?.error ?? 'Something went wrong. Try again.'); return }
      if (apply) { onReplaced(body.letter); close(false) }
      else setCmp(body.comparison)
    } finally {
      setBusy(null)
    }
  }

  const same = cmp && cmp.sections.length === 0 && cmp.diff.added === 0 && cmp.diff.removed === 0

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bring back from Word</DialogTitle>
          <DialogDescription>
            Replace this draft with the text of the Word file the partners edited. You see what changes first. Each section keeps
            its sources and charts, and the internal notes are kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="word-file">Word file</Label>
            <input id="word-file" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="block w-full text-sm"
              onChange={e => { const f = e.target.files?.[0] ?? null; setFile(f); setCmp(null); if (f) call(false, f) }} />
            <p className="text-xs text-muted-foreground">
              Works best with the Word file this page exports: its headings mark the sections. The title, letterhead, images and
              captions in the file are left out.
            </p>
          </div>

          {busy === 'preview' && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Comparing…</p>}
          {error && <p className="rounded-card border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

          {cmp && (
            same ? (
              <p className="text-sm text-muted-foreground">The Word file matches this draft. There is nothing to bring back.</p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="tabular-nums">{cmp.sections.length}</span> {cmp.sections.length === 1 ? 'section' : 'sections'} differ,{' '}
                    <span className="tabular-nums">{cmp.unchanged_sections}</span> unchanged.
                  </p>
                  <ul className="text-sm space-y-0.5">
                    {cmp.sections.map(s => (
                      <li key={`${s.change}-${s.section_id}`} className="flex gap-2">
                        <span className={`w-16 shrink-0 text-sm ${s.change === 'removed' ? 'text-destructive' : s.change === 'added' ? 'text-success' : 'text-warning'}`}>
                          {CHANGE_LABEL[s.change]}
                        </span>
                        <span className="truncate">{s.heading ?? 'Opening'}</span>
                      </li>
                    ))}
                  </ul>
                  {cmp.sections.some(s => s.change === 'removed') && (
                    <p className="text-xs text-muted-foreground">A section that is gone loses its sources; a chart placed after it moves to the end.</p>
                  )}
                  {cmp.internal && <p className="text-xs text-muted-foreground">The file&apos;s &quot;Missing information&quot; section goes to the internal notes, not the letter.</p>}
                </div>
                <div className="max-h-[40vh] space-y-1 overflow-y-auto rounded-card border p-3 text-sm">
                  {cmp.diff.changes.map((c, i) => (
                    <p key={i} className={c.kind === 'added' ? 'bg-success-subtle px-1 text-success' : 'bg-destructive/10 px-1 text-destructive line-through'}>
                      {c.kind === 'added' ? '+ ' : '− '}{c.line}
                    </p>
                  ))}
                  {cmp.diff.added + cmp.diff.removed > cmp.diff.changes.length && (
                    <p className="text-xs text-muted-foreground">And more changes not shown.</p>
                  )}
                </div>
              </div>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)} disabled={!!busy}>Cancel</Button>
          <Button size="sm" onClick={() => call(true)} disabled={!cmp || !!same || !!busy}>
            {busy === 'apply' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Replace the draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
