'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronDown, ChevronRight, Download, ExternalLink, FileText, Loader2, ScanText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { TimelineArtifact, TimelineUpdate } from '@/lib/company-updates/search'

/**
 * The company's reporting timeline. Metadata and previews arrive with the list; the full body and
 * each attachment's extracted text load only when opened. Every partial or failed extraction is
 * visible where the reader will look for the content, with a route back to the source email and
 * the original file.
 */
interface Props {
  companyId: string
}

type UpdateDetail = TimelineUpdate & { body_original: string | null; body_current: string | null; source_email_url: string }
type ArtifactDetail = TimelineArtifact & { extracted_text: string; chunks: Array<{ ordinal: number; locator: Record<string, unknown>; chars: number }> }

const STATUS_LABEL: Record<string, string> = {
  complete: 'Complete',
  partial: 'Partial',
  failed: 'Failed',
  not_applicable: 'No text',
}

function StatusBadge({ status }: { status: string }) {
  const className =
    status === 'complete' ? 'bg-success-subtle text-success border-transparent'
    : status === 'partial' ? 'bg-warning-subtle text-warning border-transparent'
    : status === 'failed' ? 'bg-destructive-subtle text-destructive border-transparent'
    : 'bg-muted text-muted-foreground border-transparent'
  return <Badge variant="outline" className={className}>{STATUS_LABEL[status] ?? status}</Badge>
}

