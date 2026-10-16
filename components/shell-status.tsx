'use client'

import { createContext, useContext, useEffect, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react'

export interface ShellStatus {
  reviewBadge: number
  approvalsBadge: number
  settingsBadge: number
  notesBadge: number
  updateAvailable: boolean
}

const StatusContext = createContext<ShellStatus | null>(null)
const UpdateContext = createContext<Dispatch<SetStateAction<ShellStatus>> | null>(null)

export function ShellStatusProvider({ initial, children }: { initial: ShellStatus; children: ReactNode }) {
  const [status, setStatus] = useState(initial)
  return (
    <UpdateContext.Provider value={setStatus}>
      <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
    </UpdateContext.Provider>
  )
}

export function useShellStatus() {
  const status = useContext(StatusContext)
  if (!status) throw new Error('Shell status requires its provider')
  return status
}

/** A small streamed payload updates the existing nav; it does not block the page or fetch again. */
export function ShellStatusUpdate({ status }: { status: Partial<ShellStatus> }) {
  const setStatus = useContext(UpdateContext)
  useEffect(() => {
    setStatus?.(previous => ({ ...previous, ...status }))
  }, [setStatus, status])
  return null
}
