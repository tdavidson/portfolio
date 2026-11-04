'use client'

import { useCallback, useState } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Which of a statement's folded groups are open. Each group opens on its own; "Show details" and
 * "Hide details" set them all at once and forget the one-off choices.
 */
export function useDisclosure() {
  const [all, setAllState] = useState<boolean | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const isOpen = useCallback((key: string, dflt = false) => overrides[key] ?? all ?? dflt, [overrides, all])
  const toggle = useCallback((key: string, dflt = false) =>
    setOverrides(o => ({ ...o, [key]: !(o[key] ?? all ?? dflt) })), [all])
  const setAll = useCallback((open: boolean) => { setAllState(open); setOverrides({}) }, [])
  return { isOpen, toggle, setAll, allOpen: all === true }
}

export type Disclosure = ReturnType<typeof useDisclosure>

/** The chevron and label at the head of a folded group. */
export function DisclosureLabel({ open, onToggle, children, count, className }: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  count?: number
  className?: string
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      className={cn('inline-flex max-w-full items-center gap-1 text-left hover:text-foreground', className)}>
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="truncate">{children}</span>
      {count != null && <span className="shrink-0 text-xs text-muted-foreground">({count})</span>}
    </button>
  )
}

/** Toolbar button that opens or closes every group on the page. */
export function DetailToggle({ disclosure, className }: { disclosure: Disclosure; className?: string }) {
  const open = disclosure.allOpen
  const Icon = open ? ChevronsDownUp : ChevronsUpDown
  return (
    <button type="button" onClick={() => disclosure.setAll(!open)}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:text-foreground', className)}>
      <Icon className="h-4 w-4" />
      {open ? 'Hide details' : 'Show details'}
    </button>
  )
}
