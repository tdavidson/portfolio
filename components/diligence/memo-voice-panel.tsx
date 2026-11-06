'use client'

// The fund's memo voice: learned from its sample memos, edited by the partners, and used for every
// memo the agent drafts and every memo a connected assistant writes (diligence_memo_skill).

import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface VoiceRow {
  voice: string | null
  house_rules: string | null
  examples: string | null
  learned_from?: string[] | null
  learned_at?: string | null
  updated_at?: string | null
}

const FIELDS: Array<{ key: 'voice' | 'house_rules' | 'examples'; label: string; help: string; rows: number }> = [
  { key: 'voice', label: 'Voice', help: 'How the partners write memos: who is speaking, sentence habits, each kind of section, what to avoid.', rows: 12 },
  { key: 'house_rules', label: 'House rules', help: 'Standing conventions every memo follows: number and date formats, naming, what always or never appears.', rows: 6 },
  { key: 'examples', label: 'Examples', help: 'Each kind of section written out in full, with invented companies and figures. Writers copy the shape, never the facts.', rows: 10 },
]

export function MemoVoicePanel() {
  const [loaded, setLoaded] = useState(false)
  const [form, setForm] = useState<{ voice: string; house_rules: string; examples: string }>({ voice: '', house_rules: '', examples: '' })
  const [saved, setSaved] = useState<VoiceRow | null>(null)
  const [learnedFrom, setLearnedFrom] = useState<string[] | null>(null)
  const [reused, setReused] = useState<string[]>([])
  const [busy, setBusy] = useState<null | 'learn' | 'save'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/firm/memo-voice')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('load')))
      .then(body => {
        const v = body.voice as VoiceRow | null
        setSaved(v)
        setForm({ voice: v?.voice ?? '', house_rules: v?.house_rules ?? '', examples: v?.examples ?? '' })
      })
      .catch(() => setError('Could not load the memo voice.'))
      .finally(() => setLoaded(true))
  }, [])

  async function learn() {
    setBusy('learn'); setError(null); setNotice(null)
    try {
      const res = await fetch('/api/firm/memo-voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Learning the voice failed')
      setForm({ voice: body.voice ?? '', house_rules: body.house_rules ?? '', examples: body.examples ?? '' })
      setLearnedFrom(body.learned_from ?? null)
      setReused(Array.isArray(body.reused) ? body.reused : [])
      setNotice('A draft voice is below. Read and edit it, then save it to use it for every memo.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Learning the voice failed')
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    setBusy('save'); setError(null); setNotice(null)
    try {
      const res = await fetch('/api/firm/memo-voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, ...(learnedFrom ? { learned_from: learnedFrom } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Save failed')
      setSaved(body.voice)
      setLearnedFrom(null)
      setReused([])
      setNotice('Saved. New memos are written in this voice.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(null)
    }
  }

  if (!loaded) return null

  return (
    <section className="mt-8 rounded-card border bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-semibold">Memo voice</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
            The voice, house rules and examples every memo is written in, by the memo agent and by Claude in a chat.
            {saved?.voice ? '' : ' Until you save one, memos use a general voice.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={learn} disabled={busy !== null}>
          {busy === 'learn' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
          Learn from example memos
        </Button>
      </div>

      {notice && <p className="text-sm text-muted-foreground mb-3">{notice}</p>}
      {reused.length > 0 && (
        <div className="mb-3 rounded-md border border-warning/50 bg-warning-subtle dark:bg-warning-subtle/30 text-warning px-2.5 py-2 text-sm">
          The examples reuse names or figures from the memos: {reused.join(', ')}. Replace them with invented ones before saving.
        </div>
      )}

      <div className="space-y-4">
        {FIELDS.map(f => (
          <div key={f.key}>
            <label className="block text-xs font-medium mb-1">{f.label}</label>
            <textarea
              value={form[f.key]}
              onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
              rows={f.rows}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{f.help}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-destructive mt-3">{error}</p>}
      <div className="flex items-center gap-3 mt-4">
        <Button size="sm" onClick={save} disabled={busy !== null}>
          {busy === 'save' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          Save memo voice
        </Button>
        {saved?.updated_at && <span className="text-xs text-muted-foreground">Last saved {new Date(saved.updated_at).toLocaleString()}</span>}
      </div>
    </section>
  )
}
