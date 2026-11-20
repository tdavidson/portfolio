// Saved custom views: the spec, who owns it, and whether the fund can see it.
//
// SERVICE ROLE ONLY, like saved_dashboards: every read and write here is scoped by fund and
// member in application code, and the table grants nothing to the browser. A spec names datasets
// and filter values, and a fund-membership RLS policy would hand a colleague's shared spec to a
// member the app would not list it for. Each block is still checked against the viewer when the
// view is opened (resolve.ts), so sharing a view shares the recipe only.
//
// Every save also writes a row to custom_view_versions, so a change can be compared and undone.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseViewSpec, ViewSpecError, type ViewSpec } from './spec'

const TABLE = 'custom_views'
const VERSIONS = 'custom_view_versions'

export const MAX_NAME_LENGTH = 80
/** Per member. */
export const MAX_VIEWS_PER_USER = 50

export class CustomViewError extends Error {}

export interface CustomViewSummary {
  id: string
  name: string
  description: string | null
  kind: 'mine' | 'shared'
  shared: boolean
  blocks: number
  updatedAt: string | null
}

export interface CustomViewRecord extends CustomViewSummary {
  spec: ViewSpec
}

interface Row {
  id: string
  user_id: string
  name: string
  spec: unknown
  shared: boolean
  updated_at: string | null
}

const COLUMNS = 'id, user_id, name, spec, shared, updated_at'

/** The migration is applied by the deployment's owner, so there is a window without the table. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /custom_view/.test(error.message ?? '') && /does not exist|could not find|schema cache/i.test(error.message ?? '')
}

export const MIGRATION_HINT = 'Custom views are not set up on this deployment yet. An admin needs to apply the latest database migration.'

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new CustomViewError('A view needs a name.')
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) throw new CustomViewError('A view needs a name.')
  if (name.length > MAX_NAME_LENGTH) throw new CustomViewError(`A view name can be at most ${MAX_NAME_LENGTH} characters.`)
  return name
}

/** A stored row as a record, or null when its spec no longer validates (shown as unavailable). */
function toRecord(row: Row, userId: string): CustomViewRecord | null {
  let spec: ViewSpec
  try {
    spec = parseViewSpec(row.spec)
  } catch {
    return null
  }
  return {
    id: row.id,
    name: row.name,
    description: spec.description ?? null,
    kind: row.user_id === userId ? 'mine' : 'shared',
    shared: row.shared,
    blocks: spec.blocks.length,
    updatedAt: row.updated_at,
    spec,
  }
}

const summary = ({ spec: _spec, ...rest }: CustomViewRecord): CustomViewSummary => rest

async function readRows(admin: SupabaseClient, fundId: string, userId: string): Promise<Row[]> {
  // Two plain reads rather than an `or(...)` string with the id spliced in.
  const [own, shared] = await Promise.all([
    (admin as any).from(TABLE).select(COLUMNS).eq('fund_id', fundId).eq('user_id', userId).order('updated_at', { ascending: false }).limit(MAX_VIEWS_PER_USER),
    (admin as any).from(TABLE).select(COLUMNS).eq('fund_id', fundId).eq('shared', true).order('updated_at', { ascending: false }).limit(200),
  ])
  for (const { error } of [own, shared]) {
    if (!error) continue
    if (isMissingTable(error)) return []
    throw new CustomViewError('Could not read custom views.')
  }
  const byId = new Map<string, Row>()
  for (const r of [...(own.data ?? []), ...(shared.data ?? [])] as Row[]) byId.set(r.id, r)
  return Array.from(byId.values())
}

/** The member's own views and the fund's shared ones, newest first. */
export async function listViews(admin: SupabaseClient, fundId: string, userId: string): Promise<CustomViewSummary[]> {
  const rows = await readRows(admin, fundId, userId)
  return rows
    .map(r => toRecord(r, userId))
    .filter((r): r is CustomViewRecord => r !== null)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .map(summary)
}

