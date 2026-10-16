/**
 * Setting a fund up from a plan: the products it runs, its entities, its team with their access,
 * its authorized senders. What the web wizard and Settings do one screen at a time, applied in
 * one call, so an assistant (MCP `setup_fund`) or a script (`POST /api/agent`) can set a fund up
 * without the web app.
 *
 * Same code paths as the web wherever one exists: products go through `buildFeatureVisibility`
 * while the fund is still in the wizard, entities through `createFirstEntity` (which seeds the
 * chart), access through the presets and the end-date rules the access grid uses.
 *
 * Idempotent, so a plan can be re-run after a fix: entities match by name, team members by email,
 * senders by email. Each section reports what it did, and one failed row does not undo the rest.
 *
 * The caller must have checked that the actor is an admin of `fundId`. The tool is gated on the
 * `admin` domain, which only admins hold.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DOMAIN_META, type Domain } from '@/lib/access/domains'
import { getPreset, type PresetKey, ACCESS_PRESETS } from '@/lib/access/presets'
import { accessExpiryProblem, normalizeExpiry } from '@/lib/access/expiry'
import { isProductActive, recommendedVisibilityForProduct, type ProductKey } from '@/lib/access/products'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey, type FeatureVisibilityMap } from '@/lib/types/features'
import { logActivity } from '@/lib/activity'
import { expireTag } from '@/lib/cache/tags'
import { buildFeatureVisibility, isWizardProduct, parseOnboardingRecord, WIZARD_PRODUCTS, type WizardProduct } from './wizard'
import {
  createFirstEntity, isMissingOnboardingColumn, parseFirstEntity, patchOnboardingRecord, stillOnboarding,
  type FirstEntityInput,
} from './wizard-server'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface TeamMemberInput {
  email: string
  role: 'admin' | 'member'
  preset: PresetKey | null
  /** YYYY-MM-DD or ISO; null for no end date. Members only. */
  accessEndsOn: string | null
  /** 'all', or entity names. */
  entities: 'all' | string[]
}

export interface SetupPlan {
  fundName?: string
  products?: WizardProduct[]
  entities?: FirstEntityInput[]
  team?: TeamMemberInput[]
  authorizedSenders?: { email: string; label: string | null }[]
  /** Run AI through the admin's own assistant, with no server key (lib/ai/capabilities.ts). */
  aiMode?: 'assistant'
  finish?: boolean
}

type RowStatus = 'created' | 'exists' | 'invited' | 'added' | 'updated' | 'error'

