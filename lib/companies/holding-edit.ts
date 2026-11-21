// Editing a holding's record (its name, aliases, status, contact emails, profile and which optional
// page sections it shows: metrics, the AI analyst, a price feed) and what kind
// of holding it is, for the `update_company` and `set_holding_type` agent tools and the chat's
// staged `update_company` action.
//
// A rename also renames the holding's own chart accounts ("Investment — <name>" and the rest, made
// by lib/accounting/investments.ts ensureInvestmentAccounts), so the trial balance reads the same
// name as the portfolio. Only accounts still carrying the old name are touched: one renamed by hand
// keeps its name.
//
// The holding type decides which page owns the record. A company becoming a fund holding gains a
// register (terms, notices, NAV statements); a fund holding becoming a company is refused while it
// has one, because the register would keep owning its transactions (clear_fund_register removes it).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { mergeGroupsForWrite } from '@/lib/access/scope'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export type HoldingType = 'company' | 'fund' | 'crypto'
const HOLDING_TYPES: HoldingType[] = ['company', 'fund', 'crypto']
const STATUSES = ['active', 'exited', 'written-off']

const ACCOUNT_PREFIXES = ['Investment', 'Unrealized', 'FX translation', 'Accrued interest', 'Realized gain']

/** A list field: `set` replaces it, `add` and `remove` change the one already there. */
export interface ListChange {
  set?: string[]
  add?: string[]
  remove?: string[]
}

export interface CompanyChange {
  name?: string
  status?: string
  aliases?: ListChange
  tags?: ListChange
  industry?: ListChange
  /** The addresses its updates come from, so emailed updates match it. Lowercased. */
  contactEmails?: ListChange
  /** The entities that hold it (portfolio_group), by name. Each must already exist. */
  vehicles?: ListChange
  stage?: string | null
  country?: string | null
  foundedYear?: number | null
  overview?: string | null
  founders?: string | null
  whyInvested?: string | null
  currentUpdate?: string | null
  notes?: string | null
  /** Page sections, as the edit dialog's switches set them. */
  metricsEnabled?: boolean
  analystEnabled?: boolean
  priceFeedEnabled?: boolean
}

// The profile's free-text fields: the change's key, then the column. Blank clears it.
const TEXT_FIELDS = [
  ['stage', 'stage'], ['country', 'country'], ['overview', 'overview'], ['founders', 'founders'],
  ['whyInvested', 'why_invested'], ['currentUpdate', 'current_update'], ['notes', 'notes'],
] as const

const LIST_FIELDS = [
  ['aliases', 'aliases'], ['tags', 'tags'], ['industry', 'industry'], ['contactEmails', 'contact_email'],
] as const

const COMPANY_COLUMNS = 'id, name, status, holding_type, portfolio_group, aliases, tags, industry, contact_email, stage, country, founded_year, overview, founders, why_invested, current_update, notes, metrics_enabled, analyst_enabled, price_feed_enabled'

// The page-section switches: the change's key, then the column.
const SECTION_FIELDS = [
  ['metricsEnabled', 'metrics_enabled'], ['analystEnabled', 'analyst_enabled'], ['priceFeedEnabled', 'price_feed_enabled'],
] as const

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

const cleanList = (list: unknown): string[] => (Array.isArray(list) ? list : [])
  .filter((a): a is string => typeof a === 'string' && !!a.trim()).map(a => a.trim())

