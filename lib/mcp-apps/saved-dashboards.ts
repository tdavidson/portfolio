// Saved dashboards: a name, a view and the arguments that produce it.
//
// WHY THEY LIVE HERE AND NOT IN THE ASSISTANT. Neither Claude nor ChatGPT keeps a rendered view
// beyond the conversation it appeared in, and a per-deployment plugin cannot carry state of its
// own. A row in this app's database is the one place a dashboard can persist that both assistants
// reach, that survives a new conversation, and that the fund owns.
//
// WHAT IS STORED IS A RECIPE, NEVER A RESULT. No figure is written down: opening a dashboard runs
// its view again, as the person opening it, through the same access check as calling the view's
// tool directly. So a shared dashboard cannot leak what its author could see: a colleague opening
// it gets their own figures or a refusal.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DASHBOARD_VIEWS, STATEMENT_PRESETS, VIEW_LABEL,
  type DashboardView, type SavedDashboardSummary,
} from './payload'

const TABLE = 'saved_dashboards'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const MAX_NAME_LENGTH = 80
/** Per member. A bookmark list, not a data store: a credential cannot be used to fill the table. */
export const MAX_SAVED_PER_USER = 50
const MAX_ARG_LENGTH = 200

export class SavedDashboardError extends Error {}

/** The string arguments each view accepts. Anything else in a saved recipe is dropped. */
const VIEW_ARGS: Record<DashboardView, { key: string; kind: 'text' | 'date' | 'preset'; required?: boolean }[]> = {
  portfolio: [{ key: 'vehicle', kind: 'text' }, { key: 'as_of', kind: 'date' }],
  company: [{ key: 'company', kind: 'text', required: true }, { key: 'vehicle', kind: 'text' }],
  statements: [
    { key: 'vehicle', kind: 'text' }, { key: 'period', kind: 'preset' },
    { key: 'start', kind: 'date' }, { key: 'end', kind: 'date' },
  ],
  lps: [{ key: 'vehicle', kind: 'text' }, { key: 'as_of', kind: 'date' }],
  // `call` is kept as given ("latest" by default), so a saved "latest call" stays the latest.
  calls: [{ key: 'vehicle', kind: 'text' }, { key: 'call', kind: 'text' }],
}

export function isDashboardView(v: unknown): v is DashboardView {
  return typeof v === 'string' && (DASHBOARD_VIEWS as readonly string[]).includes(v)
}

/**
 * Reduce a caller-supplied arguments object to the keys the view takes, each a bounded string.
 *
 * This runs on the way IN (save) and on the way OUT (open), so a row written by anything else
 * (a direct database edit, an older release) is still only ever replayed as known keys.
 */
export function sanitizeArguments(view: DashboardView, raw: unknown): Record<string, string> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, string> = {}
  for (const spec of VIEW_ARGS[view]) {
    const value = input[spec.key]
    if (value === undefined || value === null || value === '') {
      if (spec.required) throw new SavedDashboardError(`A ${VIEW_LABEL[view].toLowerCase()} dashboard needs "${spec.key}".`)
      continue
    }
    if (typeof value !== 'string') throw new SavedDashboardError(`"${spec.key}" must be text.`)
    const text = value.trim()
    if (text.length > MAX_ARG_LENGTH) throw new SavedDashboardError(`"${spec.key}" is too long.`)
    if (spec.kind === 'date' && !ISO_DATE.test(text)) throw new SavedDashboardError(`"${spec.key}" must be an ISO date (YYYY-MM-DD).`)
    if (spec.kind === 'preset' && !(STATEMENT_PRESETS as readonly string[]).includes(text)) {
      throw new SavedDashboardError(`"${spec.key}" must be one of: ${STATEMENT_PRESETS.join(', ')}.`)
    }
    out[spec.key] = text
  }
  return out
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new SavedDashboardError('A dashboard needs a name.')
  // Control characters out, runs of whitespace collapsed: the name is shown back in a list and
  // matched case-insensitively, and neither should depend on an invisible character.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) throw new SavedDashboardError('A dashboard needs a name.')
  if (name.length > MAX_NAME_LENGTH) throw new SavedDashboardError(`A dashboard name can be at most ${MAX_NAME_LENGTH} characters.`)
  return name
}

/**
 * The dashboards every member starts with: one per view that needs no argument. A company
 * dashboard needs a company, so it has no standard form.
 */
