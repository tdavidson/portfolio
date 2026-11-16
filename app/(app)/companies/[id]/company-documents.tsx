'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { FileText, Trash2, Loader2, ChevronDown, ChevronRight, FileSpreadsheet, FileImage, File, Mail, ExternalLink, Download, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

const ACCEPTED_TYPES = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.jpg,.jpeg,.png'
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const TEXT_ONLY_THRESHOLD = 10 * 1024 * 1024 // 10 MB, files above this get text-only extraction

interface Document {
  id: string
  filename: string
  file_type: string
  file_size: number
  has_native_content?: boolean
  has_readable_content?: boolean
  created_at: string
  source: 'upload' | 'email' | 'email_body' | 'update_attachment'
  email_id?: string
  attachment_index?: number
  /** update_attachment: addressed by artifact id, never by filename or index. */
  artifact_id?: string
  update_id?: string
  extraction_status?: 'complete' | 'partial' | 'failed' | 'not_applicable'
  ocr_status?: string
  has_source_file?: boolean
  email_subject?: string
  email_from?: string
  /** Effective route of the source email; non-reporting mail is labelled so it is not mistaken for an update. */
  email_route?: string
  text_content?: string
}

interface DocumentDetail {
  text_content: string | null
  file_url: string | null
  previewable: boolean
}

