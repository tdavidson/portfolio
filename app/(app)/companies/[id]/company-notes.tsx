'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { MessageSquare, Send, Pencil, X, Check, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoteContent } from '@/components/note-content'
import { MentionTextarea, type MentionMember, type MentionTextareaRef } from '@/components/mention-textarea'
import { usePanelContext } from './company-panel-context'
import { useAnalystContext } from '@/components/analyst-context'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import { MobileDrawerPanel } from '@/components/mobile-drawer-panel'
import { NoteEntitySelect } from '@/components/note-entity-select'

interface Note {
  id: string
  content: string
  userId: string
  userName: string | null
  userEmail: string
  mentionedUserIds: string[]
  isRead: boolean
  createdAt: string
  edited: boolean
}

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

export function ChatButton() {
  const { notesOpen, toggleNotes, unreadCount } = usePanelContext()
  const fv = useFeatureVisibility()
  const notesAdminOnly = fv.notes === 'admin'
  return (
    <Button
      variant="outline"
      size="sm"
      className={`ml-auto gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground ${notesOpen ? 'bg-accent' : ''}`}
      onClick={toggleNotes}
    >
      <span className="relative">
        <MessageSquare className="h-3.5 w-3.5" />
        {!notesOpen && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-info" />
        )}
      </span>
      Notes
      {notesAdminOnly && <Lock className="h-3 w-3 text-warning" />}
      {!notesOpen && unreadCount > 0 && (
        <span className="text-[10px] font-medium bg-info text-white rounded-full px-1 min-w-[16px] text-center">
          {unreadCount}
        </span>
      )}
    </Button>
  )
}

export function CompanyNotesPanel() {
  const ctx = usePanelContext()
  return (
    <MobileDrawerPanel open={ctx.notesOpen} onOpenChange={(open) => { if (!open) ctx.closeNotes() }}>
      <NotesPanel />
    </MobileDrawerPanel>
  )
}

function NotesPanel() {
  const { companyId, userId, isAdmin, inputRef, closeNotes, setUnreadCount } = usePanelContext()
  const { fundName } = useAnalystContext()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState('')
  const [posting, setPosting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [members, setMembers] = useState<MentionMember[]>([])
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/notes/members').then(r => r.json()).then(data => {
      if (Array.isArray(data)) setMembers(data)
    }).catch(() => {})

    fetch('/api/companies').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        setCompanies(data.map((c: any) => ({ id: c.id, name: c.name })))
      }
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
    // Optimistically mark as read locally
    setNotes(prev => prev.map(n => unreadIds.includes(n.id) ? { ...n, isRead: true } : n))
    setUnreadCount(0)
  }, [setUnreadCount])

  useEffect(() => {
    setLoading(true)
    fetch(`/api/companies/${companyId}/notes`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setNotes(data)
          // Update unread count and mark as read on load
          const unread = data.filter((n: Note) => !n.isRead)
          setUnreadCount(unread.length)
          if (unread.length > 0) {
            markAsRead(data)
          }
        }
      })
      .finally(() => setLoading(false))
  }, [companyId, markAsRead, setUnreadCount])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [notes])

  // Every note is for one of the writer's entities that holds this company (lib/notes/entity.ts).
  const [noteEntity, setNoteEntity] = useState<string | null>(null)
  const [postError, setPostError] = useState<string | null>(null)

  async function handlePost() {
    if (!content.trim() || posting) return
    setPosting(true)
    setPostError(null)
    try {
      const res = await fetch(`/api/companies/${companyId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim(), vehicleId: noteEntity }),
      })
      if (res.ok) {
        const note = await res.json()
        setNotes(prev => [...prev, note])
        setContent('')
        setTimeout(() => inputRef.current?.focus(), 50)
      } else {
        setPostError((await res.json().catch(() => ({}))).error ?? 'Could not post the note.')
      }
    } finally {
      setPosting(false)
    }
  }

  async function handleDelete(noteId: string) {
    const res = await fetch(`/api/companies/${companyId}/notes/${noteId}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      setNotes(prev => prev.filter(n => n.id !== noteId))
    }
  }

  function startEditing(note: Note) {
    setEditingId(note.id)
    setEditContent(note.content)
  }

  async function handleEdit(noteId: string) {
    if (!editContent.trim()) return
    const res = await fetch(`/api/companies/${companyId}/notes/${noteId}`, {
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

  return (
    <div className="flex flex-col h-full">
    <div className="max-h-[80vh] lg:max-h-[calc(100vh-6rem)] rounded-lg border bg-card flex flex-col flex-1">
      <div className="px-4 py-3 flex items-center justify-between">
        <h2 className="text-base font-medium text-muted-foreground">Notes</h2>
        <button onClick={closeNotes} className="hidden lg:block">
          <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-3 space-y-3">
        {loading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {!loading && notes.length === 0 && (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        )}
        {notes.map(note => (
          <div key={note.id} className="group">
            <div className="flex items-center gap-2 mb-0.5">
              {!note.isRead && (
                <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />
              )}
              <span className="text-xs font-medium">
                {note.userName || note.userEmail.split('@')[0]}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(note.createdAt)}
              </span>
              {note.edited && (
                <span className="text-[10px] text-muted-foreground italic">edited</span>
              )}
              <div className="md:opacity-0 md:group-hover:opacity-100 transition-opacity ml-auto flex items-center gap-1">
                {note.userId === userId && (
                  <button onClick={() => startEditing(note)}>
                    <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
                {(note.userId === userId || isAdmin) && (
                  <button onClick={() => handleDelete(note.id)}>
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>
            </div>
            {editingId === note.id ? (
              <div className="flex gap-1.5">
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
                  <button onClick={() => handleEdit(note.id)}>
                    <Check className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                  <button onClick={() => { setEditingId(null); setEditContent('') }}>
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              </div>
            ) : (
              <NoteContent content={note.content} />
            )}
          </div>
        ))}
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 space-y-1">
          <NoteEntitySelect companyId={companyId} value={noteEntity} onChange={setNoteEntity} />
          {postError && <p className="text-sm text-destructive">{postError}</p>}
        </div>
        <div className="flex gap-2">
          <MentionTextarea
            ref={inputRef}
            value={content}
            onChange={setContent}
            members={members}
            companies={companies}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handlePost()
              }
            }}
            placeholder="Write a note... (@ to tag people or companies)"
            rows={2}
            className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            size="icon"
            onClick={handlePost}
            disabled={!content.trim() || posting}
            className="h-auto self-end px-2 py-2"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
    <p className="text-[10px] text-muted-foreground/60 text-center mt-3 px-4">
      All chat history is saved by {fundName}.
    </p>
    </div>
  )
}
