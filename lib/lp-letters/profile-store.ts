// Reading and saving letter profiles (profile.ts) and finding an entity's last sent letter.
//
// Profiles are service-role only (20261106090000): every caller here has already passed the
// lp_relations / lp_letters gate, and a caller limited to some entities only reaches theirs.

import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanProfile, mergeProfiles, type LetterProfile } from './profile'
import { investorText } from './internal'
import { fromLetter } from './content'
import { hasStructuredContent } from './document'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'

type Admin = SupabaseClient

async function vehicleIdOf(admin: Admin, fundId: string, vehicle: string): Promise<string | null> {
  const { data } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', fundId).eq('name', vehicle).maybeSingle()
  return data?.id ?? null
}

async function rowOf(admin: Admin, fundId: string, vehicleId: string | null) {
  let q = (admin as any).from('lp_letter_profiles').select('*').eq('fund_id', fundId)
  q = vehicleId ? q.eq('vehicle_id', vehicleId) : q.is('vehicle_id', null)
  const { data, error } = await q.maybeSingle()
  // Before the migration the table is missing: no profile, as for a fund that never saved one.
  if (error) return null
  return data
}

export interface LoadedProfile {
  /** What the letter uses: the entity's own over the firm-wide one. */
  profile: LetterProfile
  /** Each as stored, for the editor. */
  own: LetterProfile | null
  firm: LetterProfile | null
  updated_at: string | null
}

/** An entity's profile (vehicle name), or the firm-wide one (null). */
export async function loadProfile(admin: Admin, fundId: string, vehicle: string | null): Promise<LoadedProfile> {
  const vehicleId = vehicle ? await vehicleIdOf(admin, fundId, vehicle) : null
  const [firmRow, ownRow] = await Promise.all([
    rowOf(admin, fundId, null),
    vehicleId ? rowOf(admin, fundId, vehicleId) : Promise.resolve(null),
  ])
  const firm = firmRow ? cleanProfile(firmRow) : null
  const own = ownRow ? cleanProfile(ownRow) : null
  return { profile: mergeProfiles(firm, vehicle ? own : null), own: vehicle ? own : firm, firm, updated_at: (vehicle ? ownRow : firmRow)?.updated_at ?? null }
}

/** Save an entity's profile (vehicle name) or the firm-wide one (null), replacing what was there. */
export async function saveProfile(
  admin: Admin, ctx: { fundId: string; userId: string | null; visible: string[] | null }, vehicle: string | null, input: unknown,
  opts: { seededFrom?: string | null } = {},
): Promise<Outcome<LoadedProfile>> {
  if (vehicle && ctx.visible !== null && !ctx.visible.includes(vehicle)) return fail(404, 'Not found')
  // The firm-wide profile speaks for every entity, so only someone who sees them all may change it.
  if (!vehicle && ctx.visible !== null) return fail(403, 'Only a member who sees every entity can change the firm-wide letter profile.')
  const vehicleId = vehicle ? await vehicleIdOf(admin, ctx.fundId, vehicle) : null
  if (vehicle && !vehicleId) return fail(404, `No entity named "${vehicle}".`)
  const p = cleanProfile(input)
  if (p.template_id) {
    const { data: t } = await (admin as any).from('lp_letter_templates').select('id').eq('fund_id', ctx.fundId).eq('id', p.template_id).maybeSingle()
    if (!t) return fail(400, 'No such letter template in this fund.')
  }
  const existing = await rowOf(admin, ctx.fundId, vehicleId)
  // external_ids is written only once its column exists (a row read back with it) or when set, so a
  // save before migration 20261106150000 is applied still works for every other field.
  const { external_ids, ...fields } = p
  const row = {
    fund_id: ctx.fundId, vehicle_id: vehicleId, ...fields,
    ...(external_ids.length || (existing && 'external_ids' in existing) ? { external_ids } : {}),
    ...(opts.seededFrom ? { seeded_from_letter: opts.seededFrom } : {}),
    updated_at: new Date().toISOString(), updated_by: ctx.userId,
  }
  const { error } = existing
    ? await (admin as any).from('lp_letter_profiles').update(row).eq('id', existing.id).eq('fund_id', ctx.fundId)
    : await (admin as any).from('lp_letter_profiles').insert(row)
  if (error) return dbFail(error, 'lp-letter-profiles')
  return done(await loadProfile(admin, ctx.fundId, vehicle))
}

export interface LastLetter {
  id: string; period: string; text: string
  /** Its section headings, so a new draft without "## " marks can be split the same way. */
  headings?: string[]
}

const MAX_LAST_LETTER_CHARS = 30_000

/**
 * The entity's most recent final letter before this period: what was sent last time, as investors
 * read it (no partners' notes). Drafts are never what was sent.
 */
export async function lastFinalLetter(admin: Admin, fundId: string, vehicle: string, year: number, quarter: number): Promise<LastLetter | null> {
  const { data } = await (admin as any)
    .from('lp_letters')
    .select('id, period_label, period_year, period_quarter, full_draft, content, status')
    .eq('fund_id', fundId).eq('portfolio_group', vehicle).eq('status', 'final')
    .order('period_year', { ascending: false }).order('period_quarter', { ascending: false })
    .limit(20)
  const before = ((data ?? []) as any[]).find(l => l.period_year * 4 + l.period_quarter < year * 4 + quarter && l.full_draft)
  if (!before) return null
  const headings = hasStructuredContent(before)
    ? fromLetter(before).sections.map(s => s.heading).filter((h): h is string => !!h && h.length <= 120)
    : []
  return { id: before.id, period: before.period_label, text: investorText(before.full_draft).slice(0, MAX_LAST_LETTER_CHARS), ...(headings.length ? { headings } : {}) }
}

/** The names of the fund's companies this entity doesn't hold: a letter about it shouldn't name them. */
export async function otherEntitiesCompanies(admin: Admin, fundId: string, held: string[]): Promise<string[]> {
  const { data } = await (admin as any).from('companies').select('id, name').eq('fund_id', fundId).eq('holding_type', 'company')
  const mine = new Set(held)
  return ((data ?? []) as any[]).filter(c => !mine.has(c.id) && typeof c.name === 'string' && c.name.trim().length >= 3).map(c => c.name.trim())
}