export interface SetupResult {
  fundName?: string
  products?: { mode: 'chosen' | 'added'; on: WizardProduct[] }
  entities: { name: string; status: RowStatus; id?: string; error?: string }[]
  team: { email: string; status: RowStatus; error?: string }[]
  authorizedSenders: { email: string; status: RowStatus; error?: string }[]
  /** Areas switched from "Admins only" to members, because someone on the team was granted them. */
  openedToMembers: string[]
  aiMode?: 'assistant'
  finished?: boolean
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSetupPlan(raw: unknown, now: Date = new Date()): SetupPlan | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'A setup plan is required.' }
  const r = raw as Record<string, unknown>
  const plan: SetupPlan = {}

  if (r.fundName !== undefined) {
    const name = typeof r.fundName === 'string' ? r.fundName.trim() : ''
    if (!name) return { error: 'fundName cannot be empty.' }
    if (name.length > 200) return { error: 'fundName is too long.' }
    plan.fundName = name
  }

  if (r.products !== undefined) {
    if (!Array.isArray(r.products) || !r.products.every(isWizardProduct)) {
      return { error: `products must be a list of: ${WIZARD_PRODUCTS.map(p => p.key).join(', ')}.` }
    }
    plan.products = Array.from(new Set(r.products as WizardProduct[]))
  }

  if (r.entities !== undefined) {
    if (!Array.isArray(r.entities)) return { error: 'entities must be a list.' }
    if (r.entities.length > 50) return { error: 'At most 50 entities in one plan.' }
    const entities: FirstEntityInput[] = []
    for (const e of r.entities) {
      const parsed = parseFirstEntity(e)
      if ('error' in parsed) return { error: `Entity ${JSON.stringify((e as any)?.name ?? e)}: ${parsed.error}` }
      entities.push(parsed)
    }
    plan.entities = entities
  }

  if (r.team !== undefined) {
    if (!Array.isArray(r.team)) return { error: 'team must be a list.' }
    if (r.team.length > 50) return { error: 'At most 50 team members in one plan.' }
    const team: TeamMemberInput[] = []
    const seen = new Set<string>()
    for (const t of r.team as Record<string, unknown>[]) {
      const email = typeof t?.email === 'string' ? t.email.trim().toLowerCase() : ''
      if (!EMAIL.test(email)) return { error: `Team member ${JSON.stringify(t?.email ?? '')}: a valid email is required.` }
      if (seen.has(email)) return { error: `${email} is listed twice.` }
      seen.add(email)
      const role = t.role === undefined ? 'member' : t.role
      if (role !== 'admin' && role !== 'member') return { error: `${email}: role must be admin or member.` }
      let preset: PresetKey | null = null
      if (t.preset !== undefined && t.preset !== null) {
        const p = getPreset(t.preset)
        if (!p) return { error: `${email}: preset must be one of ${ACCESS_PRESETS.map(x => x.key).join(', ')}.` }
        if (role === 'admin') return { error: `${email}: an admin has every area; a preset is for members.` }
        preset = p.key
      }
      let accessEndsOn: string | null = null
      if (t.accessEndsOn !== undefined && t.accessEndsOn !== null && t.accessEndsOn !== '') {
        const problem = accessExpiryProblem({ target: { role }, expiresAt: t.accessEndsOn, now })
        if (problem) return { error: `${email}: ${problem.error}` }
        accessEndsOn = normalizeExpiry(String(t.accessEndsOn))
      }
      let entities: 'all' | string[] = 'all'
      if (t.entities !== undefined && t.entities !== 'all') {
        if (!Array.isArray(t.entities) || !t.entities.every(n => typeof n === 'string' && n.trim())) {
          return { error: `${email}: entities must be "all" or a list of entity names.` }
        }
        entities = (t.entities as string[]).map(n => n.trim())
      }
      team.push({ email, role, preset, accessEndsOn, entities })
    }
    plan.team = team
  }

  if (r.authorizedSenders !== undefined) {
    if (!Array.isArray(r.authorizedSenders)) return { error: 'authorizedSenders must be a list.' }
    const senders: SetupPlan['authorizedSenders'] = []
    for (const s of r.authorizedSenders as unknown[]) {
      const obj = (typeof s === 'string' ? { email: s } : s) as Record<string, unknown>
      const email = typeof obj?.email === 'string' ? obj.email.trim().toLowerCase() : ''
      if (!EMAIL.test(email)) return { error: `Authorized sender ${JSON.stringify(obj?.email ?? s)}: a valid email is required.` }
      senders.push({ email, label: typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : null })
    }
    plan.authorizedSenders = senders
  }

  if (r.aiMode !== undefined) {
    // Only the no-key choice is made here: a server key is a secret, added in Settings or by the
    // bootstrap script, and saving one is what makes a fund 'server_key'.
    if (r.aiMode !== 'assistant') return { error: 'aiMode can only be "assistant" (no server key). A server key goes in the deployment\'s environment (ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY) or in Settings.' }
    plan.aiMode = 'assistant'
  }

  if (r.finish !== undefined) plan.finish = r.finish === true

  if (Object.keys(plan).length === 0) return { error: 'The plan is empty. Say what to set up.' }
  return plan
}

