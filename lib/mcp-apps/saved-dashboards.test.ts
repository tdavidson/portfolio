import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import {
  MAX_SAVED_PER_USER, STANDARD_DASHBOARDS, SavedDashboardError, cleanName, deleteDashboard,
  listDashboards, resolveDashboard, sanitizeArguments, saveDashboard,
} from './saved-dashboards'

const FUND = 'fund-1'
const ME = 'user-me'
const COLLEAGUE = 'user-colleague'

const MEMBERS = [ME, COLLEAGUE, 'user-third'].map(user_id => ({ fund_id: FUND, user_id }))
const db = (rows: Record<string, any>[] = [], members = MEMBERS) => memoryAdmin({ saved_dashboards: rows, fund_members: members })

describe('sanitizeArguments: a saved recipe is only ever the keys its view takes', () => {
  it('keeps the known keys and drops everything else', () => {
    expect(sanitizeArguments('portfolio', { vehicle: ' Fund I ', as_of: '2026-09-30', admin: true, __proto__: { x: 1 } }))
      .toEqual({ vehicle: 'Fund I', as_of: '2026-09-30' })
  })

  it('requires what the view cannot run without', () => {
    expect(() => sanitizeArguments('company', {})).toThrow(/needs "company"/)
    expect(sanitizeArguments('company', { company: 'Acme' })).toEqual({ company: 'Acme' })
  })

  it('refuses a value that is not text, not a date, or not a known period', () => {
    expect(() => sanitizeArguments('portfolio', { vehicle: { $ne: null } })).toThrow(/must be text/)
    expect(() => sanitizeArguments('lps', { as_of: 'yesterday' })).toThrow(/ISO date/)
    expect(() => sanitizeArguments('statements', { period: 'forever' })).toThrow(/must be one of/)
    expect(() => sanitizeArguments('portfolio', { vehicle: 'x'.repeat(500) })).toThrow(/too long/)
  })

  it('treats a missing or malformed arguments object as empty', () => {
    expect(sanitizeArguments('lps', null)).toEqual({})
    expect(sanitizeArguments('lps', ['vehicle', 'Fund I'])).toEqual({})
    expect(sanitizeArguments('lps', 'vehicle=Fund I')).toEqual({})
  })
})

describe('cleanName', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(cleanName('  Q3\tLP\n review  ')).toBe('Q3 LP review')
  })

  it('refuses an empty or over-long name', () => {
    expect(() => cleanName('   ')).toThrow(SavedDashboardError)
    expect(() => cleanName(42)).toThrow(SavedDashboardError)
    expect(() => cleanName('x'.repeat(81))).toThrow(/at most 80/)
  })
})

