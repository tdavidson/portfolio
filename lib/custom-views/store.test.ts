import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { CustomViewError, deleteView, getView, listViews, MAX_VIEWS_PER_USER, MIGRATION_HINT, saveView } from './store'

const spec = (title = 'Monday view') => ({
  title,
  blocks: [{ type: 'table', label: 'Positions', source: { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company'] } } }],
})

const setup = (rows: Record<string, unknown>[] = []) => memoryAdmin({ custom_views: rows, custom_view_versions: [] })

describe('custom view store', () => {
  it('saves a view, keeps a version, and lists it', async () => {
    const { admin, tables } = setup()
    const saved = await saveView(admin as never, 'fund-1', 'user-me', { name: '  Monday   view ', spec: spec() })
    expect(saved).toMatchObject({ name: 'Monday view', kind: 'mine', shared: false, blocks: 1 })
    expect(tables.custom_view_versions).toHaveLength(1)
    expect((await listViews(admin as never, 'fund-1', 'user-me')).map(v => v.name)).toEqual(['Monday view'])
  })

  it('replaces the member\'s own view of the same name, case-insensitively', async () => {
    const { admin, tables } = setup()
    const first = await saveView(admin as never, 'fund-1', 'user-me', { name: 'Monday view', spec: spec() })
    const second = await saveView(admin as never, 'fund-1', 'user-me', { name: 'monday VIEW', spec: spec('New title'), shared: true })
    expect(second.id).toBe(first.id)
    expect(tables.custom_views).toHaveLength(1)
    expect(tables.custom_view_versions).toHaveLength(2)
    expect((await getView(admin as never, 'fund-1', 'user-me', first.id)).spec.title).toBe('New title')
  })

  it('refuses a spec that does not validate, and stores nothing', async () => {
    const { admin, tables } = setup()
    await expect(saveView(admin as never, 'fund-1', 'user-me', { name: 'Bad', spec: { title: 'T', blocks: [{ type: 'iframe' }] } })).rejects.toThrow(CustomViewError)
    expect(tables.custom_views).toHaveLength(0)
  })

  it('shows a colleague\'s view only when it is shared, and never another fund\'s', async () => {
    const { admin } = setup([
      { id: '00000000-0000-4000-8000-000000000001', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Shared one', spec: spec(), shared: true, updated_at: '2026-11-01' },
      { id: '00000000-0000-4000-8000-000000000002', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Private one', spec: spec(), shared: false, updated_at: '2026-11-01' },
      { id: '00000000-0000-4000-8000-000000000003', fund_id: 'fund-2', user_id: 'user-other', name: 'Other fund', spec: spec(), shared: true, updated_at: '2026-11-01' },
    ])
    const views = await listViews(admin as never, 'fund-1', 'user-me')
    expect(views.map(v => [v.name, v.kind])).toEqual([['Shared one', 'shared']])
    await expect(getView(admin as never, 'fund-1', 'user-me', 'Private one')).rejects.toThrow(/No view called/)
    await expect(getView(admin as never, 'fund-1', 'user-me', '00000000-0000-4000-8000-000000000003')).rejects.toThrow(/No view called/)
  })

  it('lets only the owner delete a view', async () => {
    const { admin, tables } = setup([
      { id: '00000000-0000-4000-8000-000000000001', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Shared one', spec: spec(), shared: true, updated_at: '2026-11-01' },
    ])
    await expect(deleteView(admin as never, 'fund-1', 'user-me', 'Shared one')).rejects.toThrow(/only they can delete it/)
    const mine = await saveView(admin as never, 'fund-1', 'user-me', { name: 'Mine', spec: spec() })
    await deleteView(admin as never, 'fund-1', 'user-me', mine.id)
    expect(tables.custom_views.map(r => r.name)).toEqual(['Shared one'])
  })

  it('hides a stored row whose spec no longer validates', async () => {
    const { admin } = setup([
      { id: '00000000-0000-4000-8000-000000000001', fund_id: 'fund-1', user_id: 'user-me', name: 'Broken', spec: { title: 'T', blocks: [{ type: 'table', label: 'X', source: { tool: 'query_portfolio', dataset: 'gone' } }] }, shared: false, updated_at: '2026-11-01' },
    ])
    expect(await listViews(admin as never, 'fund-1', 'user-me')).toEqual([])
    await expect(getView(admin as never, 'fund-1', 'user-me', 'Broken')).rejects.toThrow(/no longer matches/)
  })

  it('caps the number of views per member', async () => {
    const rows = Array.from({ length: MAX_VIEWS_PER_USER }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, fund_id: 'fund-1', user_id: 'user-me', name: `View ${i}`, spec: spec(), shared: false, updated_at: '2026-11-01',
    }))
    const { admin } = setup(rows)
    await expect(saveView(admin as never, 'fund-1', 'user-me', { name: 'One more', spec: spec() })).rejects.toThrow(/at most 50 views/)
  })

  it('says a migration is pending when the table is missing', async () => {
    const admin = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { code: '42P01', message: 'relation "custom_views" does not exist' } }) }) }) }) }) }
    await expect(saveView(admin as never, 'fund-1', 'user-me', { name: 'X', spec: spec() })).rejects.toThrow(MIGRATION_HINT)
  })
})