function applyList(current: unknown, change: ListChange, emails: boolean): string[] | { error: string } {
  const norm = (list: unknown) => cleanList(list).map(x => (emails ? x.toLowerCase() : x))
  if (emails) {
    const bad = [...norm(change.set), ...norm(change.add)].find(e => !isEmail(e))
    if (bad) return { error: `"${bad}" is not an email address.` }
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const out: string[] = []
  for (const x of change.set !== undefined ? norm(change.set) : norm(current)) {
    if (!out.some(y => same(x, y))) out.push(x)
  }
  for (const x of norm(change.add)) if (!out.some(y => same(x, y))) out.push(x)
  const remove = norm(change.remove)
  return out.filter(x => !remove.some(r => same(x, r)))
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface CompanyChangePlan {
  company: { id: string; name: string }
  /** The columns that change, as they will be written. */
  updates: Record<string, unknown>
  /** The same columns as they are now. */
  before: Record<string, unknown>
}

/**
 * What a change would write, read against the company as it is now and written nowhere. The
 * staged preview shows it; the write re-plans against the live row, so an approval applies to what
 * is there when it is approved.
 */
export async function planCompanyChange(
  admin: SupabaseClient,
  who: { fundId: string; vehicleNames: string[] | null },
  companyId: string,
  change: CompanyChange,
): Promise<Outcome<CompanyChangePlan>> {
  const fundId = who.fundId
  const { data: company, error } = await (admin as any)
    .from('companies').select(COMPANY_COLUMNS).eq('id', companyId).eq('fund_id', fundId).maybeSingle()
  if (error) return dbFail(error, 'company-edit')
  if (!company) return fail(404, 'Company not found')

  const updates: Record<string, unknown> = {}
  const name = change.name?.trim()
  if (change.name !== undefined && !name) return fail(400, 'Name cannot be empty.')
  if (name && name !== company.name) updates.name = name

  if (change.status !== undefined) {
    if (!STATUSES.includes(change.status)) return fail(400, `status must be one of: ${STATUSES.join(', ')}.`)
    updates.status = change.status
  }

  for (const [key, column] of TEXT_FIELDS) {
    const v = change[key]
    if (v === undefined) continue
    updates[column] = typeof v === 'string' && v.trim() ? v.trim() : null
  }

  for (const [key, column] of SECTION_FIELDS) {
    const v = change[key]
    if (v === undefined) continue
    if (typeof v !== 'boolean') return fail(400, `${column} must be true or false.`)
    if (column === 'price_feed_enabled' && company.holding_type === 'fund') {
      return fail(400, 'A fund holding is valued from its NAV statements, not a price feed.')
    }
    updates[column] = v
  }

  if (change.foundedYear !== undefined) {
    const y = change.foundedYear === null ? null : Number(change.foundedYear)
    if (y !== null && (!Number.isInteger(y) || y < 1800 || y > 2100)) return fail(400, 'founded_year must be a year, like 2019.')
    updates.founded_year = y
  }

  for (const [key, column] of LIST_FIELDS) {
    const c = change[key]
    if (!c || (c.set === undefined && c.add === undefined && c.remove === undefined)) continue
    const next = applyList(company[column], c, key === 'contactEmails')
    if ('error' in next) return fail(400, next.error)
    updates[column] = next
  }

  const v = change.vehicles
  if (v && (v.set !== undefined || v.add !== undefined || v.remove !== undefined)) {
    const groups = await planVehicles(admin, who, cleanList(company.portfolio_group), v)
    if (!groups.ok) return groups
    updates.portfolio_group = groups.value
  }

  // The name it goes by is not an alias of itself.
  const finalName = String((updates.name as string | undefined) ?? company.name)
  if (updates.aliases || updates.name) {
    const aliases = ((updates.aliases as string[] | undefined) ?? cleanList(company.aliases))
      .filter(a => a.toLowerCase() !== finalName.toLowerCase())
    if (updates.aliases || !sameValue(aliases, cleanList(company.aliases))) updates.aliases = aliases
  }

  // Only what actually differs is written, so "set it to what it already is" is nothing to change.
  for (const column of Object.keys(updates)) {
    const now = company[column]
    const was = Array.isArray(updates[column]) ? cleanList(now) : (now ?? null)
    if (sameValue(was, updates[column])) delete updates[column]
  }
  if (Object.keys(updates).length === 0) return fail(400, 'Nothing to change.')

  const before = Object.fromEntries(Object.keys(updates).map(k => [k, company[k] ?? null]))
  return done({ company: { id: company.id, name: company.name }, updates, before })
}

/**
 * The tools' snake_case input as a change: `<list>` replaces a list, `add_<list>` and
 * `remove_<list>` change it. A field left out is left alone; null or "" clears a text field.
 */
export function companyChangeFromInput(input: any): CompanyChange {
  const change: CompanyChange = {}
  if (input?.name !== undefined) change.name = String(input.name ?? '')
  if (input?.status !== undefined) change.status = String(input.status)
  const list = (key: string): ListChange | undefined => {
    const c: ListChange = {}
    if (input?.[key] !== undefined) c.set = cleanList(input[key])
    if (input?.[`add_${key}`] !== undefined) c.add = cleanList(input[`add_${key}`])
    if (input?.[`remove_${key}`] !== undefined) c.remove = cleanList(input[`remove_${key}`])
    return Object.keys(c).length ? c : undefined
  }
  const lists = { aliases: list('aliases'), tags: list('tags'), industry: list('industry'), contactEmails: list('contact_emails'), vehicles: list('vehicles') }
  for (const [k, v] of Object.entries(lists)) if (v) (change as any)[k] = v
  const text = { stage: 'stage', country: 'country', overview: 'overview', founders: 'founders', whyInvested: 'why_invested', currentUpdate: 'current_update', notes: 'notes' }
  for (const [k, key] of Object.entries(text)) {
    if (input?.[key] !== undefined) (change as any)[k] = input[key] === null ? null : String(input[key])
  }
  const sections = { metricsEnabled: 'metrics_enabled', analystEnabled: 'analyst_enabled', priceFeedEnabled: 'price_feed_enabled' }
  for (const [k, key] of Object.entries(sections)) {
    const v = input?.[key]
    if (v === undefined || v === null) continue
    // A connector may send "true"/"false" as text; anything else is refused by the plan.
    (change as any)[k] = v === 'true' ? true : v === 'false' ? false : v
  }
  if (input?.founded_year !== undefined) change.foundedYear = input.founded_year === null || input.founded_year === '' ? null : Number(input.founded_year)
  return change
}

/**
 * The entities that will hold it. A member changes only their own entities' part, as the company
 * page does (mergeGroupsForWrite): the ones they cannot see are kept, and naming one is refused.
 * Unlike the page, a name that is not already an entity is refused rather than created, so a typo
 * in a chat does not make a new entity.
 */
async function planVehicles(
  admin: SupabaseClient,
  who: { fundId: string; vehicleNames: string[] | null },
  current: string[],
  change: ListChange,
): Promise<Outcome<string[]>> {
  const { data, error } = await (admin as any).from('fund_vehicles').select('name').eq('fund_id', who.fundId)
  if (error) return dbFail(error, 'company-edit')
  const known = ((data as { name: string }[]) ?? []).map(r => r.name)
  const canonical = (list: string[] | undefined): string[] | { error: string } => {
    const out: string[] = []
    for (const n of list ?? []) {
      const hit = known.find(k => k.toLowerCase() === n.toLowerCase())
      if (!hit) return { error: `No entity named "${n}".` }
      out.push(hit)
    }
    return out
  }
  const named = [canonical(change.set), canonical(change.add), canonical(change.remove)]
  const bad = named.find(x => 'error' in x) as { error: string } | undefined
  if (bad) return fail(400, bad.error)
  const [set, add, remove] = named as string[][]
  const mine = who.vehicleNames === null ? current : current.filter(g => who.vehicleNames!.includes(g))
  const next = applyList(mine, { ...(change.set !== undefined ? { set } : {}), add, remove }, false)
  if ('error' in next) return fail(400, next.error)
  const merged = mergeGroupsForWrite(current, next, who.vehicleNames)
  if ('error' in merged) return fail(403, merged.error)
  return done(merged.groups)
}

export async function updateCompanyDetails(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null; vehicleNames: string[] | null },
  companyId: string,
  change: CompanyChange,
): Promise<Outcome<{
  id: string; name: string; previousName: string; aliases: string[]; status: string | null
  changed: Record<string, { from: unknown; to: unknown }>; accountsRenamed: number
}>> {
  const planned = await planCompanyChange(admin, who, companyId, change)
  if (!planned.ok) return planned
  const { company, updates, before } = planned.value

  const { error: updateError } = await (admin as any).from('companies').update(updates).eq('id', companyId).eq('fund_id', who.fundId)
  if (updateError) return dbFail(updateError, 'company-edit')

  let accountsRenamed = 0
  if (updates.name) {
    const { data: accounts } = await (admin as any)
      .from('chart_of_accounts').select('id, name').eq('fund_id', who.fundId).eq('company_id', companyId)
    for (const a of (accounts as any[]) ?? []) {
      const prefix = ACCOUNT_PREFIXES.find(p => a.name === `${p} — ${company.name}`)
      if (!prefix) continue
      const { error: renameError } = await (admin as any).from('chart_of_accounts')
        .update({ name: `${prefix} — ${updates.name}` }).eq('id', a.id).eq('fund_id', who.fundId)
      if (!renameError) accountsRenamed++
    }
  }

  const { data: after } = await (admin as any)
    .from('companies').select('name, aliases, status').eq('id', companyId).eq('fund_id', who.fundId).maybeSingle()

  if (who.userId) logActivity(admin, who.fundId, who.userId, 'company.update', { companyId })
  return done({
    id: companyId,
    name: after?.name ?? (updates.name as string | undefined) ?? company.name,
    previousName: company.name,
    aliases: cleanList(after?.aliases),
    status: after?.status ?? null,
    changed: Object.fromEntries(Object.keys(updates).map(k => [k, { from: before[k], to: updates[k] }])),
    accountsRenamed,
  })
}

export async function setHoldingType(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null },
  companyId: string,
  type: HoldingType,
): Promise<Outcome<{ id: string; name: string; from: HoldingType; to: HoldingType }>> {
  if (!HOLDING_TYPES.includes(type)) return fail(400, `holding_type must be one of: ${HOLDING_TYPES.join(', ')}.`)
  const { data: company, error } = await (admin as any)
    .from('companies').select('id, name, holding_type').eq('id', companyId).eq('fund_id', who.fundId).maybeSingle()
  if (error) return dbFail(error, 'company-holding-type')
  if (!company) return fail(404, 'Company not found')
  const from = (company.holding_type ?? 'company') as HoldingType
  if (from === type) return fail(400, `${company.name} is already a ${type === 'fund' ? 'fund holding' : type === 'crypto' ? 'digital asset' : 'company'}.`)

  if (from === 'fund') {
    const counts = await Promise.all(['fund_capital_events', 'fund_nav_statements'].map(t =>
      (admin as any).from(t).select('id', { count: 'exact', head: true }).eq('fund_id', who.fundId).eq('company_id', companyId)))
    const failed = counts.find(c => c.error)
    if (failed) return dbFail(failed.error, 'company-holding-type')
    const n = counts.reduce((s, c) => s + (c.count ?? 0), 0)
    if (n > 0) {
      return fail(409, `${company.name} has ${n} capital notice(s) and NAV statement(s) in its fund register. `
        + 'Change it first, then clear the register with clear_fund_register.')
    }
  }
  if (type === 'crypto' || from === 'crypto') {
    // A digital asset carries wallets and a price feed the other kinds do not have.
    return fail(400, 'Changing to or from a digital asset is done on the company page.')
  }

  const { error: updateError } = await (admin as any)
    .from('companies').update({ holding_type: type }).eq('id', companyId).eq('fund_id', who.fundId)
  if (updateError) return dbFail(updateError, 'company-holding-type')

  if (who.userId) logActivity(admin, who.fundId, who.userId, 'company.holding_type', { companyId, from, to: type })
  return done({ id: companyId, name: company.name, from, to: type })
}
