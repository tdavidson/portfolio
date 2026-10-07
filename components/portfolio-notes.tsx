'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { MessageSquare, Send, Pencil, X, Check, Building2, Lock, Pin, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoteContent } from '@/components/note-content'
import { MentionTextarea, type MentionMember, type MentionTextareaRef } from '@/components/mention-textarea'
import { useAnalystContext } from '@/components/analyst-context'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import Link from 'next/link'
import { MobileDrawerPanel } from '@/components/mobile-drawer-panel'
import { NoteEntitySelect } from '@/components/note-entity-select'

interface Note {
  id: string
  content: string
  userId: string
  userName: string | null
  userEmail: string
  companyId: string | null
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

interface PortfolioNotesContextValue {
  open: boolean
  toggle: () => void
  unreadCount: number
  pageContext?: string
}

const PortfolioNotesContext = createContext<PortfolioNotesContextValue | null>(null)

export function PortfolioNotesProvider({ children, pageContext }: { children: ReactNode; pageContext?: string }) {
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const params = pageContext
      ? `?page_context=${pageContext}&limit=10`
      : '?filter=general'
    fetch(`/api/dashboard/notes${params}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setUnreadCount(data.filter((n: Note) => !n.isRead).length)
        }
      })
      .catch(() => {})
  }, [pageContext])

  return (
    <PortfolioNotesContext.Provider value={{ open, toggle: () => setOpen(prev => !prev), unreadCount, pageContext }}>
      {children}
    </PortfolioNotesContext.Provider>
  )
}

export function PortfolioNotesButton() {
  const ctx = useContext(PortfolioNotesContext)
  const fv = useFeatureVisibility()
  if (!ctx) return null
  const { open, toggle, unreadCount } = ctx
  const notesAdminOnly = fv.notes === 'admin'
  return (
    <Button
      variant="outline"
      size="sm"
      className={`gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground ${open ? 'bg-accent' : ''}`}
      onClick={toggle}
    >
      <span className="relative">
        <MessageSquare className="h-3.5 w-3.5" />
        {!open && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-info" />
        )}
      </span>
      Notes
      {notesAdminOnly && <Lock className="h-3 w-3 text-warning" />}
      {!open && unreadCount > 0 && (
        <span className="text-[10px] font-medium bg-info text-white rounded-full px-1 min-w-[16px] text-center">
          {unreadCount}
        </span>
      )}
    </Button>
  )
}

export function PortfolioNotesPanel() {
  const ctx = useContext(PortfolioNotesContext)
  if (!ctx) return null
  return (
    <MobileDrawerPanel open={ctx.open} onOpenChange={(open) => { if (!open) ctx.toggle() }}>
      <NotesPanel toggle={ctx.toggle} pageContext={ctx.pageContext} />
    </MobileDrawerPanel>
  )
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

function NotesPanel({ toggle, pageContext }: { toggle: () => void; pageContext?: string }) {
  const { fundName } = useAnalystContext()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState('')
  const [posting, setPosting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [members, setMembers] = useState<MentionMember[]>([])
  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<MentionTextareaRef | null>(null)

  useEffect(() => {
    fetch('/api/notes/members').then(r => r.json()).then(data => {
      if (Array.isArray(data)) setMembers(data)
    }).catch(() => {})

    fetch('/api/companies').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        setCompanies(data.map((c: any) => ({ id: c.id, name: c.name })))
        // Extract distinct portfolio groups
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
    const params = pageContext
      ? `?page_context=${pageContext}&limit=10`
      : '?filter=general'
    fetch(`/api/dashboard/notes${params}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          // Sort pinned notes to top, then chronological
          const sorted = [...data].sort((a, b) => {
            if (a.pinnedAt && !b.pinnedAt) return -1
            if (!a.pinnedAt && b.pinnedAt) return 1
            return 0 // already chronological from API
          })
          setNotes(sorted)
          markAsRead(data)
        }
      })
      .finally(() => setLoading(false))
  }, [markAsRead, pageContext])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [notes])

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  // Every note is for one of the writer's entities (lib/notes/entity.ts).
  const [noteEntity, setNoteEntity] = useState<string | null>(null)
  const [postError, setPostError] = useState<string | null>(null)

  async function handlePost() {
    if (!content.trim() || posting) return
    setPosting(true)
    setPostError(null)
    try {
      const body: any = { content: content.trim(), vehicleId: noteEntity }
      if (pageContext) body.pageContext = pageContext
      const res = await fetch('/api/dashboard/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    const res = await fetch(`/api/dashboard/notes/${noteId}`, { method: 'DELETE' })
    if (res.ok) {
      setNotes(prev => prev.filter(n => n.id !== noteId))
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
        return updated.sort((a, b) => {
          if (a.pinnedAt && !b.pinnedAt) return -1
          if (!a.pinnedAt && b.pinnedAt) return 1
          return 0
        })
      })
    }
  }

  function startEditing(note: Note) {
    setEditingId(note.id)
    setEditContent(note.content)
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

  return (
    <div className="flex flex-col h-full">
    <div className="max-h-[80vh] lg:max-h-[calc(100vh-6rem)] rounded-lg border bg-card flex flex-col flex-1">
      <div className="px-4 py-3 flex items-center justify-between">
        <h2 className="text-base font-medium text-muted-foreground">Team Notes</h2>
        <button onClick={toggle} className="hidden lg:block">
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
          <div key={note.id} className={`group ${note.pinnedAt ? 'border-l-2 border-foreground/20 pl-2' : ''}`}>
            <div className="flex items-center gap-2 mb-0.5">
              {!note.isRead && (
                <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />
              )}
              {note.pinnedAt && (
                <Pin className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
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
            {note.companyName && (
              <Link
                href={`/companies/${note.companyId}`}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mb-0.5"
              >
                <Building2 className="h-2.5 w-2.5" />
                {note.companyName}
              </Link>
            )}
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
          <NoteEntitySelect value={noteEntity} onChange={setNoteEntity} />
          {postError && <p className="text-sm text-destructive">{postError}</p>}
        </div>
        <div className="flex items-end gap-2">
          <MentionTextarea
            ref={inputRef}
            value={content}
            onChange={setContent}
            members={members}
            companies={companies}
            groups={groups}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handlePost()
              }
            }}
            placeholder="Write a note... (@ to tag people, companies, or groups)"
            rows={2}
            className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            onClick={handlePost}
            disabled={!content.trim() || posting}
            className="shrink-0 self-end px-2.5 py-2"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
    <p className="text-[10px] text-muted-foreground/60 text-center mt-3 px-4 shrink-0">
      All chat history is saved by {fundName}.
    </p>
    </div>
  )
}