export const STANDARD_DASHBOARDS: SavedDashboardSummary[] = (['portfolio', 'statements', 'lps'] as const).map(view => ({
  id: `standard:${view}`,
  name: VIEW_LABEL[view],
  view,
  arguments: {},
  kind: 'standard' as const,
  updatedAt: null,
}))

interface Row {
  id: string
  user_id: string
  name: string
  view: string
  params: unknown
  shared: boolean
  updated_at: string | null
}

/**
 * True when the table is not there yet. The migration that creates it is applied by the
 * deployment's owner (`supabase db push`), so there is a window after a deploy in which this
 * code runs without it. In that window the standard dashboards still work and saving says why not.
 */
function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  const message = error.message ?? ''
  return /saved_dashboards/.test(message) && /does not exist|could not find|schema cache/i.test(message)
}

const MIGRATION_HINT = 'Saved dashboards are not set up on this deployment yet. An admin needs to apply the latest database migration.'

function toSummary(row: Row, userId: string): SavedDashboardSummary | null {
  if (!isDashboardView(row.view)) return null
  let args: Record<string, string>
  try {
    args = sanitizeArguments(row.view, row.params)
  } catch {
    return null
  }
  return {
    id: row.id,
    name: row.name,
    view: row.view,
    arguments: args,
    kind: row.user_id === userId ? 'mine' : 'shared',
    updatedAt: row.updated_at,
  }
}

/** The caller's own dashboards and the fund's shared ones, newest first. Standard ones not included. */
export async function listSaved(admin: SupabaseClient, fundId: string, userId: string): Promise<SavedDashboardSummary[]> {
  const columns = 'id, user_id, name, view, params, shared, updated_at'
  // Two plain reads rather than one `or(...)`: an `or` filter is a string the id would have to be
  // spliced into, and neither list is long.
  const [own, shared] = await Promise.all([
    (admin as any).from(TABLE).select(columns).eq('fund_id', fundId).eq('user_id', userId).limit(MAX_SAVED_PER_USER),
    (admin as any).from(TABLE).select(columns).eq('fund_id', fundId).eq('shared', true).limit(200),
  ])
  for (const { error } of [own, shared]) {
    if (!error) continue
    if (isMissingTable(error)) return []
    throw new SavedDashboardError('Could not read saved dashboards.')
  }
  // A shared dashboard outlives nothing: once its author leaves the fund it is no longer listed.
  // (The row is deleted with the account; this covers a member removed from the fund but not
  // deleted, whose dashboards nobody else could remove.)
  let sharedRows = ((shared.data as Row[]) ?? []).filter(row => row.user_id !== userId)
  if (sharedRows.length > 0) {
    const { data: members, error } = await (admin as any).from('fund_members').select('user_id').eq('fund_id', fundId)
    if (error) throw new SavedDashboardError('Could not read saved dashboards.')
    const current = new Set(((members as { user_id: string }[]) ?? []).map(m => m.user_id))
    sharedRows = sharedRows.filter(row => current.has(row.user_id))
  }

  const seen = new Set<string>()
  return [...((own.data as Row[]) ?? []), ...sharedRows]
    .filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .map(row => toSummary(row, userId))
    .filter((summary): summary is SavedDashboardSummary => summary !== null)
}

/** Everything `list_dashboards` returns: standard first, then the caller's, then shared. */
export async function listDashboards(admin: SupabaseClient, fundId: string, userId: string): Promise<SavedDashboardSummary[]> {
  const saved = await listSaved(admin, fundId, userId)
  return [
    ...STANDARD_DASHBOARDS,
    ...saved.filter(s => s.kind === 'mine'),
    ...saved.filter(s => s.kind === 'shared'),
  ]
}

/**
 * Resolve a reference (an id, or a name) to one dashboard the caller can open.
 *
 * `visible` is the caller's view of the list, and resolution happens INSIDE it: a dashboard the
 * caller may not see is not found, by name or by id, and is not named in an error. Without that,
 * "no dashboard called x. Available: ..." would recite exactly the shared dashboards that
 * `list_dashboards` withholds.
 *
 * The caller's own dashboard wins over a shared one of the same name, and a name that still
 * matches two shared dashboards is refused: picking one silently would open the wrong figures.
 */
