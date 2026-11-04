'use client'

import { useCallback, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Which of a statement's folded groups are open. Each opens on its own from its arrow; "Show
 * details" and "Hide details" set them all at once and forget the one-off choices.
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

/** Classes for a row that opens and closes its group when clicked, as on the LP list. */
export const FOLD_ROW = 'cursor-pointer hover:bg-muted/20'
/** Classes for the rows a group opens to: indented and quieter, as on the LP list. */
export const FOLDED_CHILD = 'bg-muted/10 text-muted-foreground'

/**
 * The arrow and label at the head of a folded group, the same as the LP list's consolidated
 * investors: right when closed, down when open, the count after the name. The row it sits in
 * carries the click.
 */
export function DisclosureLabel({ open, children, count, className }: {
  open: boolean
  children: React.ReactNode
  count?: number
  className?: string
}) {
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{children}</span>
      {count != null && <span className="ml-1 shrink-0 text-xs font-normal text-muted-foreground">({count})</span>}
    </span>
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
