// Who may open a feature that is on: every member (subject to their grants) or admins only.
//
// The MCP side of Settings' Feature visibility cards, for setup_fund's `featureAccess`. It only
// moves a feature between 'everyone' and 'admin'. Turning a feature or product off, or on, stays a
// product decision (setup_fund's `products`, or Settings), so a chat cannot switch an area off
// for the whole fund by mistake.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_FEATURE_VISIBILITY,
  type FeatureKey,
  type FeatureVisibilityMap,
} from '@/lib/types/features'
import { expireTag } from '@/lib/cache/tags'

export type FeatureAccessLevel = 'everyone' | 'admin'
export type FeatureAccessChange = Partial<Record<FeatureKey, FeatureAccessLevel>>

export const FEATURE_KEYS = Object.keys(DEFAULT_FEATURE_VISIBILITY) as FeatureKey[]

export function parseFeatureAccess(raw: unknown): FeatureAccessChange | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'featureAccess must be an object such as { "inbound": "admin" }.' }
  }
  const out: FeatureAccessChange = {}
  for (const [key, level] of Object.entries(raw as Record<string, unknown>)) {
    if (!FEATURE_KEYS.includes(key as FeatureKey)) {
      return { error: `Unknown feature "${key}". Features: ${FEATURE_KEYS.join(', ')}.` }
    }
    if (level !== 'everyone' && level !== 'admin') {
      return { error: `featureAccess.${key} must be "everyone" or "admin".` }
    }
    out[key as FeatureKey] = level
  }
  if (Object.keys(out).length === 0) return { error: 'featureAccess names no feature.' }
  return out
}

/** The stored map with every key filled in, as the app reads it. */
export function visibilityOf(stored: Partial<FeatureVisibilityMap> | null | undefined): FeatureVisibilityMap {
  return { ...DEFAULT_FEATURE_VISIBILITY, ...(stored ?? {}) }
}

/**
 * Apply a change to a visibility map. A feature that is off is left off and reported: opening it is
 * turning it on, which is the product choice this does not make.
 */
export function applyFeatureAccess(
  current: FeatureVisibilityMap,
  change: FeatureAccessChange,
): { visibility: FeatureVisibilityMap; changed: FeatureAccessChange; refused: FeatureKey[] } {
  const visibility = { ...current }
  const changed: FeatureAccessChange = {}
  const refused: FeatureKey[] = []
  for (const [key, level] of Object.entries(change) as [FeatureKey, FeatureAccessLevel][]) {
    const now = visibility[key]
    if (now === 'off' || now === 'hidden') {
      refused.push(key)
      continue
    }
    if (now !== level) {
      visibility[key] = level
      changed[key] = level
    }
  }
  return { visibility, changed, refused }
}

export async function saveFeatureAccess(
  admin: SupabaseClient,
  fundId: string,
  change: FeatureAccessChange,
): Promise<{ featureAccess: Record<string, string>; changed: FeatureAccessChange; warnings: string[] }> {
  const db = admin as any
  const { data: settings, error } = await db.from('fund_settings').select('feature_visibility').eq('fund_id', fundId).maybeSingle()
  if (error || !settings) throw new Error('Fund settings not found.')
  const { visibility, changed, refused } = applyFeatureAccess(visibilityOf(settings.feature_visibility), change)
  if (Object.keys(changed).length > 0) {
    const { error: saveError } = await db.from('fund_settings').update({ feature_visibility: visibility }).eq('fund_id', fundId)
    if (saveError) throw new Error('Could not save who may open those features.')
    try { expireTag('fund-settings') } catch { /* no request scope (a script, a test) */ }
  }
  return {
    featureAccess: Object.fromEntries(Object.keys(change).map(k => [k, visibility[k as FeatureKey]])),
    changed,
    warnings: refused.map(k => `${k} is off for this fund, so it was left off. Turn its product on first (setup_fund products, or Settings).`),
  }
}