interface Props {
  companyId: string
  fundId: string
  storageProvider?: string | null
  googleDriveFolderId?: string | null
  /**
   * Show email bodies/attachments here. False once the company has captured Company Updates —
   * the Updates section above then owns reporting mail, and this panel is uploads only.
   */
  includeEmailHistory?: boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** " · Deals" / " · Interactions" for mail that is not a reporting update. */
function routeLabel(doc: Document): string {
  if (!doc.email_route || doc.email_route === 'reporting') return ''
  return ` · ${doc.email_route.charAt(0).toUpperCase()}${doc.email_route.slice(1)}`
}

function FileIcon({ fileType, source }: { fileType: string; source: string }) {
  if (source === 'email' || source === 'email_body' || source === 'update_attachment') {
    return <Mail className="h-3.5 w-3.5 text-info shrink-0" />
  }
  if (fileType === 'application/pdf' || fileType.endsWith('.pdf')) {
    return <FileText className="h-3.5 w-3.5 text-destructive shrink-0" />
  }
  if (fileType.startsWith('image/')) {
    return <FileImage className="h-3.5 w-3.5 text-info shrink-0" />
  }
  if (fileType.includes('spreadsheet') || fileType.includes('excel') || fileType.includes('csv')) {
    return <FileSpreadsheet className="h-3.5 w-3.5 text-success shrink-0" />
  }
  return <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
}

export function CompanyDocuments({ companyId, fundId, storageProvider, googleDriveFolderId, includeEmailHistory = true }: Props) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [uploading, setUploading] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DocumentDetail>>({})
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/companies/${companyId}/documents${includeEmailHistory ? '' : '?emails=other'}`)
      if (res.ok) {
        const data = await res.json()
        setDocuments(data.documents)
      }
    } finally {
      setLoading(false)
    }
  }, [companyId, includeEmailHistory])

  useEffect(() => { load() }, [load])

  const title = includeEmailHistory ? 'Documents & activity' : 'Documents'

  async function toggleDocument(doc: Document) {
    if (openId === doc.id) {
      setOpenId(null)
      return
    }
    setOpenId(doc.id)
    if (doc.source !== 'upload' || details[doc.id] || !doc.has_readable_content) return

    setLoadingDetailId(doc.id)
    try {
      const res = await fetch(`/api/companies/${companyId}/documents/${doc.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load document')
      setDetails(prev => ({ ...prev, [doc.id]: data }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document')
    } finally {
      setLoadingDetailId(null)
    }
  }

  /** Upload straight to the company-documents bucket, then register it so text is extracted. */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_SIZE) {
      setError('File exceeds 20 MB limit')
      return
    }
    const isOversized = file.size > TEXT_ONLY_THRESHOLD
    setUploading(true)
    setError(null)
    setWarning(null)
    try {
      const supabase = createClient()
      const storagePath = `${fundId}/${companyId}/${crypto.randomUUID()}-${file.name}`
      const { error: uploadError } = await supabase.storage.from('company-documents').upload(storagePath, file)
      if (uploadError) {
        setError(`Upload failed: ${uploadError.message}`)
        return
      }
      const fileExt = file.name.split('.').pop()
      const res = await fetch(`/api/companies/${companyId}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storagePath,
          filename: file.name,
          fileType: file.type || `application/${fileExt}`,
          fileSize: file.size,
          ...(isOversized ? { textOnly: true } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to register document')
      } else {
        if (isOversized) setWarning('File exceeds 10 MB, only extracted text was stored.')
        setExpanded(true)
        await load()
      }
    } catch {
      setError('Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDelete(docId: string) {
    setDeletingId(docId)
    setError(null)

    try {
      const res = await fetch(`/api/companies/${companyId}/documents/${docId}`, {
        method: 'DELETE',
      })

      if (res.ok) {
        setDocuments(prev => prev.filter(d => d.id !== docId))
      } else {
        const data = await res.json()
        setError(data.error ?? 'Failed to delete document')
      }
    } catch {
      setError('Failed to delete document')
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-base font-medium">{title}</span>
        </div>
        <div className="animate-pulse space-y-2">
          <div className="h-8 bg-muted rounded w-full" />
          <div className="h-8 bg-muted rounded w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6">
      <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={handleUpload} className="hidden" />
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-base font-medium text-foreground hover:text-foreground/80"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {title}
          {documents.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">({documents.length})</span>
          )}
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Upload a document for this company"
          className="text-muted-foreground"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-2">{error}</p>
      )}
      {warning && (
        <p className="text-sm text-warning mb-2">{warning}</p>
      )}

      {expanded && documents.length > 0 && (
        <div className="space-y-2">
          {documents.map(doc => {
            const isOpen = openId === doc.id
            const detail = details[doc.id]
            const attachmentUrl = doc.source === 'update_attachment'
              ? (doc.has_source_file ? `/api/company-updates/${doc.update_id}/artifacts/${doc.artifact_id}?download=1` : null)
              : doc.email_id && doc.attachment_index !== undefined
                ? `/api/emails/${doc.email_id}/attachment/${doc.attachment_index}`
                : null
            const inlineUrl = attachmentUrl ? `${attachmentUrl}${attachmentUrl.includes('?') ? '&' : '?'}disposition=inline` : null
            const canInlineAttachment = doc.file_type === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(doc.file_type)
            return (
              <div key={doc.id} className="rounded-md border bg-card text-sm overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleDocument(doc)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <FileIcon fileType={doc.file_type} source={doc.source} />
                    <span className="truncate font-medium">{doc.filename}</span>
                    {doc.source === 'email_body' && <span className="text-xs text-muted-foreground shrink-0">Email{routeLabel(doc)}</span>}
                    {doc.source === 'email' && <span className="text-xs text-muted-foreground shrink-0">Attachment{routeLabel(doc)}</span>}
                    {doc.source === 'update_attachment' && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        Attachment
                        {doc.extraction_status === 'failed' && <span className="text-destructive"> · unreadable</span>}
                        {doc.extraction_status === 'partial' && <span className="text-warning"> · partly read</span>}
                        {(doc.ocr_status === 'pending' || doc.ocr_status === 'running') && <span className="text-info"> · OCR queued</span>}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(doc.file_size)}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(doc.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                  {doc.email_id && (
                    <a href={`/emails/${doc.email_id}`} className="p-1.5 text-muted-foreground hover:text-foreground" title="View source email">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {attachmentUrl && (
                    <a href={attachmentUrl} className="p-1.5 text-muted-foreground hover:text-foreground" title="Download attachment">
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {doc.source === 'upload' && (
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(doc.id)} disabled={deletingId === doc.id} className="h-7 px-2 text-muted-foreground hover:text-destructive shrink-0">
                      {deletingId === doc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </div>
                {isOpen && (
                  <div className="border-t bg-muted/20 p-3">
                    {doc.source === 'email_body' && (
                      <>
                        {doc.email_from && <p className="text-xs text-muted-foreground mb-2">From {doc.email_from}</p>}
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm max-h-96 overflow-auto">{doc.text_content}</pre>
                      </>
                    )}
                    {(doc.source === 'email' || doc.source === 'update_attachment') && inlineUrl && canInlineAttachment && (
                      doc.file_type.startsWith('image/')
                        ? <img src={inlineUrl} alt={doc.filename} className="max-h-[32rem] max-w-full mx-auto rounded" />
                        : <iframe src={inlineUrl} title={doc.filename} className="w-full h-[32rem] rounded bg-white" />
                    )}
                    {(doc.source === 'email' || doc.source === 'update_attachment') && attachmentUrl && !canInlineAttachment && <p className="text-muted-foreground">This file type cannot be previewed safely. Use the download button to open it.</p>}
                    {doc.source === 'update_attachment' && !attachmentUrl && <p className="text-muted-foreground">The original file was never stored, so it cannot be downloaded or previewed. See the update above for what could be read.</p>}
                    {doc.source === 'upload' && loadingDetailId === doc.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    {doc.source === 'upload' && detail?.text_content && <pre className="whitespace-pre-wrap break-words font-sans text-sm max-h-96 overflow-auto">{detail.text_content}</pre>}
                    {doc.source === 'upload' && detail?.file_url && detail.previewable && (
                      doc.file_type.startsWith('image/')
                        ? <img src={detail.file_url} alt={doc.filename} className="max-h-[32rem] max-w-full mx-auto rounded" />
                        : <iframe src={detail.file_url} title={doc.filename} className="w-full h-[32rem] rounded bg-white" />
                    )}
                    {doc.source === 'upload' && detail?.file_url && !detail.previewable && <a href={detail.file_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open document</a>}
                    {doc.source === 'upload' && !doc.has_readable_content && <p className="text-muted-foreground">No retained content is available for this document.</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {expanded && documents.length > 0 && (
        <p className="text-xs text-muted-foreground/70 px-3 pt-2">
          {includeEmailHistory
            ? 'Email bodies, attachments, and uploaded documents used for reporting and AI extraction appear here.'
            : 'Uploaded documents, every reporting attachment, and email filed here that is not a reporting update (deals, interactions). Reporting email bodies live in Updates above.'}{' '}
          {storageProvider === 'google_drive' && googleDriveFolderId ? (
            <>
              Raw documents can be found in{' '}
              <a
                href={`https://drive.google.com/drive/folders/${googleDriveFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Google Drive
              </a>.
            </>
          ) : (
            <>
              To store and access raw documents, enable a storage option in{' '}
              <a href="/settings" className="underline underline-offset-4 hover:text-foreground">Settings</a>.
            </>
          )}
        </p>
      )}

      {expanded && documents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {includeEmailHistory
            ? 'No documents or email activity yet. Upload a file here, or process an email for this company.'
            : 'No uploaded documents yet. Upload a file here.'}
        </p>
      )}
    </div>
  )
}