/** One line per thing the plan will do, for the approval preview. */
export function describeSetupPlan(plan: SetupPlan): string[] {
  const lines: string[] = []
  if (plan.fundName) lines.push(`Name the fund "${plan.fundName}"`)
  if (plan.products) lines.push(`Turn on: ${plan.products.map(p => WIZARD_PRODUCTS.find(w => w.key === p)!.label).join(', ') || 'nothing'}`)
  for (const e of plan.entities ?? []) lines.push(`Create the entity "${e.name}" (${e.kind}${e.vintageYear ? `, ${e.vintageYear}` : ''})`)
  for (const t of plan.team ?? []) {
    const access = t.role === 'admin' ? 'admin' : t.preset ? getPreset(t.preset)!.label : 'member with the fund defaults'
    const ends = t.accessEndsOn ? `, access ends ${t.accessEndsOn.slice(0, 10)}` : ''
    lines.push(`Add ${t.email} as ${access}${ends} (an invitation email is sent if they have no account)`)
  }
  if (plan.authorizedSenders?.length) lines.push(`Authorize ${plan.authorizedSenders.length} sender(s): ${plan.authorizedSenders.map(s => s.email).join(', ')}`)
  if (plan.aiMode === 'assistant') lines.push('Run AI through your own assistant, with no server key')
  if (plan.finish) lines.push('Mark setup as finished')
  return lines
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** revalidateTag outside a request (a script, a test) has no cache to expire. */
function expire(tag: string) {
  try { expireTag(tag) } catch { /* no request scope */ }
}

const PRODUCT_KEYS: Exclude<WizardProduct, 'management_company'>[] = ['portfolio_reporting', 'fund_operations', 'lp_reporting', 'investment_workflow']

/**
 * Products on a fund that already finished the wizard: turn on what the plan names and is off,
 * the same values Settings' "Turn on" writes, and never switch anything off.
 */
export function addProducts(current: FeatureVisibilityMap, products: readonly WizardProduct[]): FeatureVisibilityMap {
  const out = { ...current }
  for (const p of products) {
    if (p === 'management_company') {
      if (out.management_company === 'off' || out.management_company === 'hidden') out.management_company = 'admin'
      continue
    }
    if (isProductActive(p as ProductKey, out)) continue
    for (const [k, v] of Object.entries(recommendedVisibilityForProduct(p as ProductKey)) as [FeatureKey, any][]) {
      if (out[k] === 'off' || out[k] === 'hidden') out[k] = v
    }
  }
  return out
}

/** The feature switches that decide whether a member can hold this domain at all. */
function switchesFor(domain: Domain): FeatureKey[] {
  const meta = DOMAIN_META[domain]
  return meta.primaryFeature ? [meta.primaryFeature] : meta.features
}

async function findAuthUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await (admin as any).auth.admin.listUsers({ page, perPage: 1000 })
    if (error) return null
    const users = (data?.users ?? []) as { id: string; email?: string }[]
    const hit = users.find(u => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (users.length < 1000) return null
  }
  return null
}

