'use client'

// The fund's letter voice: the templates letters are written in. A template holds a voice (how the
// partners write), examples (each section in full, invented facts) and house rules (standing
// instructions). One is the fund's voice. A voice can be learned from past letters or memos, which
// makes a draft to read and edit before it is used.

import { useState } from 'react'
import { Loader2, Trash2, Upload, Pencil, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

export interface VoiceTemplate {
  id: string
  name: string
  source_type: string | null
  source_filename: string | null
  source_files?: { filename: string; chars: number }[] | null
  structure?: string | null
  style_guide?: string | null
  examples?: string | null
  house_rules?: string | null
  is_default: boolean
  created_at: string
}

const MAX_DOCUMENTS = 12

function origin(t: VoiceTemplate): string {
  if (t.source_type === 'default') return 'Built-in default'
  const files = t.source_files ?? []
  if (files.length > 1) return `Learned from ${files.length} documents`
  if (files.length === 1 || t.source_filename) return `Learned from ${files[0]?.filename ?? t.source_filename}`
  return 'Written by hand'
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: VoiceTemplate[]
  setTemplates: (update: (prev: VoiceTemplate[]) => VoiceTemplate[]) => void
}

export function VoiceDialog({ open, onOpenChange, templates, setTemplates }: Props) {
  const [view, setView] = useState<'list' | 'learn' | 'edit'>('list')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Learning
  const [learnName, setLearnName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [reused, setReused] = useState<string[]>([])
  const [unread, setUnread] = useState<string[]>([])

  // Editing
  const [editing, setEditing] = useState<VoiceTemplate | null>(null)
  const [name, setName] = useState('')
  const [structure, setStructure] = useState('')
  const [voice, setVoice] = useState('')
  const [examples, setExamples] = useState('')
  const [houseRules, setHouseRules] = useState('')

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) { setView('list'); setError(null); setReused([]); setUnread([]); setFiles([]) }
  }

  const edit = (t: VoiceTemplate) => {
    setEditing(t)
    setName(t.name)
    setStructure(t.structure ?? '')
    setVoice(t.style_guide ?? '')
    setExamples(t.examples ?? '')
    setHouseRules(t.house_rules ?? '')
    setError(null)
    setView('edit')
  }

  const replace = (t: VoiceTemplate) => setTemplates(prev => {
    const rest = prev.filter(p => p.id !== t.id).map(p => (t.is_default ? { ...p, is_default: false } : p))
    return [t, ...rest]
  })

  const request = async (key: string, url: string, init: RequestInit): Promise<any | null> => {
    setBusy(key)
    setError(null)
    try {
      const res = await fetch(url, init)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body?.error ?? 'Something went wrong. Try again.'); return null }
      return body
    } finally {
      setBusy(null)
    }
  }

  const chooseGeneral = async () => {
    const t = await request('default', '/api/lp-letters/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })
    if (t) replace(t)
  }

  const learn = async () => {
    if (!files.length) return
    const form = new FormData()
    for (const f of files) form.append('file', f)
    form.append('name', learnName.trim() || 'Learned voice')
    const t = await request('learn', '/api/lp-letters/templates', { method: 'POST', body: form })
    if (!t) return
    const { reused_from_sources, unread_files, ...row } = t
    replace(row)
    setReused(reused_from_sources ?? [])
    setUnread(unread_files ?? [])
    setFiles([])
    setLearnName('')
    edit(row)
  }

  const save = async (makeFundVoice: boolean) => {
    if (!editing) return
    const t = await request(makeFundVoice ? 'use' : 'save', `/api/lp-letters/templates/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, structure, style_guide: voice, examples, house_rules: houseRules, ...(makeFundVoice ? { is_default: true } : {}) }),
    })
    if (!t) return
    replace(t)
    setReused([])
    setUnread([])
    setView('list')
  }

  const chooseAsVoice = async (t: VoiceTemplate) => {
    const row = await request(`use:${t.id}`, `/api/lp-letters/templates/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_default: true }),
    })
    if (row) replace(row)
  }

  const remove = async (t: VoiceTemplate) => {
    if (!window.confirm(`Delete the "${t.name}" template?`)) return
    const ok = await request(`delete:${t.id}`, `/api/lp-letters/templates/${t.id}`, { method: 'DELETE' })
    if (ok) setTemplates(prev => prev.filter(p => p.id !== t.id))
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={view === 'edit' ? 'max-w-3xl' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>
            {view === 'list' ? 'Letter voice' : view === 'learn' ? 'Learn the voice from past letters' : `Edit "${editing?.name}"`}
          </DialogTitle>
          <DialogDescription>
            {view === 'list' && "Letters follow the fund's structure and voice, with its examples and house rules. These stay in your fund's data. Without them, the general outline and voice apply."}
            {view === 'learn' && 'Upload past letters or memos. The AI describes how they are laid out and how the partners write, and writes examples with invented companies and figures. You review it before it is used.'}
            {view === 'edit' && 'Every letter written in this voice follows these, whether it is drafted here or by an assistant.'}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-card border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

        {view === 'list' && (
          <div className="space-y-4">
            {templates.length > 0 && (
              <div className="space-y-2">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center justify-between gap-3 rounded-card border p-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{t.name}</span>
                        {t.is_default && <Badge variant="secondary">Fund voice</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {origin(t)}{t.house_rules ? ' · house rules' : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!t.is_default && (
                        <Button size="sm" variant="ghost" onClick={() => chooseAsVoice(t)} disabled={!!busy}>
                          {busy === `use:${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Use as fund voice'}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => edit(t)} aria-label={`Edit ${t.name}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <button
                        onClick={() => remove(t)}
                        className="p-1 text-muted-foreground/50 hover:text-destructive"
                        aria-label={`Delete ${t.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button size="sm" onClick={() => { setError(null); setView('learn') }}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Learn from past letters
              </Button>
              <Button size="sm" variant="outline" onClick={chooseGeneral} disabled={!!busy}>
                {busy === 'default' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Use the general voice
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <a href="/api/lp-letters/example" download className="underline hover:text-foreground">See an example letter</a> in the general voice.
            </p>
          </div>
        )}

        {view === 'learn' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="voice-name">Name</Label>
              <Input id="voice-name" value={learnName} onChange={e => setLearnName(e.target.value)} placeholder="House voice" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="voice-files">Letters or memos (.docx or .pdf, up to {MAX_DOCUMENTS})</Label>
              <Input
                id="voice-files"
                type="file"
                multiple
                accept=".docx,.pdf"
                onChange={e => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_DOCUMENTS))}
              />
              {files.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {files.length} {files.length === 1 ? 'document' : 'documents'}: {files.map(f => f.name).join(', ')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Several letters from different quarters work best: the voice notes what stays the same and what varies.
              </p>
            </div>
            <div className="flex justify-between gap-3">
              <Button size="sm" variant="outline" onClick={() => setView('list')} disabled={busy === 'learn'}>Back</Button>
              <Button size="sm" onClick={learn} disabled={!files.length || !!busy}>
                {busy === 'learn' ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Reading the letters, this takes a minute or two</> : 'Learn the voice'}
              </Button>
            </div>
          </div>
        )}

        {view === 'edit' && editing && (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            {(reused.length > 0 || unread.length > 0) && (
              <div className="space-y-1 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm">
                {reused.length > 0 && (
                  <p className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>
                      The examples should only use invented names and figures, but these also appear in your letters. Replace them
                      before using this voice: {reused.join(', ')}.
                    </span>
                  </p>
                )}
                {unread.length > 0 && <p className="text-muted-foreground">No text could be read from: {unread.join(', ')}.</p>}
              </div>
            )}
            {!editing.is_default && editing.source_type !== 'default' && (
              <p className="text-xs text-muted-foreground">
                This is a draft. Letters use it only once you choose it as the fund voice.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-structure">Structure</Label>
              <p className="text-xs text-muted-foreground">The letter's sections in order, their headings, the paragraphs repeated every quarter, and the tables. Leave it empty to use the general outline.</p>
              <Textarea id="edit-structure" rows={10} value={structure} onChange={e => setStructure(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-voice">Voice</Label>
              <p className="text-xs text-muted-foreground">How the partners write: who speaks, sentence habits, each part of a letter, what to avoid.</p>
              <Textarea id="edit-voice" rows={12} value={voice} onChange={e => setVoice(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-examples">Examples</Label>
              <p className="text-xs text-muted-foreground">Each section written in full. Use invented companies and figures only: writers copy the shape, never the facts.</p>
              <Textarea id="edit-examples" rows={12} value={examples} onChange={e => setExamples(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-rules">House rules</Label>
              <p className="text-xs text-muted-foreground">Standing instructions for every letter. They win over the voice and examples.</p>
              <Textarea
                id="edit-rules"
                rows={5}
                value={houseRules}
                onChange={e => setHouseRules(e.target.value)}
                placeholder={'Always state ARR to one decimal, e.g. $1.2M.\nSign every letter from both managing partners.\nNever mention a company\'s next round before it closes.'}
              />
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <Button size="sm" variant="outline" onClick={() => { setView('list'); setReused([]); setUnread([]) }} disabled={!!busy}>Cancel</Button>
              <div className="flex gap-3">
                <Button size="sm" variant="outline" onClick={() => save(false)} disabled={!!busy || !name.trim()}>
                  {busy === 'save' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Save
                </Button>
                {!editing.is_default && (
                  <Button size="sm" onClick={() => save(true)} disabled={!!busy || !name.trim()}>
                    {busy === 'use' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                    Save and use as fund voice
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
