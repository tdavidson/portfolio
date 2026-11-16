'use client'

import { useState } from 'react'
import { Upload, Loader2, FileText, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

interface Props {
  emailId: string
}

export function UploadDocumentButton({ emailId }: Props) {
  const [uploading, setUploading] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  async function handleUpload(file: File) {
    setUploading(true)
    setError(null)
    try {
      const supabase = createClient()
      const storagePath = `${emailId}/${crypto.randomUUID()}-${file.name}`

      const { error: uploadError } = await supabase.storage
        .from('email-attachments')
        .upload(storagePath, file)

      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

      const res = await fetch(`/api/emails/${emailId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          contentLength: file.size,
          storagePath,
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? 'Upload failed')
      }
      setUploadedFiles(prev => [...prev, file.name])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error uploading file')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      {uploadedFiles.length > 0 && (
        <div className="space-y-1 mb-3">
          {uploadedFiles.map((name, i) => (
            <p key={i} className="text-xs text-success flex items-center gap-1.5">
              <Check className="h-3 w-3" />
              <FileText className="h-3 w-3" />
              {name} uploaded
            </p>
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive mb-2">{error}</p>
      )}

      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input
          type="file"
          className="hidden"
          accept=".pdf,.xlsx,.xls,.csv,.docx,.pptx,.png,.jpg,.jpeg"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) {
              handleUpload(file)
              e.target.value = ''
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={uploading}
          className="gap-1.5 pointer-events-none"
          tabIndex={-1}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {uploading ? 'Uploading...' : 'Upload document'}
        </Button>
      </label>
    </div>
  )
}
