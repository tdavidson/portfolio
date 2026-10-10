// "An Analyst proposal was just approved" — said to the rest of the page, so a view showing what it
// changed (the forecast page after a drafted plan) reloads without the person refreshing.

export const PENDING_ACTION_APPLIED = 'pending-action-applied'

export interface AppliedDetail {
  actionType: string
  result: unknown
}

export function announceApplied(detail: AppliedDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<AppliedDetail>(PENDING_ACTION_APPLIED, { detail }))
}

/** Subscribe; returns the unsubscribe. */
export function onApplied(handler: (detail: AppliedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => handler((e as CustomEvent<AppliedDetail>).detail)
  window.addEventListener(PENDING_ACTION_APPLIED, listener)
  return () => window.removeEventListener(PENDING_ACTION_APPLIED, listener)
}
