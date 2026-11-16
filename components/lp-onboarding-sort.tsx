'use client'

import { useCallback, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, FolderInput, Check, Trash2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { DOCUMENT_KINDS, ONBOARDING_KIND_LABEL, type OnboardingKind } from '@/lib/lp-onboarding'
import { TAX_FORM_LABEL, type TaxFormType } from '@/lib/tax/forms'
import { TaxFormFields, taxFieldsFromFacts, taxFieldsToBody, EMPTY_TAX_FIELDS, type TaxFormFieldsValue } from '@/components/lp-tax-form-fields'

interface Entity { id: string; name: string; investorName: string }
interface Proposal {
  kind: OnboardingKind | null
  kindConfidence: 'high' | 'medium' | 'low' | null
  kindMatchedOn: string[]
  taxFormType: TaxFormType | null
  entityId: string | null
  entityConfidence: 'high' | 'medium' | 'low' | null
  entityMatchedOn: string | null
  alternatives: { entityId: string; score: number }[]
  facts: { nameCandidates: string[]; dateCandidates: string[]; statedCommitment: number | null; tin: { type: string | null; last4: string } | null; country: string | null }
  commitmentOnFile: number | null
  commitmentMismatch: boolean
  unreadable: string | null
}
interface Row {
  storage_path: string
  file_name: string
  mime_type: string | null
  size_bytes: number
  source?: string
  note?: string | null
  proposal: Proposal | null
  error?: string
  // The reviewer's decision, seeded from the proposal.
  entityId: string
  kind: OnboardingKind | ''
  docDate: string
  discard: boolean
  tax: TaxFormFieldsValue
}

type Stage = 'idle' | 'uploading' | 'sorting' | 'review' | 'filing' | 'done'

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currencySign: 'accounting', currency: 'USD', maximumFractionDigits: 0 }).format(v)

function Conf({ level }: { level: 'high' | 'medium' | 'low' | null }) {
  if (!level) return <span className="rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground">unmatched</span>
  const tone = level === 'high' ? 'bg-success-subtle text-success' : level === 'medium' ? 'bg-warning-subtle text-foreground' : 'bg-muted text-muted-foreground'
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{level}</span>
}

/**
 * Sort a batch: upload a folder of executed documents, let the server read and propose what
 * each is and whose it is, review the proposals, confirm. Everything is proposed, nothing is
 * filed until the reviewer says so, and a discarded upload is deleted.
 */
