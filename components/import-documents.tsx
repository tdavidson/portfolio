'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, FileText, Loader2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * Document import: pick files, auto-match filenames to portfolio companies, review, upload.
 * The one flow behind both the Import page's "Document Upload" section and the /start shortcut,
 * so the matching, size limits and registration call cannot drift between the two.
 */

interface FileMatch {
  file: File
  filename: string
  companyId: string | null
  companyName: string | null
  confidence: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
  textOnly?: boolean
}

interface Company {
  id: string
  name: string
}

export const ACCEPTED_DOC_TYPES = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.jpg,.jpeg,.png'
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const TEXT_ONLY_THRESHOLD = 10 * 1024 * 1024 // 10 MB, files above this get text-only extraction

export function ImportDocuments({ onUploaded }: { onUploaded?: (count: number) => void } = {}) {
  const [docFiles, setDocFiles] = useState<FileMatch[]>([])
  const [matching, setMatching] = useState(false)
  const [uploadingAll, setUploadingAll] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [docSuccess, setDocSuccess] = useState<string | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [fundId, setFundId] = useState<string | null>(null)
  const docInputRef = useRef<HTMLInputElement>(null)

  // Companies for the match dropdown, and the fund for the storage path.
  useEffect(() => {
    async function loadCompanies() {
      try {
        const res = await fetch('/api/companies')
        if (res.ok) {
          const data = await res.json()
          setCompanies(data.companies ?? data ?? [])
        }
      } catch { /* ignore */ }
    }
    async function loadFundId() {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const { data } = await supabase
          .from('fund_members')
          .select('fund_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle() as { data: { fund_id: string } | null }
        if (data) setFundId(data.fund_id)
      } catch { /* ignore */ }
    }
    loadCompanies()
    loadFundId()
  }, [])

  async function handleDocFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setDocError(null)
    setDocSuccess(null)

    const fileList = Array.from(files)
    setDocFiles(fileList.map(f => ({
      file: f,
      filename: f.name,
      companyId: null,
      companyName: null,
      confidence: 'pending',
      status: 'pending',
    })))

    // Auto-match filenames to companies.
    setMatching(true)
    try {
      const res = await fetch('/api/import/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames: fileList.map(f => f.name) }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.fundId) setFundId(data.fundId)
        const matchMap = new Map<string, { companyId: string | null; companyName: string | null; confidence: string }>()
        for (const m of data.matches ?? []) {
          matchMap.set(m.filename, { companyId: m.companyId, companyName: m.companyName, confidence: m.confidence })
        }
        setDocFiles(prev => prev.map(f => {
          const match = matchMap.get(f.filename)
          return match ? { ...f, companyId: match.companyId, companyName: match.companyName, confidence: match.confidence } : f
        }))
      } else {
        const data = await res.json()
        setDocError(data.error ?? 'Auto-matching failed')
      }
    } catch {
      setDocError('Auto-matching failed')
    } finally {
      setMatching(false)
    }

    if (docInputRef.current) docInputRef.current.value = ''
  }

  function updateFileCompany(filename: string, companyId: string) {
    const company = companies.find(c => c.id === companyId)
    setDocFiles(prev => prev.map(f =>
      f.filename === filename
        ? { ...f, companyId, companyName: company?.name ?? null, confidence: 'manual' }
        : f,
    ))
  }

  async function handleUploadAll() {
    const filesToUpload = docFiles.filter(f => f.companyId && f.status !== 'done')
    if (filesToUpload.length === 0) return

    setUploadingAll(true)
    setDocError(null)
    setDocSuccess(null)

    const supabase = createClient()
    let successCount = 0
    let errorCount = 0

    for (const fileMatch of filesToUpload) {
      setDocFiles(prev => prev.map(f => (f.filename === fileMatch.filename ? { ...f, status: 'uploading' } : f)))
      try {
        if (fileMatch.file.size > MAX_FILE_SIZE) throw new Error('File exceeds 20 MB limit')
        const isOversized = fileMatch.file.size > TEXT_ONLY_THRESHOLD
        const storagePath = `${fundId}/${fileMatch.companyId}/${crypto.randomUUID()}-${fileMatch.filename}`

        const { error: uploadError } = await supabase.storage.from('company-documents').upload(storagePath, fileMatch.file)
        if (uploadError) throw new Error(uploadError.message)

        const res = await fetch(`/api/companies/${fileMatch.companyId}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storagePath,
            filename: fileMatch.filename,
            fileType: fileMatch.file.type || `application/${fileMatch.filename.split('.').pop()}`,
            fileSize: fileMatch.file.size,
            ...(isOversized ? { textOnly: true } : {}),
          }),
        })
        if (!res.ok) {
          let errorMsg = 'Registration failed'
          try {
            const data = await res.json()
            errorMsg = data.error ?? errorMsg
          } catch {
            errorMsg = `Server error (${res.status}). The file may be too large to process.`
          }
          throw new Error(errorMsg)
        }
        let result: { textOnly?: boolean } = {}
        try { result = await res.json() } catch { /* non-JSON but ok */ }

        setDocFiles(prev => prev.map(f =>
          f.filename === fileMatch.filename ? { ...f, status: 'done', textOnly: isOversized && result.textOnly } : f,
        ))
        successCount++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setDocFiles(prev => prev.map(f => (f.filename === fileMatch.filename ? { ...f, status: 'error', error: message } : f)))
        errorCount++
      }
    }

    setUploadingAll(false)
    if (successCount > 0) {
      setDocSuccess(`${successCount} document${successCount > 1 ? 's' : ''} uploaded successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`)
      onUploaded?.(successCount)
    }
    if (errorCount > 0 && successCount === 0) setDocError('All uploads failed')
  }

  const matchedCount = docFiles.filter(f => f.companyId).length
  const unmatchedCount = docFiles.filter(f => !f.companyId).length

  return (
    <div>
      {docError && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{docError}</AlertDescription>
        </Alert>
      )}
      {docSuccess && (
        <Alert className="mb-4">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{docSuccess}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <div>
          <input
            ref={docInputRef}
            type="file"
            multiple
            accept={ACCEPTED_DOC_TYPES}
            onChange={handleDocFilesSelected}
            className="hidden"
          />
          <Button variant="outline" onClick={() => docInputRef.current?.click()} disabled={matching || uploadingAll}>
            <Upload className="h-4 w-4 mr-2" />
            Select Files
          </Button>
          <p className="text-xs text-muted-foreground mt-1.5">Max 20 MB per file. Files over 10 MB will have text extracted only.</p>
        </div>

        {matching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Matching filenames to companies...
          </div>
        )}

        {docFiles.length > 0 && !matching && (
          <>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium">Filename</th>
                    <th className="text-left px-3 py-2 font-medium">Matched company</th>
                    <th className="text-left px-3 py-2 font-medium w-20">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {docFiles.map((f, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{f.filename}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Select value={f.companyId ?? 'unmatched'} onValueChange={val => updateFileCompany(f.filename, val)}>
                          <SelectTrigger className="h-8 text-xs w-48">
                            <SelectValue placeholder="Select company..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="unmatched">
                              <span className="text-muted-foreground">No match</span>
                            </SelectItem>
                            {companies.map(c => (
                              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2">
                        {f.status === 'pending' && f.companyId && <span className="text-xs text-muted-foreground">Ready</span>}
                        {f.status === 'pending' && !f.companyId && <span className="text-xs text-muted-foreground">-</span>}
                        {f.status === 'uploading' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                        {f.status === 'done' && !f.textOnly && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                        {f.status === 'done' && f.textOnly && (
                          <span className="text-sm text-warning" title="File exceeded 10 MB, only extracted text was stored (no native PDF/image)">Text only</span>
                        )}
                        {f.status === 'error' && <span className="text-sm text-destructive" title={f.error}>Failed</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {matchedCount} matched{unmatchedCount > 0 ? `, ${unmatchedCount} unmatched` : ''}
              </p>
              <Button onClick={handleUploadAll} disabled={uploadingAll || matchedCount === 0}>
                {uploadingAll && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {uploadingAll ? 'Uploading...' : `Upload ${matchedCount} File${matchedCount !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The same flow in a dialog — the /start shortcut, in the outline idiom of its neighbours. */
export function ImportDocumentsButton() {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground">
          <Upload className="h-3.5 w-3.5" />Import documents
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import documents</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Upload decks, board materials and reports; each file is matched to a portfolio company for you to confirm.
        </p>
        <ImportDocuments />
      </DialogContent>
    </Dialog>
  )
}