describe('saveDashboard', () => {
  it('stores the recipe for the caller, in the caller\'s fund', async () => {
    const { admin, tables } = db()
    const saved = await saveDashboard(admin, FUND, ME, { name: 'Q3 LP review', view: 'lps', arguments: { vehicle: 'Fund I', nonsense: 1 }, shared: true })
    expect(saved).toMatchObject({ name: 'Q3 LP review', view: 'lps', arguments: { vehicle: 'Fund I' }, kind: 'mine' })
    expect(tables.saved_dashboards).toHaveLength(1)
    expect(tables.saved_dashboards[0]).toMatchObject({ fund_id: FUND, user_id: ME, shared: true, params: { vehicle: 'Fund I' } })
  })

  it('replaces the caller\'s own dashboard of the same name, case-insensitively', async () => {
    const { admin, tables } = db()
    await saveDashboard(admin, FUND, ME, { name: 'Board pack', view: 'portfolio' })
    await saveDashboard(admin, FUND, ME, { name: 'board PACK', view: 'statements', arguments: { period: 'ytd' } })
    expect(tables.saved_dashboards).toHaveLength(1)
    expect(tables.saved_dashboards[0]).toMatchObject({ view: 'statements', params: { period: 'ytd' } })
  })

  it('never overwrites a colleague\'s dashboard that happens to share the name', async () => {
    const { admin, tables } = db([{ id: 'theirs', fund_id: FUND, user_id: COLLEAGUE, name: 'Board pack', view: 'lps', params: {}, shared: true, updated_at: null }])
    await saveDashboard(admin, FUND, ME, { name: 'Board pack', view: 'portfolio' })
    expect(tables.saved_dashboards).toHaveLength(2)
    expect(tables.saved_dashboards.find(r => r.id === 'theirs')).toMatchObject({ view: 'lps', user_id: COLLEAGUE })
  })

  it('refuses an unknown view, a standard dashboard\'s name, and anything past the limit', async () => {
    const { admin } = db()
    await expect(saveDashboard(admin, FUND, ME, { name: 'x', view: 'carry' })).rejects.toThrow(/view must be one of/)
    await expect(saveDashboard(admin, FUND, ME, { name: 'portfolio overview', view: 'portfolio' })).rejects.toThrow(/standard dashboard/)

    const full = db(Array.from({ length: MAX_SAVED_PER_USER }, (_, i) => ({ id: `d${i}`, fund_id: FUND, user_id: ME, name: `d${i}`, view: 'lps', params: {}, shared: false, updated_at: null })))
    await expect(saveDashboard(full.admin, FUND, ME, { name: 'one more', view: 'lps' })).rejects.toThrow(/limit/)
    // Replacing one of the fifty is still allowed: the limit counts dashboards, not saves.
    await expect(saveDashboard(full.admin, FUND, ME, { name: 'd3', view: 'portfolio' })).resolves.toMatchObject({ view: 'portfolio' })
  })

  it('says a migration is pending when the table is not there yet', async () => {
    const { admin, failNext } = db()
    failNext('saved_dashboards', 'select', 'relation "public.saved_dashboards" does not exist')
    await expect(saveDashboard(admin, FUND, ME, { name: 'x', view: 'lps' })).rejects.toThrow(/latest database migration/)
  })
})

describe('listDashboards', () => {
  const rows = [
    { id: 'mine', fund_id: FUND, user_id: ME, name: 'Mine', view: 'lps', params: {}, shared: false, updated_at: '2026-10-01' },
    { id: 'shared', fund_id: FUND, user_id: COLLEAGUE, name: 'Team', view: 'portfolio', params: {}, shared: true, updated_at: '2026-10-02' },
    { id: 'private', fund_id: FUND, user_id: COLLEAGUE, name: 'Theirs', view: 'lps', params: {}, shared: false, updated_at: '2026-10-03' },
    { id: 'elsewhere', fund_id: 'fund-2', user_id: ME, name: 'Other fund', view: 'lps', params: {}, shared: true, updated_at: '2026-10-04' },
  ]

  it('returns the standard ones, then the caller\'s, then the fund\'s shared ones', async () => {
    const list = await listDashboards(db(rows).admin, FUND, ME)
    expect(list.map(d => d.id)).toEqual([...STANDARD_DASHBOARDS.map(d => d.id), 'mine', 'shared'])
    expect(list.find(d => d.id === 'shared')!.kind).toBe('shared')
  })

  it('never shows a colleague\'s private dashboard or another fund\'s', async () => {
    const ids = (await listDashboards(db(rows).admin, FUND, ME)).map(d => d.id)
    expect(ids).not.toContain('private')
    expect(ids).not.toContain('elsewhere')
  })

  it('stops listing a shared dashboard once its author has left the fund', async () => {
    // Nobody else could delete it, so it would otherwise sit in everyone's list for good.
    const stillHere = MEMBERS.filter(m => m.user_id !== COLLEAGUE)
    const ids = (await listDashboards(db(rows, stillHere).admin, FUND, ME)).map(d => d.id)
    expect(ids).toContain('mine')
    expect(ids).not.toContain('shared')
  })

  it('resolves only inside the list the caller is allowed to see', async () => {
    const { admin } = db(rows)
    const hideShared = (d: { kind: string }) => d.kind !== 'shared'
    await expect(resolveDashboard(admin, FUND, ME, 'shared', hideShared)).rejects.toThrow(/No dashboard called "shared"/)
    const message = await resolveDashboard(admin, FUND, ME, 'Team', hideShared).then(() => '', (e: Error) => e.message)
    expect(message).toMatch(/Available: /)
    expect(message.replace('"Team"', '')).not.toContain('Team')
    await expect(deleteDashboard(admin, FUND, ME, 'mine', hideShared)).resolves.toEqual({ deleted: 'Mine' })
  })

  it('lists a dashboard that is both the caller\'s and shared once', async () => {
    const list = await listDashboards(db([{ ...rows[0], shared: true }]).admin, FUND, ME)
    expect(list.filter(d => d.id === 'mine')).toHaveLength(1)
    expect(list.find(d => d.id === 'mine')!.kind).toBe('mine')
  })

  it('drops a row whose view or arguments are not ones it understands', async () => {
    const list = await listDashboards(db([
      { ...rows[0], id: 'bad-view', view: 'carry' },
      { ...rows[0], id: 'bad-args', view: 'company', params: {} },
    ]).admin, FUND, ME)
    expect(list.map(d => d.id)).toEqual(STANDARD_DASHBOARDS.map(d => d.id))
  })

  it('still offers the standard dashboards before the migration is applied', async () => {
    const { admin, failNext } = db()
    failNext('saved_dashboards', 'select', 'Could not find the table public.saved_dashboards in the schema cache')
    expect(await listDashboards(admin, FUND, ME)).toEqual(STANDARD_DASHBOARDS)
  })
})