function OcrBadge({ status }: { status: string }) {
  if (status === 'not_needed') return null
  const label = status === 'pending' ? 'OCR queued' : status === 'running' ? 'OCR running' : status === 'complete' ? 'OCR' : 'OCR failed'
  const className = status === 'failed' ? 'bg-destructive-subtle text-destructive border-transparent' : 'bg-info-subtle text-info border-transparent'
  return <Badge variant="outline" className={className}><ScanText className="h-3 w-3 mr-1" />{label}</Badge>
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function senderLine(update: TimelineUpdate) {
  const envelope = update.sender_name ? `${update.sender_name} <${update.sender_email}>` : update.sender_email
  if (update.forwarded_sender_email) {
    const forwarded = update.forwarded_sender_name ? `${update.forwarded_sender_name} <${update.forwarded_sender_email}>` : update.forwarded_sender_email
    return `${forwarded} · forwarded by ${envelope}`
  }
  return envelope ?? ''
}

export function CompanyUpdates({ companyId }: Props) {
  const [updates, setUpdates] = useState<TimelineUpdate[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, UpdateDetail>>({})
  const [artifactText, setArtifactText] = useState<Record<string, ArtifactDetail>>({})
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (after: string | null) => {
    const params = new URLSearchParams({ limit: '10' })
    if (after) params.set('cursor', after)
    const res = await fetch(`/api/companies/${companyId}/updates?${params}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Failed to load updates')
    return data as { updates: TimelineUpdate[]; next_cursor: string | null }
  }, [companyId])

  useEffect(() => {
    let cancelled = false
    load(null)
      .then(page => { if (!cancelled) { setUpdates(page.updates); setCursor(page.next_cursor) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load updates') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await load(cursor)
      setUpdates(prev => [...prev, ...page.updates])
      setCursor(page.next_cursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load updates')
    } finally {
      setLoadingMore(false)
    }
  }

  async function toggleUpdate(update: TimelineUpdate) {
    if (openId === update.id) { setOpenId(null); return }
    setOpenId(update.id)
    if (details[update.id]) return
    setBusy(update.id)
    try {
      const res = await fetch(`/api/company-updates/${update.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load update')
      setDetails(prev => ({ ...prev, [update.id]: data }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load update')
    } finally {
      setBusy(null)
    }
  }

  async function showArtifactText(update: TimelineUpdate, artifact: TimelineArtifact) {
    if (artifactText[artifact.id]) {
      setArtifactText(prev => { const next = { ...prev }; delete next[artifact.id]; return next })
      return
    }
    setBusy(artifact.id)
    try {
      const res = await fetch(`/api/company-updates/${update.id}/artifacts/${artifact.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load attachment text')
      setArtifactText(prev => ({ ...prev, [artifact.id]: data }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load attachment text')
    } finally {
      setBusy(null)
    }
  }

  // Nothing captured, nothing to show: the section appears once a company has an update.
  if (loading || updates.length === 0) return null

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1.5 mb-2 text-base font-medium text-foreground hover:text-foreground/80"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>Updates</span>
        <span className="text-xs font-normal text-muted-foreground tabular-nums">({updates.length}{cursor ? '+' : ''})</span>
      </button>

      {error && (
        <div className="mb-2 rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {expanded && (
        <div className="rounded-card border bg-card shadow-sm dark:shadow-none divide-y">
          {updates.map(update => {
            const open = openId === update.id
            const detail = details[update.id]
            return (
              <div key={update.id}>
                <button
                  type="button"
                  onClick={() => toggleUpdate(update)}
                  className="w-full text-left px-3 py-2.5 hover:bg-accent/50 flex items-start gap-3"
                >
                  {open ? <ChevronDown className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{update.subject || '(no subject)'}</span>
                      {update.period_label && (
                        <Badge variant="outline" title={update.period_source === 'manual' ? 'Period set manually' : 'Period from the metric extraction'}>
                          {update.period_label}
                        </Badge>
                      )}
                      <StatusBadge status={update.extraction_status} />
                      {update.artifacts.some(a => a.ocr_status === 'pending' || a.ocr_status === 'running') && <OcrBadge status="pending" />}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {formatDate(update.received_at)} · {senderLine(update)}
                      {update.artifacts.length > 0 && ` · ${update.artifacts.length} attachment${update.artifacts.length === 1 ? '' : 's'}`}
                    </div>
                    {!open && update.body_preview && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{update.body_preview}</p>
                    )}
                  </div>
                </button>

                {open && (
                  <div className="px-3 pb-3 pl-10 space-y-3">
                    {update.warnings.length > 0 && (
                      <div className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning">
                        <div className="flex items-center gap-1.5 font-medium mb-1"><AlertTriangle className="h-3.5 w-3.5" />Extraction was not complete</div>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {update.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-xs">
                      <Link href={`/emails/${update.source_email_id}`} className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-400 hover:underline">
                        <ExternalLink className="h-3 w-3" />Open source email
                      </Link>
                      {update.body_cleaning_status === 'uncertain' && (
                        <span className="text-muted-foreground">Quoted history could not be separated; the full body is shown.</span>
                      )}
                    </div>

                    {busy === update.id && !detail && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    {detail && (
                      <BodyView detail={detail} />
                    )}

                    {update.artifacts.length > 0 && (
                      <div className="space-y-1.5">
                        <h4 className="text-base font-medium text-muted-foreground">Attachments</h4>
                        {update.artifacts.map(artifact => (
                          <div key={artifact.id} className="rounded-lg border px-3 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium truncate">{artifact.filename}</span>
                              <span className="text-xs text-muted-foreground">{formatBytes(artifact.byte_size)}</span>
                              <StatusBadge status={artifact.extraction_status} />
                              <OcrBadge status={artifact.ocr_status} />
                              <span className="ml-auto flex items-center gap-1">
                                {artifact.has_source_file && canInline(artifact) && (
                                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewId(previewId === artifact.id ? null : artifact.id)}>
                                    {previewId === artifact.id ? 'Hide preview' : 'Preview'}
                                  </Button>
                                )}
                                {artifact.has_text && (
                                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => showArtifactText(update, artifact)} disabled={busy === artifact.id}>
                                    {busy === artifact.id ? <Loader2 className="h-3 w-3 animate-spin" /> : artifactText[artifact.id] ? 'Hide text' : 'Show text'}
                                  </Button>
                                )}
                                {artifact.has_source_file && (
                                  <a
                                    href={`/api/company-updates/${update.id}/artifacts/${artifact.id}?download=1`}
                                    className="p-1.5 text-muted-foreground hover:text-foreground"
                                    title="Download original file"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </a>
                                )}
                              </span>
                            </div>
                            {(artifact.warnings.length > 0 || artifact.ocr_error) && (
                              <ul className="mt-1 text-sm text-warning list-disc pl-5 space-y-0.5">
                                {artifact.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                                {artifact.ocr_error && <li>OCR: {artifact.ocr_error}</li>}
                              </ul>
                            )}
                            {artifact.detected_content_type && artifact.declared_content_type && artifact.detected_content_type !== artifact.declared_content_type && (
                              <p className="mt-1 text-xs text-muted-foreground">Declared {artifact.declared_content_type}, detected {artifact.detected_content_type}.</p>
                            )}
                            {previewId === artifact.id && (
                              contentTypeOf(artifact).startsWith('image/')
                                ? <img src={`/api/company-updates/${update.id}/artifacts/${artifact.id}?download=1&disposition=inline`} alt={artifact.filename} className="mt-2 max-h-[32rem] max-w-full mx-auto rounded" />
                                : <iframe src={`/api/company-updates/${update.id}/artifacts/${artifact.id}?download=1&disposition=inline`} title={artifact.filename} className="mt-2 w-full h-[32rem] rounded bg-white" />
                            )}
                            {artifactText[artifact.id] && (
                              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-foreground">
                                {artifactText[artifact.id].extracted_text || '(no extracted text)'}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {expanded && cursor && (
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Load older updates
          </Button>
        </div>
      )}
    </div>
  )
}

function contentTypeOf(artifact: TimelineArtifact): string {
  return artifact.detected_content_type ?? artifact.declared_content_type ?? ''
}

/** Same allowlist the download route enforces for inline disposition. */
function canInline(artifact: TimelineArtifact): boolean {
  const type = contentTypeOf(artifact)
  return type === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(type)
}

function BodyView({ detail }: { detail: UpdateDetail }) {
  const [showOriginal, setShowOriginal] = useState(false)
  const hasQuoted = (detail.body_original ?? '').length > (detail.body_current ?? '').length
  const text = showOriginal ? detail.body_original : detail.body_current
  return (
    <div>
      <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground max-h-[32rem] overflow-auto">{text || '(no body text)'}</pre>
      {hasQuoted && (
        <button type="button" onClick={() => setShowOriginal(v => !v)} className="mt-1 text-xs text-muted-foreground hover:text-foreground">
          {showOriginal ? 'Show current message only' : 'Show full original including quoted history'}
        </button>
      )}
    </div>
  )
}
