'use client'

import { use, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, Loader2, MessageSquare, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { useAnalystContext } from '@/components/analyst-context'

// An entity's governing documents: LPA, operating agreement, side letters, amendments. For anyone on
// the entity's team — the APIs check the entity, not a domain grant — so this is a client page that
// renders nothing on the server. See plans/spec-entity-documents.md.

const KINDS = [
  { value: 'lpa', label: 'LPA' },
  { value: 'operating_agreement', label: 'Operating agreement' },
  { value: 'side_letter', label: 'Side letter' },
  { value: 'amendment', label: 'Amendment' },
  { value: 'other', label: 'Other' },
] as const
const kindLabel = (k: string) => KINDS.find(x => x.value === k)?.label ?? k

interface Entity { id: string; name: string; kind: string }
interface Doc {
  id: string
  kind: string
  title: string
  effective_date: string | null
  file_name: string
  size_bytes: number | null
  page_count: number | null
  extraction_status: string
  ocr_status: string
  warnings: string[]
}
interface Staged { file: File; kind: string; title: string; effectiveDate: string; error?: string; done?: boolean }

/** A first guess at the kind from the file name; the uploader can change it. */
function guessKind(name: string): string {
  const n = name.toLowerCase()
  if (/side[\s_-]*letter/.test(n)) return 'side_letter'
  if (/amend/.test(n)) return 'amendment'
  if (/operating[\s_-]*agreement|\bllc agreement\b/.test(n)) return 'operating_agreement'
  if (/\blpa\b|limited partnership agreement|partnership agreement/.test(n)) return 'lpa'
  return 'other'
}

function status(d: Doc): { text: string; tone: string } {
  if (d.ocr_status === 'pending') return { text: 'Reading scanned pages…', tone: 'text-muted-foreground' }
  if (d.extraction_status === 'complete') return { text: 'Readable', tone: 'text-success' }
  if (d.extraction_status === 'partial') return { text: 'Partly readable', tone: 'text-warning' }
  if (d.ocr_status === 'failed' || d.extraction_status === 'failed') return { text: 'Couldn’t read', tone: 'text-destructive' }
  return { text: 'No text', tone: 'text-muted-foreground' }
}

export default function EntityDocumentsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params)
  const [entity, setEntity] = useState<Entity | null | undefined>(undefined)
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [staged, setStaged] = useState<Staged[]>([])
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { setVehicle, ask } = useAnalystContext()

  useEffect(() => {
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Entity[]) => setEntity((rows ?? []).find(e => e.id === id) ?? null))
      .catch(() => setEntity(null))
  }, [id])

  // Scope the Analyst to this entity while the page is open: it gets the document index (and the
  // books, for those who can see them).
  useEffect(() => {
    if (entity) setVehicle(entity.name)
    return () => setVehicle(null)
  }, [entity, setVehicle])

  const load = useCallback(async () => {
    const res = await fetch(`/api/entities/${id}/documents`)
    setDocs(res.ok ? await res.json() : [])
  }, [id])
  useEffect(() => { load() }, [load])

  // While a scan is being read, check back now and then.
  useEffect(() => {
    if (!docs?.some(d => d.ocr_status === 'pending')) return
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [docs, load])

  function choose(files: FileList | null) {
    if (!files) return
    setStaged(prev => [...prev, ...Array.from(files).map(f => ({
      file: f, kind: guessKind(f.name), title: f.name.replace(/\.[^.]+$/, ''), effectiveDate: '',
    }))])
    if (fileRef.current) fileRef.current.value = ''
  }

  async function uploadAll() {
    setUploading(true)
    setError(null)
    const supabase = createClient()
    const next = [...staged]
    for (let i = 0; i < next.length; i++) {
      const s = next[i]
      if (s.done) continue
      try {
        const urlRes = await fetch(`/api/entities/${id}/documents/upload-url`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_name: s.file.name, size_bytes: s.file.size }),
        })
        const urlBody = await urlRes.json().catch(() => ({}))
        if (!urlRes.ok) throw new Error(urlBody.error ?? 'Could not start the upload')
        const { error: upErr } = await supabase.storage.from('entity-documents')
          .uploadToSignedUrl(urlBody.storage_path, urlBody.token, s.file, { contentType: s.file.type || 'application/octet-stream' })
        if (upErr) throw new Error(upErr.message)
        const res = await fetch(`/api/entities/${id}/documents`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storage_path: urlBody.storage_path, file_name: s.file.name, content_type: s.file.type || null,
            kind: s.kind, title: s.title, effective_date: s.effectiveDate || null,
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? 'Upload failed')
        next[i] = { ...s, done: true, error: undefined }
      } catch (e) {
        next[i] = { ...s, error: (e as Error).message }
      }
      setStaged([...next])
    }
    setStaged(next.filter(s => !s.done))
    setUploading(false)
    load()
  }

  async function save(doc: Doc, patch: Partial<{ kind: string; title: string; effective_date: string | null }>) {
    const res = await fetch(`/api/entities/${id}/documents/${doc.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Could not save')
    setEditing(null)
    load()
  }

  async function remove(doc: Doc) {
    const res = await fetch(`/api/entities/${id}/documents/${doc.id}`, { method: 'DELETE' })
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Could not delete')
    setConfirmDelete(null)
    load()
  }

  if (entity === null) {
    return <div className="p-4 md:p-8 text-sm text-muted-foreground">This entity isn&apos;t available — it may not exist, or it isn&apos;t shared with you.</div>
  }

  const hasLpa = !!docs?.some(d => d.kind === 'lpa' || d.kind === 'operating_agreement')

  return (
    <div className="p-4 md:py-8 md:px-8 max-w-page w-full space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{entity ? `${entity.name} — documents` : 'Documents'}</h1>
          <p className="text-sm text-muted-foreground">
            The LPA or operating agreement, side letters and amendments. Everyone on this entity&apos;s team can read them,
            and the Analyst can answer questions about their terms.
          </p>
          {entity && <Link href={`/portfolio?entity=${entity.id}`} className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">Holdings</Link>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!docs?.length} onClick={() => ask('')}>
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />Ask about these documents
          </Button>
          <Button size="sm" disabled={!hasLpa} onClick={() => ask(`Review ${entity?.name ?? 'this entity'}'s financials for compliance with its LPA, including any side letters and amendments. List each key term with its clause, compare it with the books, and flag anything that looks inconsistent or that you can't verify.`)}
            title={hasLpa ? undefined : 'Upload the LPA or operating agreement first'}>
            Review compliance with the LPA
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="border rounded-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Add documents</p>
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg" className="hidden" onChange={e => choose(e.target.files)} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />Choose files
          </Button>
        </div>
        {staged.length === 0 ? (
          <p className="text-xs text-muted-foreground">PDF, Word or text, up to 25 MB each. Scanned PDFs are read automatically (a few minutes for a long document).</p>
        ) : (
          <div className="space-y-2">
            {staged.map((s, i) => (
              <div key={`${s.file.name}-${i}`} className="grid gap-2 md:grid-cols-[1fr_11rem_10rem_auto] items-center">
                <Input value={s.title} aria-label="Title" onChange={e => setStaged(p => p.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <select aria-label="Type" value={s.kind} onChange={e => setStaged(p => p.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
                  className="rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm">
                  {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <Input type="date" aria-label="Effective date" value={s.effectiveDate} onChange={e => setStaged(p => p.map((x, j) => (j === i ? { ...x, effectiveDate: e.target.value } : x)))} />
                <button type="button" aria-label="Remove" className="text-muted-foreground hover:text-foreground" disabled={uploading}
                  onClick={() => setStaged(p => p.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button>
                <p className="text-xs text-muted-foreground md:col-span-4 -mt-1">
                  {s.file.name}{s.error && <span className="text-sm text-destructive"> — {s.error}</span>}
                </p>
              </div>
            ))}
            <Button size="sm" onClick={uploadAll} disabled={uploading}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Upload ${staged.length} file${staged.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        )}
      </div>

      <div className="border rounded-card overflow-x-auto">
        {docs === null ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
        ) : docs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No documents yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="text-left font-medium px-3 py-2">Document</th>
                <th className="text-left font-medium px-3 py-2">Type</th>
                <th className="text-left font-medium px-3 py-2">Effective</th>
                <th className="text-right font-medium px-3 py-2">Pages</th>
                <th className="text-left font-medium px-3 py-2">Text</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {docs.map(d => {
                const st = status(d)
                return editing === d.id ? (
                  <EditRow key={d.id} doc={d} onSave={patch => save(d, patch)} onCancel={() => setEditing(null)} />
                ) : (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <a href={`/api/entities/${id}/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 hover:underline">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />{d.title}
                      </a>
                    </td>
                    <td className="px-3 py-2">{kindLabel(d.kind)}</td>
                    <td className="px-3 py-2 tabular-nums">{d.effective_date ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.page_count ?? '—'}</td>
                    <td className={`px-3 py-2 ${st.tone}`} title={d.warnings.join('\n') || undefined}>{st.text}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {confirmDelete === d.id ? (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => remove(d)}>Delete</Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setConfirmDelete(null)}>Keep</Button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(d.id)}>Edit</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDelete(d.id)} aria-label="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function EditRow({ doc, onSave, onCancel }: {
  doc: Doc
  onSave: (patch: { kind: string; title: string; effective_date: string | null }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(doc.title)
  const [kind, setKind] = useState(doc.kind)
  const [date, setDate] = useState(doc.effective_date ?? '')
  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2"><Input value={title} aria-label="Title" onChange={e => setTitle(e.target.value)} /></td>
      <td className="px-3 py-2">
        <select aria-label="Type" value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm">
          {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </td>
      <td className="px-3 py-2"><Input type="date" aria-label="Effective date" value={date} onChange={e => setDate(e.target.value)} /></td>
      <td colSpan={2} />
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <span className="inline-flex gap-1">
          <Button size="sm" className="h-7 text-xs" onClick={() => onSave({ title, kind, effective_date: date || null })}>Save</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
        </span>
      </td>
    </tr>
  )
}