describe('resolveDashboard', () => {
  const rows = [
    { id: 'mine', fund_id: FUND, user_id: ME, name: 'Board pack', view: 'lps', params: {}, shared: false, updated_at: null },
    { id: 'theirs', fund_id: FUND, user_id: COLLEAGUE, name: 'Board pack', view: 'portfolio', params: {}, shared: true, updated_at: null },
    { id: 'a', fund_id: FUND, user_id: COLLEAGUE, name: 'Weekly', view: 'portfolio', params: {}, shared: true, updated_at: null },
    { id: 'b', fund_id: FUND, user_id: 'user-third', name: 'weekly', view: 'lps', params: {}, shared: true, updated_at: null },
  ]

  it('finds a dashboard by id or by name, ignoring case', async () => {
    const { admin } = db(rows)
    expect((await resolveDashboard(admin, FUND, ME, 'theirs')).id).toBe('theirs')
    expect((await resolveDashboard(admin, FUND, ME, 'standard:lps')).view).toBe('lps')
    expect((await resolveDashboard(admin, FUND, ME, 'lp capital')).id).toBe('standard:lps')
  })

  it('prefers the caller\'s own over a shared one of the same name', async () => {
    expect((await resolveDashboard(db(rows).admin, FUND, ME, 'board pack')).id).toBe('mine')
  })

  it('refuses a name that matches two shared dashboards instead of picking one', async () => {
    await expect(resolveDashboard(db(rows).admin, FUND, ME, 'Weekly')).rejects.toThrow(/matches 2 dashboards/)
  })

  it('names what is available when nothing matches', async () => {
    await expect(resolveDashboard(db(rows).admin, FUND, ME, 'nope')).rejects.toThrow(/No dashboard called "nope".*Portfolio overview/)
    await expect(resolveDashboard(db(rows).admin, FUND, ME, '')).rejects.toThrow(/Say which dashboard/)
  })
})

describe('deleteDashboard', () => {
  const rows = [
    { id: 'mine', fund_id: FUND, user_id: ME, name: 'Mine', view: 'lps', params: {}, shared: false, updated_at: null },
    { id: 'theirs', fund_id: FUND, user_id: COLLEAGUE, name: 'Team', view: 'portfolio', params: {}, shared: true, updated_at: null },
  ]

  it('deletes the caller\'s own dashboard and nothing else', async () => {
    const { admin, tables } = db(rows)
    expect(await deleteDashboard(admin, FUND, ME, 'mine')).toEqual({ deleted: 'Mine' })
    expect(tables.saved_dashboards.map(r => r.id)).toEqual(['theirs'])
  })

  it('will not delete a colleague\'s shared dashboard or a standard one', async () => {
    const { admin, tables } = db(rows)
    await expect(deleteDashboard(admin, FUND, ME, 'Team')).rejects.toThrow(/Only they can delete it/)
    await expect(deleteDashboard(admin, FUND, ME, 'standard:portfolio')).rejects.toThrow(/cannot be deleted/)
    expect(tables.saved_dashboards).toHaveLength(2)
  })
})