export function LpOnboardingSort({ onFiled }: { onFiled: () => void }) {
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [rows, setRows] = useState<Row[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [canRecordTax, setCanRecordTax] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const start = useCallback(async (list: FileList | File[]) => {
    const files = Array.from(list).filter(f => f.size > 0)
    if (files.length === 0) return
    if (files.length > 60) { setError('Sort at most 60 files at a time.'); return }
    setError(null); setResult(null); setStage('uploading')
    const uploaded: Omit<Row, 'proposal' | 'entityId' | 'kind' | 'docDate' | 'discard' | 'tax'>[] = []
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        setProgress(`Uploading ${i + 1} of ${files.length}: ${f.name}`)
        const u = await fetch('/api/lps/documents/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: f.name }) })
        if (!u.ok) throw new Error(`Could not start the upload for ${f.name}`)
        const { storage_path, token } = await u.json()
        const { error: upErr } = await supabase.storage.from('lp-documents').uploadToSignedUrl(storage_path, token, f)
        if (upErr) throw new Error(`${f.name}: ${upErr.message}`)
        uploaded.push({ storage_path, file_name: f.name, mime_type: f.type || null, size_bytes: f.size })
      }
      // Read in chunks: OCR on a scan can take most of a minute, and a server request has a window.
      setStage('sorting')
      const CHUNK = 6
      const allFiles: any[] = []
      let b: any = null
      for (let i = 0; i < uploaded.length; i += CHUNK) {
        const chunk = uploaded.slice(i, i + CHUNK)
        setProgress(`Reading ${Math.min(i + CHUNK, uploaded.length)} of ${uploaded.length} on the server…`)
        const res = await fetch('/api/lps/onboarding/sort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: chunk }) })
        b = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(b.error ?? 'Sorting failed')
        allFiles.push(...(b.files ?? []))
      }
      setEntities(b?.entities ?? [])
      setCanRecordTax(!!b?.canRecordTax)
      setRows(allFiles.map(f => {
        const facts = f.proposal?.facts
        const signed = facts?.dateCandidates?.[0] ?? ''
        return {
          ...f,
          entityId: f.proposal?.entityId ?? '',
          kind: f.proposal?.kind ?? '',
          docDate: signed,
          discard: false,
          tax: f.proposal?.kind === 'tax_form'
            ? taxFieldsFromFacts({ formType: f.proposal?.taxFormType, legalName: facts?.nameCandidates?.[0], tinType: facts?.tin?.type, tinLast4: facts?.tin?.last4, country: facts?.country, signedDate: signed })
            : EMPTY_TAX_FIELDS,
        }
      }))
      setStage('review')
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
      setStage(uploaded.length ? 'review' : 'idle')
      if (uploaded.length) setRows(uploaded.map(f => ({ ...f, proposal: null, entityId: '', kind: '', docDate: '', discard: false, tax: EMPTY_TAX_FIELDS })))
    } finally {
      setProgress(null)
    }
  }, [supabase])

  function update(i: number, patch: Partial<Row>) {
    setRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  const ready = rows.filter(r => !r.discard && r.entityId && r.kind)
  const incomplete = rows.filter(r => !r.discard && (!r.entityId || !r.kind))

  async function confirm() {
    if (incomplete.length) { setError(`${incomplete.length} file${incomplete.length === 1 ? ' needs' : 's need'} an entity and a kind, or discard ${incomplete.length === 1 ? 'it' : 'them'}.`); return }
    setStage('filing'); setError(null)
    const res = await fetch('/api/lps/onboarding/sort/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: ready.map(r => ({
          storage_path: r.storage_path, file_name: r.file_name, mime_type: r.mime_type, size_bytes: r.size_bytes,
          lp_entity_id: r.entityId, kind: r.kind, doc_date: r.docDate || null,
          tax: r.kind === 'tax_form' && canRecordTax ? taxFieldsToBody(r.tax) : null,
        })),
        discard: rows.filter(r => r.discard).map(r => r.storage_path),
      }),
    })
    const b = await res.json().catch(() => ({}))
    if (!res.ok) { setError(b.error ?? 'Could not file the documents'); setStage('review'); return }
    setResult(`Filed ${b.filed?.length ?? 0} document${b.filed?.length === 1 ? '' : 's'} as verified${b.taxRecorded ? `, recorded ${b.taxRecorded} tax form${b.taxRecorded === 1 ? '' : 's'}` : ''}${b.discarded ? `, discarded ${b.discarded}` : ''}.${b.taxSkipped?.length ? ` Tax facts for ${b.taxSkipped.join(', ')} were not recorded — that needs tax-reporting access.` : ''}`)
    setRows([]); setStage('done')
    onFiled()
  }

  async function discardAll() {
    setStage('filing')
    await fetch('/api/lps/onboarding/sort/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [], discard: rows.map(r => r.storage_path) }) }).catch(() => {})
    setRows([]); setStage('idle'); setResult(null)
  }

  const entityLabel = (id: string) => { const e = entities.find(x => x.id === id); return e ? (e.investorName && e.investorName !== e.name ? `${e.name} (${e.investorName})` : e.name) : id }

  return (
    <div className="rounded-md border bg-card">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/40 transition-colors">
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <FolderInput className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-sm">Sort a batch</span>
        <span className="text-xs text-muted-foreground ml-1">drop a folder of executed documents; the platform proposes what each is and whose</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t pt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Each file is read on this server — PDF or Word text, OCR for a photo or scan — and matched to your entities by name. No model is called and the text is not kept.
            Guesses it isn&apos;t sure of are left blank. Nothing is filed until you confirm.
          </p>
          {error && <div className="text-sm text-destructive">{error}</div>}
          {result && <div className="text-sm text-success">{result}</div>}

          {(stage === 'idle' || stage === 'done') && (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); void start(e.dataTransfer.files) }}
              className={`rounded-card border-2 border-dashed p-6 text-center text-sm ${dragging ? 'border-primary bg-primary/5' : 'border-input text-muted-foreground'}`}
            >
              Drop PDFs, Word files or photos here, or{' '}
              <button type="button" className="underline text-foreground" onClick={() => inputRef.current?.click()}>choose files</button>.
              <input ref={inputRef} type="file" multiple className="sr-only" accept=".pdf,.docx,.jpg,.jpeg,.png,.heic,.webp,.tif,.tiff"
                onChange={e => { if (e.target.files) void start(e.target.files); e.target.value = '' }} />
            </div>
          )}

          {(stage === 'uploading' || stage === 'sorting') && (
            <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-1" /> {progress ?? 'Working…'}</div>
          )}

          {(stage === 'review' || stage === 'filing') && rows.length > 0 && (
            <div className="space-y-2">
              <div className="rounded-md border divide-y">
                {rows.map((r, i) => {
                  const p = r.proposal
                  return (
                    <div key={r.storage_path} className={`px-3 py-2 text-xs space-y-1.5 ${r.discard ? 'opacity-50' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm truncate max-w-[40%]" title={r.file_name}>{r.file_name}</span>
                        {r.source === 'ocr' && <span className="rounded px-1.5 py-0.5 text-[10px] bg-info-subtle text-info">OCR</span>}
                        {p?.unreadable && <span className="inline-flex items-center gap-1 text-muted-foreground"><AlertTriangle className="h-3 w-3" /> {p.unreadable}</span>}
                        {r.error && <span className="text-destructive">{r.error}</span>}
                        {!p?.unreadable && r.note && <span className="text-muted-foreground">{r.note}</span>}
                        <span className="flex-1" />
                        <button type="button" onClick={() => update(i, { discard: !r.discard })} className={`inline-flex items-center gap-1 ${r.discard ? 'text-foreground' : 'text-muted-foreground hover:text-destructive'}`}>
                          <Trash2 className="h-3.5 w-3.5" /> {r.discard ? 'Keep' : 'Discard'}
                        </button>
                      </div>
                      {!r.discard && (
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="text-muted-foreground">Entity <Conf level={p?.entityConfidence ?? null} />
                            <select value={r.entityId} onChange={e => update(i, { entityId: e.target.value })} className="mt-1 block h-8 max-w-[280px] truncate rounded-md border border-input bg-background px-2 text-xs">
                              <option value="">Select…</option>
                              {entities.map(e => <option key={e.id} value={e.id}>{entityLabel(e.id)}</option>)}
                            </select>
                          </label>
                          <label className="text-muted-foreground">Kind <Conf level={p?.kindConfidence ?? null} />
                            <select value={r.kind} onChange={e => update(i, { kind: e.target.value as OnboardingKind | '' })} className="mt-1 block h-8 rounded-md border border-input bg-background px-2 text-xs">
                              <option value="">Select…</option>
                              {DOCUMENT_KINDS.map(k => <option key={k} value={k}>{ONBOARDING_KIND_LABEL[k]}</option>)}
                            </select>
                          </label>
                          <label className="text-muted-foreground">Signed
                            <Input type="date" value={r.docDate} onChange={e => update(i, { docDate: e.target.value })} className="mt-1 h-8 w-36 text-xs" />
                          </label>
                        </div>
                      )}
                      {!r.discard && p && (
                        <div className="text-muted-foreground space-x-2">
                          {p.entityMatchedOn && <span>Matched on “{p.entityMatchedOn}”.</span>}
                          {p.kindMatchedOn.length > 0 && <span>Kind from: {p.kindMatchedOn.slice(0, 3).join(', ')}.</span>}
                          {r.kind !== 'tax_form' && p.taxFormType && <span>Looks like {TAX_FORM_LABEL[p.taxFormType]}.</span>}
                          {p.facts.statedCommitment !== null && (
                            <span className={p.commitmentMismatch ? 'text-destructive' : ''}>
                              States {money(p.facts.statedCommitment)}{p.commitmentOnFile !== null ? ` · on file ${money(p.commitmentOnFile)}` : ''}{p.commitmentMismatch ? ' — disagrees' : ''}.
                            </span>
                          )}
                          {!p.entityId && p.alternatives.length > 0 && <span>Closest: {p.alternatives.map(al => entityLabel(al.entityId)).join(', ')}.</span>}
                          {!p.entityId && p.facts.nameCandidates.length > 0 && <span>Names found: {p.facts.nameCandidates.slice(0, 3).join('; ')}.</span>}
                        </div>
                      )}
                      {!r.discard && r.kind === 'tax_form' && (
                        <div className="rounded-md border bg-muted/20 p-2 space-y-1.5">
                          <div className="text-muted-foreground">
                            {canRecordTax
                              ? 'Tax form facts, as read from the form — confirming files the document and records the form for the K-1.'
                              : 'Tax form facts as read from the form. Recording them needs tax-reporting access; the document will still be filed.'}
                          </div>
                          <TaxFormFields value={r.tax} onChange={tax => update(i, { tax })} disabled={!canRecordTax} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={confirm} disabled={stage === 'filing' || ready.length === 0}>
                  {stage === 'filing' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                  File {ready.length} as verified{rows.some(r => r.discard) ? ` and discard ${rows.filter(r => r.discard).length}` : ''}
                </Button>
                <Button size="sm" variant="ghost" onClick={discardAll} disabled={stage === 'filing'}>Discard all</Button>
                {incomplete.length > 0 && <span className="text-xs text-muted-foreground">{incomplete.length} still need an entity or a kind.</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
