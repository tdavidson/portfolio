'use client'

// The administrator's package as documents: pick the vehicle's uploaded documents (the entity's
// Documents page holds them), or upload the package here, which files it there too. The review then
// reads the figures out of them (lib/statement-review/extract.ts).

import { useCallback, useEffect, useState } from 'react'
import { FileText, Loader2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface Doc {
  id: string; title: string; file_name: string; page_count: number | null
  extraction_status: string; ocr_status: string; created_at: string
}

export function DocumentsPicker({ vehicleId, selected, onChange }: {
  vehicleId: string
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/entities/${vehicleId}/documents`)
    const d = await res.json().catch(() => [])
    setDocs(res.ok && Array.isArray(d) ? d : [])
  }, [vehicleId])
  useEffect(() => { load() }, [load])

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    const supabase = createClient()
    const added: string[] = []
    try {
      for (const file of Array.from(files)) {
        const urlRes = await fetch(`/api/entities/${vehicleId}/documents/upload-url`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_name: file.name, size_bytes: file.size }),
        })
        const urlBody = await urlRes.json().catch(() => ({}))
        if (!urlRes.ok) throw new Error(urlBody.error ?? `Could not start uploading ${file.name}`)
        const { error: upErr } = await supabase.storage.from('entity-documents')
          .uploadToSignedUrl(urlBody.storage_path, urlBody.token, file, { contentType: file.type || 'application/octet-stream' })
        if (upErr) throw new Error(upErr.message)
        const res = await fetch(`/api/entities/${vehicleId}/documents`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storage_path: urlBody.storage_path, file_name: file.name, content_type: file.type || null, kind: 'other', title: file.name }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? `Could not upload ${file.name}`)
        added.push(body.id)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
      if (added.length) onChange([...selected, ...added])
      load()
    }
  }

  if (docs === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  return (
    <div className="space-y-2 w-full">
      {docs.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border divide-y text-sm">
          {docs.map(d => {
            const pending = d.ocr_status === 'pending'
            return (
              <li key={d.id}>
                <label className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-muted/50">
                  <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{d.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
                    {pending ? 'Still being read' : d.page_count ? `${d.page_count} pages` : ''} · {d.created_at.slice(0, 10)}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <label className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-input px-3 text-sm">
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {uploading ? 'Uploading…' : 'Upload the package'}
        <input type="file" multiple accept=".pdf,.xlsx,.xls,.csv,.docx,application/pdf" className="sr-only" disabled={uploading}
          onChange={e => { upload(e.target.files); e.target.value = '' }} />
      </label>
      <p className="text-xs text-muted-foreground">
        PDFs and spreadsheets are filed on the entity&apos;s Documents page. Scanned pages are read in the background, which
        can take a few minutes.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
