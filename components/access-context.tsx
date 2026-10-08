'use client'

// The client's view of what the signed-in user may reach.
//
// It carries the resolver's INPUTS (role, feature switches, grants, defaults) rather than a
// precomputed answer per domain, and runs the very same `effectiveAccess` the server does. That
// isn't purity for its own sake — a precomputed map has to pick one feature key per domain, and
// several domains span more than one (`relationships` covers interactions AND notes;
// `lp_capital` covers lps AND lp_tracking). Collapsing them made the nav hide pages the user could
// actually open, because it answered a question nobody asked.
//
// Client-side checks are for AFFORDANCES ONLY — showing a panel, keeping a nav item. Nothing here
// is a security boundary: the middleware gates every API call against the same resolver, so hiding
// a control only spares the user something that would 403. That is the point of the split, and it
// is why "hidden = gone from the sidebar, still reachable by URL" was a bug rather than a feature.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Domain } from '@/lib/access/domains'
import { effectiveAccess, type AccessContext, type AccessLevel } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey, type FeatureVisibilityMap } from '@/lib/types/features'

/** The resolver's inputs, minus the ids the client has no use for. */
export type ClientAccess = Pick<AccessContext, 'role' | 'features' | 'grants' | 'defaults'>

// Defaults to a member with nothing, deliberately. If this fails to reach a component the failure
// mode is "the panel is missing", not "the partners' carry is on screen".
const EMPTY: ClientAccess = {
  role: 'member',
  features: DEFAULT_FEATURE_VISIBILITY as FeatureVisibilityMap,
  grants: {},
  defaults: {},
}

const AccessCtx = createContext<ClientAccess>(EMPTY)

export function AccessProvider({ value, children }: { value: ClientAccess; children: ReactNode }) {
  return <AccessCtx.Provider value={value}>{children}</AccessCtx.Provider>
}

/** The resolver, bound to the current user. `feature` where the domain spans several switches. */
export function useAccess(): (domain: Domain, feature?: FeatureKey) => AccessLevel {
  const value = useContext(AccessCtx)
  return useMemo(() => {
    // The client decides only what to SHOW by domain; entity scoping happens on the server, which
    // filters the data itself. So the client context claims no entities rather than guessing.
    const ctx: AccessContext = { fundId: '', userId: '', vehicles: { all: false, ids: [] }, ...value }
    return (domain: Domain, feature?: FeatureKey) => effectiveAccess(ctx, domain, feature)
  }, [value])
}

/** Can the user at least read this domain? */
export function useCanRead(domain: Domain, feature?: FeatureKey): boolean {
  const access = useAccess()
  const level = access(domain, feature)
  return level === 'read' || level === 'write'
}

/** Is the user a fund admin? For affordances only; the routes enforce it. */
export function useIsAdmin(): boolean {
  return useContext(AccessCtx).role === 'admin'
}

/** Can the user change things in this domain? */
export function useCanWrite(domain: Domain, feature?: FeatureKey): boolean {
  return useAccess()(domain, feature) === 'write'
}
