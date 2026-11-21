// A vehicle's statement review settings: materiality, the reviewer's own instructions, the
// accounts to watch every period and the adjustments they already know about. Cleaning is pure;
// loadSettings and saveSettings read and write statement_review_settings (service role).

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAmount } from '@/lib/admin-reporting/figures'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { CHECK_IDS, DEFAULT_SETTINGS, type CheckId, type KnownAdjustment, type ReviewSettings, type WatchedAccount } from './types'

export const MAX_INSTRUCTIONS = 8000
export const MAX_WATCHED = 100
export const MAX_ADJUSTMENTS = 100

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const pick = (o: any, camel: string, snake: string) => (o?.[camel] !== undefined ? o[camel] : o?.[snake])

function amountOf(v: unknown, what: string): number | undefined {
  const n = parseAmount(v === '' ? null : v)
  if (n === 'invalid') throw new Error(`${what} must be an amount`)
  return n == null ? undefined : n
}

/**
 * Settings as a caller gives them, merged over `current`: a field left out keeps its value, so the
 * assistant can change the instructions without restating the watch list. Snake or camel case.
 */
export function cleanSettings(input: any, current: ReviewSettings = DEFAULT_SETTINGS): ReviewSettings | string {
  if (!input || typeof input !== 'object') return 'settings are required'
  try {
    const out: ReviewSettings = { ...current }
    if (input.materiality !== undefined) {
      const m = input.materiality ?? {}
      const amount = amountOf(m.amount, 'materiality.amount') ?? 0
      let share = Number(pick(m, 'navShare', 'nav_share') ?? 0)
      if (!Number.isFinite(share) || share < 0) return 'materiality.nav_share must be a share of NAV: 0.005 for 0.5%'
      if (share > 1) share = share / 100
      if (amount < 0) return 'materiality.amount must be zero or more'
      out.materiality = { amount, navShare: share }
    }
    if (input.instructions !== undefined) {
      if (input.instructions !== null && typeof input.instructions !== 'string') return 'instructions must be text'
      out.instructions = (input.instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS)
    }
    const watch = pick(input, 'watchAccounts', 'watch_accounts')
    if (watch !== undefined) {
      if (!Array.isArray(watch)) return 'watch_accounts must be a list of { account, note?, threshold? }'
      if (watch.length > MAX_WATCHED) return `At most ${MAX_WATCHED} watched accounts.`
      out.watchAccounts = watch.map((w: any, i: number): WatchedAccount => {
        const account = text(typeof w === 'string' ? w : w?.account, 200)
        if (!account) throw new Error(`watch_accounts[${i}]: account is required (a code or a name)`)
        const note = text(w?.note, 1000)
        const threshold = amountOf(w?.threshold, `watch_accounts[${i}].threshold`)
        return { account, ...(note ? { note } : {}), ...(threshold != null ? { threshold: Math.abs(threshold) } : {}) }
      })
    }
    if (input.adjustments !== undefined) {
      if (!Array.isArray(input.adjustments)) return 'adjustments must be a list of { description, check?, subject?, amount?, tolerance? }'
      if (input.adjustments.length > MAX_ADJUSTMENTS) return `At most ${MAX_ADJUSTMENTS} known adjustments.`
      out.adjustments = input.adjustments.map((a: any, i: number): KnownAdjustment => {
        const at = `adjustments[${i}]`
        const description = text(a?.description, 1000)
        if (!description) throw new Error(`${at}: description is required`)
        const check = text(a?.check, 40)
        if (check && !CHECK_IDS.includes(check as CheckId)) throw new Error(`${at}: check must be one of ${CHECK_IDS.join(', ')}`)
        const subject = text(a?.subject, 300)
        const amount = amountOf(a?.amount, `${at}.amount`)
        const tolerance = amountOf(a?.tolerance, `${at}.tolerance`)
        if (!subject && amount == null) throw new Error(`${at}: give a subject (a partner, holding or statement) or an amount, so it explains only what it should`)
        return {
          description,
          ...(check ? { check: check as CheckId } : {}),
          ...(subject ? { subject } : {}),
          ...(amount != null ? { amount } : {}),
          ...(tolerance != null ? { tolerance: Math.abs(tolerance) } : {}),
        }
      })
    }
    return out
  } catch (e: any) {
    return e?.message ?? 'The settings could not be read.'
  }
}

/** A stored row as settings; anything unreadable falls back to the default. */
function fromRow(row: any): ReviewSettings {
  if (!row) return DEFAULT_SETTINGS
  const cleaned = cleanSettings({
    materiality: row.materiality ?? undefined,
    instructions: row.instructions ?? '',
    watch_accounts: row.watch_accounts ?? [],
    adjustments: row.adjustments ?? [],
  })
  return typeof cleaned === 'string' ? DEFAULT_SETTINGS : cleaned
}

export interface StoredSettings extends ReviewSettings {
  updatedAt: string | null
  updatedBy: string | null
}

export async function loadSettings(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<StoredSettings> {
  try {
    const { data, error } = await (admin as any).from('statement_review_settings')
      .select('materiality, instructions, watch_accounts, adjustments, updated_at, updated_by')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
    if (error || !data) return { ...DEFAULT_SETTINGS, updatedAt: null, updatedBy: null }
    return { ...fromRow(data), updatedAt: data.updated_at ?? null, updatedBy: data.updated_by ?? null }
  } catch {
    return { ...DEFAULT_SETTINGS, updatedAt: null, updatedBy: null }
  }
}

export async function saveSettings(
  admin: SupabaseClient, ctx: { fundId: string; userId: string | null }, vehicleId: string, input: unknown,
): Promise<Outcome<StoredSettings>> {
  const current = await loadSettings(admin, ctx.fundId, vehicleId)
  const cleaned = cleanSettings(input, current)
  if (typeof cleaned === 'string') return fail(400, cleaned)
  const now = new Date().toISOString()
  const { error } = await (admin as any).from('statement_review_settings').upsert({
    fund_id: ctx.fundId,
    vehicle_id: vehicleId,
    materiality: cleaned.materiality,
    instructions: cleaned.instructions,
    watch_accounts: cleaned.watchAccounts,
    adjustments: cleaned.adjustments,
    updated_by: ctx.userId,
    updated_at: now,
  }, { onConflict: 'vehicle_id' })
  if (error) return dbFail(error, 'statement-review-settings')
  return done({ ...cleaned, updatedAt: now, updatedBy: ctx.userId })
}
