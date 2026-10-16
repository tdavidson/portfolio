/**
 * Accounts this browser has signed in to recently, so "Switch account" can offer them by name.
 *
 * One email is one fund (fund_members.user_id is unique), so switching funds means switching
 * sign-ins. This list is what makes that a click instead of retyping an address: it holds the
 * email and the fund's name, NEVER a token or session — the switch is a full sign-out and sign-in,
 * MFA included. Anything here is a convenience a person can clear from the sign-in page.
 *
 * localStorage can throw (private windows, blocked storage), so every access is guarded and the
 * sign-in page works the same with an empty list.
 */

import { useMemo, useSyncExternalStore } from 'react'

export interface RecentAccount {
  email: string
  fundName: string
}

const KEY = 'recent-accounts'
const MAX = 5
const CHANGE_EVENT = 'recent-accounts:change'

function parse(raw: string | null): RecentAccount[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((a): a is RecentAccount =>
        !!a && typeof a.email === 'string' && a.email.includes('@') && typeof a.fundName === 'string')
      .slice(0, MAX)
  } catch {
    return []
  }
}

/** Most recent first, with `account` moved (or added) to the front. Pure, for the tests. */
export function withRecent(list: RecentAccount[], account: RecentAccount): RecentAccount[] {
  const email = account.email.trim().toLowerCase()
  if (!email.includes('@')) return list
  return [{ email, fundName: account.fundName }, ...list.filter(a => a.email !== email)].slice(0, MAX)
}

export function readRecentAccounts(): RecentAccount[] {
  try {
    return parse(window.localStorage.getItem(KEY))
  } catch {
    return []
  }
}

function write(list: RecentAccount[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch { /* storage blocked: switching still works, just without the shortcut */ }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function rememberAccount(account: RecentAccount): void {
  const current = readRecentAccounts()
  const next = withRecent(current, account)
  if (JSON.stringify(next) !== JSON.stringify(current)) write(next)
}

export function forgetAccount(email: string): void {
  write(readRecentAccounts().filter(a => a.email !== email.trim().toLowerCase()))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * The list, read through useSyncExternalStore so the server render (empty) and the first client
 * render agree, then storage takes over — the getting-started banner's pattern.
 */
export function useRecentAccounts(): RecentAccount[] {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try { return window.localStorage.getItem(KEY) ?? '' } catch { return '' }
    },
    () => '',
  )
  return useMemo(() => parse(raw), [raw])
}

/** Exported for the tests. */
export const __test = { parse, MAX }
