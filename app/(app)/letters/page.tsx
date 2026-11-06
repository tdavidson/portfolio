'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, FileText, Loader2, Trash2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { VoiceDialog, type VoiceTemplate } from './voice-dialog'
import { ImportLetterDialog, ProfileDialog } from './profile-dialog'
import { useFeatureVisibility } from '@/components/feature-visibility-context'

interface LetterSummary {
  id: string
  period_year: number
  period_quarter: number
  period_label: string
  portfolio_group: string
  status: string
  is_year_end: boolean
  created_at: string
  updated_at: string
}


export default function LettersPage() {
  const fv = useFeatureVisibility()
  const router = useRouter()
  const [letters, setLetters] = useState<LetterSummary[]>([])
  const [templates, setTemplates] = useState<VoiceTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/lp-letters').then(r => r.json()),
      fetch('/api/lp-letters/templates').then(r => r.json()),
    ]).then(([lettersData, templatesData]) => {
      if (lettersData?.role === 'admin') setIsAdmin(true)
      setLetters(Array.isArray(lettersData?.letters) ? lettersData.letters : Array.isArray(lettersData) ? lettersData : [])
      setTemplates(Array.isArray(templatesData) ? templatesData : [])
    }).finally(() => setLoading(false))
  }, [])

  const handleDeleteLetter = async () => {
    if (!deleteConfirmId || deleteConfirmText !== 'delete') return
    setDeleting(true)
    await fetch(`/api/lp-letters/${deleteConfirmId}`, { method: 'DELETE' })
    setLetters(prev => prev.filter(l => l.id !== deleteConfirmId))
    setDeleteConfirmId(null)
    setDeleteConfirmText('')
    setDeleting(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {fv.lp_letters === 'admin' && <Lock className="h-4 w-4 text-warning" />}Letters
          </h1>
          <AnalystToggleButton />
        </div>
        <p className="text-sm text-muted-foreground">Create communications about your portfolio for your limited partners</p>
        <div className="flex items-center gap-3 pt-2">
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setTemplateDialogOpen(true)}>
            Voice
          </Button>
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setProfileOpen(true)}>
            Profiles
          </Button>
          <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setImportOpen(true)}>
            Import sent letter
          </Button>
          <Link href="/letters/new">
            <Button size="sm" variant="outline" className="text-muted-foreground">
              <Plus className="h-4 w-4 mr-1.5" />
              New letter
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 w-full space-y-6">
          {/* No templates notice */}
          {templates.length === 0 && (
            <div className="rounded-card border border-dashed p-8 text-center space-y-3">
              <FileText className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Set up the fund&apos;s voice first: learn it from past letters, or use the general voice.
              </p>
              <Button size="sm" onClick={() => setTemplateDialogOpen(true)}>
                Set up voice
              </Button>
            </div>
          )}

          {/* Letters list */}
          {letters.length === 0 && templates.length > 0 && (
            <div className="rounded-card border border-dashed p-8 text-center space-y-4">
              <p className="text-sm text-muted-foreground">No letters yet. Create your first quarterly LP letter.</p>
              <Link href="/letters/new" className="inline-block">
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1.5" />
                  New letter
                </Button>
              </Link>
            </div>
          )}

          {letters.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left font-medium px-4 py-2.5">Period</th>
                    <th className="text-left font-medium px-4 py-2.5">Portfolio Group</th>
                    <th className="text-left font-medium px-4 py-2.5">Updated</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {letters.map(l => (
                    <tr key={l.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2.5">
                        <Link href={`/letters/${l.id}`} className="font-medium hover:underline">
                          {l.period_label}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{l.portfolio_group}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">
                        {new Date(l.updated_at).toLocaleDateString()}
                      </td>
                      {isAdmin && (
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => { setDeleteConfirmId(l.id); setDeleteConfirmText('') }}
                          className="text-muted-foreground/50 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <AnalystPanel />
      </div>

      {/* Delete letter confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) { setDeleteConfirmId(null); setDeleteConfirmText('') } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Letter</DialogTitle>
            <DialogDescription>This will permanently delete this letter and all its content. This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <div>
            <label className="text-sm text-muted-foreground">Type <strong>delete</strong> to confirm</label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              placeholder="delete"
              autoFocus
              className="mt-1.5 w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteConfirmId(null); setDeleteConfirmText('') }}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteLetter} disabled={deleting || deleteConfirmText !== 'delete'}>
              {deleting ? 'Deleting...' : 'Delete Letter'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} templates={templates.filter(t => t.id).map(t => ({ id: t.id as string, name: t.name }))} />
      <ImportLetterDialog open={importOpen} onOpenChange={setImportOpen} onImported={l => router.push(`/letters/${l.id}`)} />
      <VoiceDialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen} templates={templates} setTemplates={setTemplates} />
    </div>
  )
}
