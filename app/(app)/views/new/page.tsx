'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { CustomViewRenderer } from '@/components/custom-views/view-renderer'
import type { CustomViewPayload } from '@/lib/mcp-apps/payload'

const EXAMPLES = [
  'Fair value, cost and gross MOIC as tiles, the ten largest positions as bars, and every position below cost as a table. Filter by vehicle.',
  'Commitments, called, distributed and NAV across LPs as tiles, and each LP\'s NAV as bars, largest first.',
  'Diligence deals by stage as bars, and a table of open deals with their stage and when they were created.',
  'Investments by quarter as a line, and the latest transactions as a table.',
]

/**
 * Build a custom view with the fund's own model: describe it, see it live, change it in words,
 * save it. A client page (nothing in page-domains.ts): /api/views/draft writes and validates the
 * spec and loads the preview as the caller; /api/views saves it. `?from=<id>` starts from a saved
 * view, to change it.
 */
function NewViewBuilder() {
  const router = useRouter()
  const from = useSearchParams().get('from')
  const [instruction, setInstruction] = useState('')
  const [spec, setSpec] = useState<unknown>(null)
  const [payload, setPayload] = useState<CustomViewPayload | null>(null)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState<'build' | 'save' | 'load' | null>(from ? 'load' : null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const box = useRef<HTMLTextAreaElement>(null)

  // Changing a saved view: start from its spec and name.
  useEffect(() => {
    if (!from) return
    let live = true
    fetch(`/api/views/${encodeURIComponent(from)}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? 'Could not load that view.')
        if (!live) return
        setSpec(body.spec)
        setPayload(body.payload)
        setName(body.view.kind === 'mine' ? body.view.name : `${body.view.name} (copy)`)
        setShared(body.view.kind === 'mine' && body.view.shared)
      })
      .catch(e => live && setError((e as Error).message))
      .finally(() => live && setBusy(null))
    return () => { live = false }
  }, [from])

  const build = async () => {
    const text = instruction.trim()
    if (!text) { box.current?.focus(); return }
    setBusy('build')
    setError(null)
    try {
      const r = await fetch('/api/views/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: text, ...(spec ? { spec } : {}) }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? 'Could not build the view.')
      setSpec(body.spec)
      setPayload(body.payload)
      if (!name) setName(body.spec.title)
      setHistory(h => [...h, text])
      setInstruction('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const r = await fetch('/api/views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || (spec as { title?: string })?.title, spec, shared }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? 'Could not save the view.')
      router.push(body.saved.path)
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const startOver = () => {
    setSpec(null); setPayload(null); setName(''); setHistory([]); setError(null); setInstruction('')
    if (from) router.replace('/views/new')
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="space-y-2">
        <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Views
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{from ? 'Change view' : 'New view'}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Describe what you want to see. The view is built from tiles, charts, tables and notes over your live data, and
          each person who opens it sees only the figures their own access allows.
        </p>
      </div>

      <div className="max-w-3xl space-y-3">
        <Label htmlFor="view-instruction">{spec ? 'What should change?' : 'Describe the view'}</Label>
        <Textarea
          id="view-instruction"
          ref={box}
          rows={3}
          value={instruction}
          placeholder={spec ? 'e.g. Make the positions a table and add unfunded commitments as a tile' : 'e.g. NAV, unfunded and the largest positions, filterable by vehicle'}
          onChange={e => setInstruction(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build() }}
          disabled={busy !== null}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={build} disabled={busy !== null || !instruction.trim()}>
            {busy === 'build' ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {busy === 'build' ? 'Building' : spec ? 'Update view' : 'Build view'}
          </Button>
          {spec !== null && (
            <Button variant="ghost" onClick={startOver} disabled={busy !== null}><RotateCcw /> Start over</Button>
          )}
        </div>
        {!spec && busy === null && (
          <div className="space-y-1.5 pt-1">
            <p className="text-caption text-muted-foreground">Or start from one of these:</p>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES.map(ex => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => { setInstruction(ex); box.current?.focus() }}
                  className="rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.length > 0 && (
          <ol className="list-decimal space-y-0.5 pl-5 text-caption text-muted-foreground">
            {history.map((h, i) => <li key={i}>{h}</li>)}
          </ol>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {busy === 'load' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading view</div>
      )}

      {payload && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 rounded-card border bg-card p-4">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label htmlFor="view-name">Name</Label>
              <Input id="view-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch checked={shared} onCheckedChange={setShared} /> Share with the fund
            </label>
            <Button onClick={save} disabled={busy !== null || !name.trim()}>
              {busy === 'save' && <Loader2 className="animate-spin" />} Save view
            </Button>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">{payload.title}</p>
            <div className={busy === 'build' ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
              <CustomViewRenderer payload={payload} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function NewViewPage() {
  return (
    <Suspense fallback={null}>
      <NewViewBuilder />
    </Suspense>
  )
}