export async function applySetupPlan(
  admin: SupabaseClient,
  ctx: { fundId: string; actorId: string },
  plan: SetupPlan,
): Promise<SetupResult> {
  const db = admin as any
  const { fundId, actorId } = ctx
  const result: SetupResult = { entities: [], team: [], authorizedSenders: [], openedToMembers: [], warnings: [] }

  const { data: settings } = await db.from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
  if (!settings) throw new Error('Fund settings not found.')
  let visibility: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, ...(settings.feature_visibility ?? {}) }
  let visibilityChanged = false

  // 1. The fund's name.
  if (plan.fundName) {
    const { error } = await db.from('funds').update({ name: plan.fundName }).eq('id', fundId)
    if (error) result.warnings.push('Could not rename the fund.')
    else result.fundName = plan.fundName
  }

  // 2. Products. The wizard's full choice while the fund is new; additive once it is set up.
  if (plan.products) {
    if (await stillOnboarding(db, fundId, settings)) {
      visibility = buildFeatureVisibility(plan.products)
      const update: Record<string, unknown> = { feature_visibility: visibility }
      if ('onboarding' in settings) update.onboarding = { ...(parseOnboardingRecord(settings.onboarding) ?? {}), products: plan.products }
      let { error } = await db.from('fund_settings').update(update).eq('fund_id', fundId)
      if (error && 'onboarding' in update && isMissingOnboardingColumn(error)) {
        delete update.onboarding
        ;({ error } = await db.from('fund_settings').update(update).eq('fund_id', fundId))
      }
      if (error) throw new Error('Could not save the products.')
      result.products = { mode: 'chosen', on: plan.products }
    } else {
      visibility = addProducts(visibility, plan.products)
      visibilityChanged = true
      result.products = { mode: 'added', on: plan.products }
      const off = PRODUCT_KEYS.filter(p => !plan.products!.includes(p) && isProductActive(p, visibility))
      if (off.length) result.warnings.push('This fund is already set up, so products not named in the plan were left on. Turn products off in Settings.')
    }
  }

  // 3. Entities, each with its chart seeded.
  for (const e of plan.entities ?? []) {
    if (e.kind === 'manco' && (visibility.management_company === 'off' || visibility.management_company === 'hidden')) {
      result.entities.push({ name: e.name, status: 'error', error: 'Turn on management_company to create a management company.' })
      continue
    }
    const created = await createFirstEntity(admin, fundId, e)
    result.entities.push(created.ok
      ? { name: e.name, status: created.created ? 'created' : 'exists', id: created.id }
      : { name: e.name, status: 'error', error: created.error })
  }

  // 4. Authorized senders: who may email company updates in.
  if (plan.authorizedSenders?.length) {
    const { data: existing } = await db.from('authorized_senders').select('email').eq('fund_id', fundId)
    const had = new Set(((existing ?? []) as { email: string }[]).map(s => s.email.toLowerCase()))
    const { error } = await db.from('authorized_senders').upsert(
      plan.authorizedSenders.map(s => ({ fund_id: fundId, email: s.email, label: s.label })),
      { onConflict: 'fund_id,email' },
    )
    for (const s of plan.authorizedSenders) {
      result.authorizedSenders.push(error ? { email: s.email, status: 'error', error: 'Could not save.' } : { email: s.email, status: had.has(s.email) ? 'exists' : 'created' })
    }
  }

  // 5. The team.
  if (plan.team?.length) {
    const { data: fund } = await db.from('funds').select('name').eq('id', fundId).maybeSingle()
    const { data: vehicles } = await db.from('fund_vehicles').select('id, name').eq('fund_id', fundId)
    const vehicleByName = new Map(((vehicles ?? []) as { id: string; name: string }[]).map(v => [v.name.toLowerCase(), v.id]))
    const opened = new Set<Domain>()

    for (const t of plan.team) {
      const row = await addTeamMember(admin, { fundId, actorId, fundName: fund?.name ?? 'your fund', vehicleByName }, t, result.warnings)
      result.team.push(row)
      if (row.status === 'error' || t.role !== 'member' || !t.preset) continue
      // A member granted an area the fund keeps "Admins only" would hold an inert grant. Open the
      // area to members, and make its default for everyone else "none" so nobody but the people
      // granted it gains anything.
      for (const [domain, level] of Object.entries(getPreset(t.preset)!.grants) as [Domain, string][]) {
        if (level === 'none') continue
        for (const key of switchesFor(domain)) {
          if (visibility[key] === 'admin') {
            visibility[key] = 'everyone'
            visibilityChanged = true
            opened.add(domain)
          } else if (visibility[key] === 'off' || visibility[key] === 'hidden') {
            result.warnings.push(`${t.email} has ${DOMAIN_META[domain].label} in their preset, but that product is off, so it does nothing until it is turned on.`)
          }
        }
      }
    }
    for (const domain of opened) {
      await db.from('fund_domain_defaults').upsert(
        { fund_id: fundId, domain, level: 'none', updated_at: new Date().toISOString(), updated_by: actorId },
        { onConflict: 'fund_id,domain' },
      )
      result.openedToMembers.push(DOMAIN_META[domain].label)
    }
    result.warnings = Array.from(new Set(result.warnings))
    expire('membership')
    expire('domain-grants')
  }

  if (visibilityChanged) {
    const { error } = await db.from('fund_settings').update({ feature_visibility: visibility }).eq('fund_id', fundId)
    if (error) result.warnings.push('Could not save the product switches.')
    expire('fund-settings')
  }

  // 6. How AI runs here.
  if (plan.aiMode) {
    const { error } = await db.from('fund_settings').update({ ai_mode: plan.aiMode }).eq('fund_id', fundId)
    if (error) result.warnings.push(error.code === '42703'
      ? 'Could not record the AI choice: the database needs the latest migrations (supabase db push).'
      : 'Could not record the AI choice.')
    else result.aiMode = plan.aiMode
    expire('fund-settings')
  }

  // 7. Done.
  if (plan.finish) {
    const res = await patchOnboardingRecord(admin, fundId, rec => ({ ...rec, completed_at: rec.completed_at ?? new Date().toISOString() }))
    result.finished = res.ok
  }

  return result
}