/** One view by id or by name (case-insensitive), the member's own first. */
export async function getView(admin: SupabaseClient, fundId: string, userId: string, ref: unknown): Promise<CustomViewRecord> {
  const wanted = typeof ref === 'string' ? ref.trim() : ''
  if (!wanted) throw new CustomViewError('Name the view to open (its id or name).')
  const rows = await readRows(admin, fundId, userId)
  const match = rows.find(r => r.id === wanted)
    ?? rows.filter(r => r.name.toLowerCase() === wanted.toLowerCase())
      .sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId))[0]
  if (!match) throw new CustomViewError(`No view called "${wanted}". Use list_custom_views to see them.`)
  const record = toRecord(match, userId)
  if (!record) throw new CustomViewError(`"${match.name}" no longer matches the datasets it was built on. Save it again with a fixed spec.`)
  return record
}

/**
 * Save under a name: replaces the member's own view of that name, or creates one. The spec is
 * validated here as well as by the caller, so nothing unchecked is ever stored.
 */
export async function saveView(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  input: { name: unknown; spec: unknown; shared?: unknown },
): Promise<CustomViewSummary> {
  const name = cleanName(input.name)
  let spec: ViewSpec
  try {
    spec = parseViewSpec(input.spec)
  } catch (e) {
    if (e instanceof ViewSpecError) throw new CustomViewError(e.message)
    throw e
  }
  const shared = input.shared === true

  // The member's own names, matched case-insensitively here (at most MAX_VIEWS_PER_USER rows), as
  // the unique index on lower(name) does.
  const own = await (admin as any).from(TABLE).select('id, name').eq('fund_id', fundId).eq('user_id', userId).limit(MAX_VIEWS_PER_USER + 1)
  if (own.error) {
    if (isMissingTable(own.error)) throw new CustomViewError(MIGRATION_HINT)
    throw new CustomViewError('Could not save the view.')
  }
  const ownRows = (own.data ?? []) as { id: string; name: string }[]
  const existing = { data: ownRows.find(r => r.name.toLowerCase() === name.toLowerCase()) ?? null }

  const now = new Date().toISOString()
  let row: Row
  if (existing.data?.id) {
    const { data, error } = await (admin as any).from(TABLE)
      .update({ name, spec, shared, updated_at: now })
      .eq('id', existing.data.id).eq('fund_id', fundId).eq('user_id', userId)
      .select(COLUMNS).single()
    if (error || !data) throw new CustomViewError('Could not save the view.')
    row = data
  } else {
    if (ownRows.length >= MAX_VIEWS_PER_USER) throw new CustomViewError(`You can keep at most ${MAX_VIEWS_PER_USER} views. Delete one first.`)
    const { data, error } = await (admin as any).from(TABLE)
      .insert({ fund_id: fundId, user_id: userId, name, spec, shared })
      .select(COLUMNS).single()
    if (error || !data) {
      if (isMissingTable(error)) throw new CustomViewError(MIGRATION_HINT)
      throw new CustomViewError('Could not save the view.')
    }
    row = data
  }

  // History is best effort: a view that saved but lost its version row is still a saved view.
  await (admin as any).from(VERSIONS).insert({ view_id: row.id, fund_id: fundId, user_id: userId, spec }).then(() => undefined, () => undefined)

  return summary(toRecord(row, userId)!)
}

/** Delete one of the member's own views. A shared view can only be deleted by its owner. */
export async function deleteView(admin: SupabaseClient, fundId: string, userId: string, ref: unknown): Promise<{ deleted: string }> {
  const view = await getView(admin, fundId, userId, ref)
  if (view.kind !== 'mine') throw new CustomViewError(`"${view.name}" belongs to a colleague; only they can delete it.`)
  const { error } = await (admin as any).from(TABLE).delete().eq('id', view.id).eq('fund_id', fundId).eq('user_id', userId)
  if (error) throw new CustomViewError('Could not delete the view.')
  return { deleted: view.name }
}

/** The view's page in the app. */
export function viewPath(id: string): string {
  return `/views/${id}`
}
