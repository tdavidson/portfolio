/**
 * Skipping Getting started steps, for the whole fund. One writer for the web page
 * (PATCH /api/onboarding/progress) and the `setup_fund` tool, so both store the same thing:
 * `fund_settings.onboarding.checklist_skipped`. Callers must have checked the admin role.
 *
 * A skip is a choice about the checklist, not about the data: a skipped step is still computed and
 * still shown (as skipped), and one the data says is done counts as done whatever was skipped.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isStepKey, type StepKey } from './progress'
import { patchOnboardingRecord } from './wizard-server'

export interface SkipChange {
  skip: StepKey[]
  unskip: StepKey[]
}

/** Validate `{ skip?: string[], unskip?: string[] }`. Unknown step keys are an error, not ignored. */
export function parseSkipChange(raw: unknown): SkipChange | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Expected { skip, unskip }.' }
  const r = raw as Record<string, unknown>
  const list = (v: unknown, field: string): StepKey[] | { error: string } => {
    if (v == null) return []
    if (!Array.isArray(v)) return { error: `${field} must be a list of step keys.` }
    const bad = v.filter(k => !isStepKey(k))
    if (bad.length) return { error: `Unknown step${bad.length === 1 ? '' : 's'} in ${field}: ${bad.map(String).join(', ')}.` }
    return [...new Set(v as StepKey[])]
  }
  const skip = list(r.skip, 'skip')
  if ('error' in skip) return skip
  const unskip = list(r.unskip, 'unskip')
  if ('error' in unskip) return unskip
  if (skip.length === 0 && unskip.length === 0) return { error: 'Name at least one step to skip or unskip.' }
  const both = skip.filter(k => unskip.includes(k))
  if (both.length) return { error: `A step cannot be skipped and unskipped at once: ${both.join(', ')}.` }
  return { skip, unskip }
}

/** The stored list after a change. Order carries no meaning: readers only test membership. */
export function applySkipChange(current: readonly StepKey[], change: SkipChange): StepKey[] {
  const next = new Set(current)
  for (const k of change.skip) next.add(k)
  for (const k of change.unskip) next.delete(k)
  return [...next]
}

export async function saveChecklistSkips(
  admin: SupabaseClient,
  fundId: string,
  change: SkipChange,
): Promise<{ ok: true; skipped: StepKey[] } | { ok: false; error: string }> {
  let skipped: StepKey[] = []
  const res = await patchOnboardingRecord(admin, fundId, current => {
    skipped = applySkipChange(current.checklist_skipped ?? [], change)
    return { ...current, checklist_skipped: skipped }
  })
  if (!res.ok) return res
  if (!res.persisted) {
    return { ok: false, error: 'Skips cannot be saved until the onboarding column migration is applied to this database.' }
  }
  return { ok: true, skipped }
}