/**
 * One person: allowed to sign up, invited if they have no account, made a member of this fund
 * with their role, preset, entities and end date. Re-running updates an existing member of this
 * fund; someone who belongs to another fund is refused (one fund per user).
 */
async function addTeamMember(
  admin: SupabaseClient,
  ctx: { fundId: string; actorId: string; fundName: string; vehicleByName: Map<string, string> },
  t: TeamMemberInput,
  warnings: string[],
): Promise<SetupResult['team'][number]> {
  const db = admin as any
  const { fundId, actorId } = ctx

  // The signup gate (hook_before_user_created) refuses anyone not on the allow-list.
  const { error: allowError } = await db.from('allowed_signups').insert({ email_pattern: t.email })
  if (allowError && allowError.code !== '23505') return { email: t.email, status: 'error', error: 'Could not add them to the signup allow-list.' }

  let userId = await findAuthUserId(admin, t.email)
  let invited = false
  if (!userId) {
    const { data, error } = await db.auth.admin.inviteUserByEmail(t.email, { data: { fund_name: ctx.fundName } })
    if (error || !data?.user?.id) return { email: t.email, status: 'error', error: `Could not send the invitation: ${error?.message ?? 'no user created'}` }
    userId = data.user.id as string
    invited = true
  }

  const { data: membership } = await db.from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
  let status: RowStatus
  if (membership && membership.fund_id !== fundId) {
    return { email: t.email, status: 'error', error: 'They already belong to another fund.' }
  } else if (membership) {
    if (membership.role === 'viewer') return { email: t.email, status: 'error', error: 'The demo account cannot be changed.' }
    if (userId === actorId && t.role !== 'admin') return { email: t.email, status: 'error', error: 'You cannot change your own role.' }
    if (membership.role !== t.role) {
      const { error } = await db.from('fund_members').update({ role: t.role }).eq('fund_id', fundId).eq('user_id', userId)
      if (error) return { email: t.email, status: 'error', error: 'Could not change their role.' }
    }
    status = 'updated'
  } else {
    const { error } = await db.from('fund_members').insert({
      fund_id: fundId, user_id: userId, invited_by: actorId, role: t.role, all_entities: t.entities === 'all',
    })
    if (error) return { email: t.email, status: 'error', error: 'Could not add them to the fund.' }
    status = invited ? 'invited' : 'added'
  }

  if (t.role === 'member') {
    if (status === 'updated') {
      await db.from('fund_members').update({ all_entities: t.entities === 'all' }).eq('fund_id', fundId).eq('user_id', userId)
    }
    if (Array.isArray(t.entities)) {
      const ids: string[] = []
      for (const name of t.entities) {
        const id = ctx.vehicleByName.get(name.toLowerCase())
        if (id) ids.push(id)
        else warnings.push(`${t.email}: there is no entity named "${name}".`)
      }
      if (ids.length) {
        await db.from('fund_member_vehicles').upsert(
          ids.map(vehicle_id => ({ fund_id: fundId, user_id: userId, vehicle_id, granted_by: actorId })),
          { onConflict: 'fund_id,user_id,vehicle_id', ignoreDuplicates: true },
        )
      }
    }
    if (t.preset) {
      const now = new Date().toISOString()
      const { error } = await db.from('fund_member_access').upsert(
        (Object.entries(getPreset(t.preset)!.grants) as [Domain, string][]).map(([domain, level]) => ({
          fund_id: fundId, user_id: userId, domain, level, updated_at: now, updated_by: actorId,
        })),
        { onConflict: 'fund_id,user_id,domain' },
      )
      if (error) warnings.push(`${t.email}: could not apply the ${t.preset} preset.`)
    }
    if (t.accessEndsOn) {
      const { error } = await db.from('fund_members').update({ access_expires_at: t.accessEndsOn }).eq('fund_id', fundId).eq('user_id', userId)
      if (error) warnings.push(error.code === '42703'
        ? `${t.email}: end dates need the latest database migration; their access has no end date yet.`
        : `${t.email}: could not set their end date.`)
    }
  }

  logActivity(admin, fundId, actorId, 'access.member_added', { member: userId, role: t.role, preset: t.preset, invited })
  return { email: t.email, status }
}