export async function resolveDashboard(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  ref: unknown,
  visible: (dashboard: SavedDashboardSummary) => boolean = () => true,
): Promise<SavedDashboardSummary> {
  if (typeof ref !== 'string' || !ref.trim()) throw new SavedDashboardError('Say which dashboard: its id or its name.')
  const needle = ref.trim()
  const all = (await listDashboards(admin, fundId, userId)).filter(visible)

  const byId = all.find(d => d.id === needle)
  if (byId) return byId

  const lower = needle.toLowerCase()
  const byName = all.filter(d => d.name.toLowerCase() === lower)
  const mine = byName.filter(d => d.kind === 'mine')
  if (mine.length === 1) return mine[0]
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new SavedDashboardError(`"${needle}" matches ${byName.length} dashboards. Pass the id instead: ${byName.map(d => d.id).join(', ')}.`)
  }
  const names = all.map(d => d.name)
  throw new SavedDashboardError(`No dashboard called "${needle}". Available: ${names.join(', ')}.`)
}

export interface SaveInput {
  name: unknown
  view: unknown
  arguments?: unknown
  shared?: unknown
}

/** A dashboard as it will be stored: checked, and with any name already resolved to what it names. */
export interface SaveRecipe {
  name: string
  view: DashboardView
  params: Record<string, string>
  shared: boolean
}

/** Validate a save request's shape. Resolving the names in it is the caller's job (it needs access). */
export function parseSave(input: SaveInput): SaveRecipe {
  const name = cleanName(input.name)
  if (!isDashboardView(input.view)) throw new SavedDashboardError(`view must be one of: ${DASHBOARD_VIEWS.join(', ')}.`)
  return { name, view: input.view, params: sanitizeArguments(input.view, input.arguments), shared: input.shared === true }
}

/** Create, or replace the caller's own dashboard of the same name. */
export async function saveDashboard(admin: SupabaseClient, fundId: string, userId: string, input: SaveInput | SaveRecipe): Promise<SavedDashboardSummary> {
  const { name, view, params, shared } = 'params' in input ? input : parseSave(input)

  if (STANDARD_DASHBOARDS.some(d => d.name.toLowerCase() === name.toLowerCase())) {
    throw new SavedDashboardError(`"${name}" is the name of a standard dashboard. Choose another name.`)
  }

  const { data: existing, error: readError } = await (admin as any)
    .from(TABLE)
    .select('id, name')
    .eq('fund_id', fundId)
    .eq('user_id', userId)
  if (readError) throw new SavedDashboardError(isMissingTable(readError) ? MIGRATION_HINT : 'Could not save the dashboard.')

  const rows = (existing as { id: string; name: string }[]) ?? []
  const same = rows.find(r => r.name.toLowerCase() === name.toLowerCase())
  const now = new Date().toISOString()

  if (same) {
    const { data, error } = await (admin as any)
      .from(TABLE)
      .update({ name, view, params, shared, updated_at: now })
      .eq('id', same.id)
      .eq('fund_id', fundId)
      .eq('user_id', userId)
      .select('id, user_id, name, view, params, shared, updated_at')
      .single()
    if (error) throw new SavedDashboardError('Could not save the dashboard.')
    return toSummary(data as Row, userId)!
  }

  if (rows.length >= MAX_SAVED_PER_USER) {
    throw new SavedDashboardError(`You have ${MAX_SAVED_PER_USER} saved dashboards, which is the limit. Delete one first.`)
  }

  const { data, error } = await (admin as any)
    .from(TABLE)
    .insert({ fund_id: fundId, user_id: userId, name, view, params, shared })
    .select('id, user_id, name, view, params, shared, updated_at')
    .single()
  if (error) throw new SavedDashboardError('Could not save the dashboard.')
  return toSummary(data as Row, userId)!
}

/** Delete one of the caller's OWN dashboards. A shared dashboard is its author's to delete. */
export async function deleteDashboard(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  ref: unknown,
  visible?: (dashboard: SavedDashboardSummary) => boolean,
): Promise<{ deleted: string }> {
  const target = await resolveDashboard(admin, fundId, userId, ref, visible)
  if (target.kind === 'standard') throw new SavedDashboardError('The standard dashboards cannot be deleted.')
  if (target.kind !== 'mine') throw new SavedDashboardError(`"${target.name}" was shared by a colleague. Only they can delete it.`)

  const { error } = await (admin as any)
    .from(TABLE)
    .delete()
    .eq('id', target.id)
    .eq('fund_id', fundId)
    .eq('user_id', userId)
  if (error) throw new SavedDashboardError('Could not delete the dashboard.')
  return { deleted: target.name }
}
