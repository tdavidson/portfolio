'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Building2, Lock, Send, Pencil, X, Check, Reply, Pin, PinOff } from 'lucide-react'
import Link from 'next/link'
import { NoteContent } from '@/components/note-content'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PortfolioNotesProvider } from '@/components/portfolio-notes'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import { MentionTextarea, type MentionMember, type MentionTextareaRef } from '@/components/mention-textarea'
import { Button } from '@/components/ui/button'

interface Note {
  id: string
  content: string
  userId: string
  userName: string | null
  userEmail: string
  companyId: string | null
  vehicleId?: string | null
  companyName: string | null
  mentionedUserIds: string[]
  mentionedCompanyIds?: string[]
  mentionedGroups?: string[]
  isRead: boolean
  createdAt: string
  edited: boolean
  pinnedAt: string | null
  pageContext: string | null
}

interface CompanyOption {
  id: string
  name: string
}

type FilterMode = 'all' | 'general' | 'mentions'

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function NotesPage() {
  const fv = useFeatureVisibility()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterMode>('all')

  // Compose / edit state
  const [members, setMembers] = useState<MentionMember[]>([])
  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  // Inline reply
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [posting, setPosting] = useState(false)
  const replyRef = useRef<MentionTextareaRef | null>(null)

  // Edit
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

  // Load members, companies, groups, and current user
  useEffect(() => {
    fetch('/api/notes/members').then(r => r.json()).then(data => {
      if (Array.isArray(data)) setMembers(data)
    }).catch(() => {})

    fetch('/api/companies').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        setCompanies(data.map((c: any) => ({ id: c.id, name: c.name })))
        const allGroups = new Set<string>()
        for (const c of data) {
          const pg = c.portfolio_group ?? c.portfolioGroup
          if (Array.isArray(pg)) {
            for (const g of pg) if (g) allGroups.add(g)
          } else if (pg) {
            allGroups.add(pg)
          }
        }
        setGroups(Array.from(allGroups).sort())
      }
    }).catch(() => {})

    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.userId) setCurrentUserId(data.userId)
      if (data.isAdmin) setIsAdmin(true)
    }).catch(() => {})
  }, [])

  const markAsRead = useCallback((notesList: Note[]) => {
    const unreadIds = notesList.filter(n => !n.isRead).map(n => n.id)
    if (unreadIds.length === 0) return
    fetch('/api/notes/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteIds: unreadIds }),
    }).catch(() => {})
    setNotes(prev => prev.map(n => unreadIds.includes(n.id) ? { ...n, isRead: true } : n))
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = filter !== 'all' ? `?filter=${filter}` : ''
    fetch(`/api/notes${params}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setNotes(data)
          markAsRead(data)
        }
      })
      .finally(() => setLoading(false))
  }, [filter, markAsRead])

  // Focus reply textarea when opening
  useEffect(() => {
    if (replyingTo) {
      setTimeout(() => replyRef.current?.focus(), 50)
    }
  }, [replyingTo])

  function openReply(noteId: string) {
    if (replyingTo === noteId) {
      setReplyingTo(null)
      setReplyContent('')
    } else {
      setReplyingTo(noteId)
      setReplyContent('')
    }
  }

  async function handleReply(parentNote: Note) {
    if (!replyContent.trim() || posting) return
    setPosting(true)
    try {
      const body: any = { content: replyContent.trim() }
      if (parentNote.companyId) body.companyId = parentNote.companyId
      // A reply is for the same entity as the note it answers.
      if (parentNote.vehicleId) body.vehicleId = parentNote.vehicleId
      const res = await fetch('/api/dashboard/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const newNote = await res.json()
        // Insert right after the parent note
        setNotes(prev => {
          const idx = prev.findIndex(n => n.id === parentNote.id)
          if (idx === -1) return [...prev, newNote]
          const copy = [...prev]
          copy.splice(idx + 1, 0, newNote)
          return copy
        })
        setReplyingTo(null)
        setReplyContent('')
      }
    } finally {
      setPosting(false)
    }
  }

  function startEditing(note: Note) {
    setEditingId(note.id)
    setEditContent(note.content)
    setReplyingTo(null)
  }

  async function handleEdit(noteId: string) {
    if (!editContent.trim()) return
    const res = await fetch(`/api/dashboard/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editContent.trim() }),
    })
    if (res.ok) {
      const updated = await res.json()
      setNotes(prev => prev.map(n => n.id === noteId ? { ...n, content: updated.content, edited: updated.edited } : n))
      setEditingId(null)
      setEditContent('')
    }
  }

  async function handlePin(noteId: string, pin: boolean) {
    const res = await fetch(`/api/dashboard/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: pin }),
    })
    if (res.ok) {
      const { pinnedAt } = await res.json()
      setNotes(prev => {
        const updated = prev.map(n => n.id === noteId ? { ...n, pinnedAt } : n)
        // Re-sort: pinned first, then by createdAt desc
        return updated.sort((a, b) => {
          if (a.pinnedAt && !b.pinnedAt) return -1
          if (!a.pinnedAt && b.pinnedAt) return 1
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })
      })
    }
  }

  async function handleDelete(noteId: string) {
    const res = await fetch(`/api/dashboard/notes/${noteId}`, { method: 'DELETE' })
    if (res.ok) {
      setNotes(prev => prev.filter(n => n.id !== noteId))
    }
  }

  return (
    <PortfolioNotesProvider>
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">{fv.notes === 'admin' && <Lock className="h-4 w-4 text-warning" />}Notes</h1>
          <AnalystToggleButton />
        </div>
        <p className="text-sm text-muted-foreground">Activity and conversations across your portfolio</p>
        <div className="flex items-center pt-2">
          <div className="flex items-center rounded-md border text-xs">
          {(['all', 'mentions', 'general'] as FilterMode[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 capitalize transition-colors ${ f === 'all' ? 'rounded-l-md' : f === 'general' ? 'rounded-r-md' : '' } ${ filter === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground' }`}
            >
              {f === 'mentions' ? '@Mentions' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">
      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {!loading && notes.length === 0 && (
        <p className="text-sm text-muted-foreground">No notes found.</p>
      )}

      <div className="space-y-1">
        {notes.map(note => (
          <div
            key={note.id}
            className={`group rounded-card border p-4 transition-colors ${ note.pinnedAt ? 'border-l-4 border-l-foreground/20' : '' } ${ !note.isRead ? 'bg-info-subtle/50 dark:bg-info-subtle/20 border-info dark:border-info/40' : 'bg-card' }`}
          >
            {/* Header row */}
            <div className="flex items-center gap-2 mb-1">
              {!note.isRead && (
                <span className="h-2 w-2 rounded-full bg-info shrink-0" />
              )}
              {note.pinnedAt && (
                <Pin className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              <span className="text-sm font-medium">
                {note.userName || note.userEmail.split('@')[0]}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(note.createdAt)}
              </span>
              {note.edited && (
                <span className="text-[10px] text-muted-foreground italic">edited</span>
              )}
              {/* Page context label */}
              {note.companyName ? (
                <Link
                  href={`/companies/${note.companyId}`}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <Building2 className="h-3 w-3" />
                  {note.companyName}
                </Link>
              ) : note.pageContext ? (
                <span className="text-[11px] text-muted-foreground capitalize">{note.pageContext}</span>
              ) : (
                <span className="text-[11px] text-muted-foreground">General</span>
              )}
              {/* Pin / Edit / Delete actions */}
              <div className="md:opacity-0 md:group-hover:opacity-100 transition-opacity ml-auto flex items-center gap-1">
                <button onClick={() => handlePin(note.id, !note.pinnedAt)} title={note.pinnedAt ? 'Unpin' : 'Pin'}>
                  {note.pinnedAt ? (
                    <PinOff className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  ) : (
                    <Pin className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  )}
                </button>
                {currentUserId && note.userId === currentUserId && (
                  <button onClick={() => startEditing(note)}>
                    <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
                {currentUserId && (note.userId === currentUserId || isAdmin) && (
                  <button onClick={() => handleDelete(note.id)}>
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>
            </div>

            {/* Note body: edit mode or content */}
            {editingId === note.id ? (
              <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleEdit(note.id)
                    }
                    if (e.key === 'Escape') {
                      setEditingId(null)
                      setEditContent('')
                    }
                  }}
                  rows={2}
                  className="flex-1 resize-none rounded-md border bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  autoFocus
                />
                <div className="flex flex-col gap-1 self-end">
                  <button onClick={e => { handleEdit(note.id) }}>
                    <Check className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                  <button onClick={e => { setEditingId(null); setEditContent('') }}>
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              </div>
            ) : (
              <NoteContent content={note.content} />
            )}

            {/* Reply button */}
            {editingId !== note.id && replyingTo !== note.id && (
              <button
                onClick={() => openReply(note.id)}
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Reply className="h-3 w-3" />
                Reply
              </button>
            )}

            {/* Inline reply */}
            {replyingTo === note.id && editingId !== note.id && (
              <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                <MentionTextarea
                  ref={replyRef}
                  value={replyContent}
                  onChange={setReplyContent}
                  members={members}
                  companies={companies}
                  groups={groups}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleReply(note)
                    }
                    if (e.key === 'Escape') {
                      setReplyingTo(null)
                      setReplyContent('')
                    }
                  }}
                  placeholder="Write a reply... (@ to tag)"
                  rows={2}
                  className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  size="icon"
                  onClick={() => handleReply(note)}
                  disabled={!replyContent.trim() || posting}
                  className="h-auto self-end px-2 py-2"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    <AnalystPanel />
    </div>
    </div>
    </PortfolioNotesProvider>
  )
}
