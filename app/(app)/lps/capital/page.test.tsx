import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ access: vi.fn(), allowed: vi.fn(), vehicles: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ getUser: async () => ({ id: 'synthetic-user' }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/access/page-gate', () => ({ resolvePageAccess: mocks.access, canViewPage: mocks.allowed }))
vi.mock('@/lib/accounting/load', () => ({ listVehiclesWithId: mocks.vehicles }))
vi.mock('./view', () => ({ LpCapitalView: () => null }))
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect') } }))
import Page from './page'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.allowed.mockReturnValue(true)
  mocks.access.mockResolvedValue({ fundId: 'fund-a', isAdmin: false, access: { vehicles: { all: false, ids: ['visible'] } } })
  mocks.vehicles.mockResolvedValue([{ id: 'visible', name: 'Visible' }, { id: 'hidden', name: 'Hidden' }, { id: null, name: 'Legacy' }])
})
it('preloads only granted vehicles from the authenticated fund', async () => {
  const page = await Page()
  expect(mocks.vehicles).toHaveBeenCalledWith({}, 'fund-a')
  expect(page.props.children.props.initialVehicles).toEqual([{ id: 'visible', name: 'Visible' }])
})
it('renders an empty picker when no entities are granted', async () => {
  mocks.access.mockResolvedValue({ fundId: 'fund-a', isAdmin: false, access: { vehicles: { all: false, ids: [] } } })
  expect((await Page()).props.children.props.initialVehicles).toEqual([])
})
it('does not read vehicles before the page grant passes', async () => {
  mocks.allowed.mockReturnValue(false)
  await expect(Page()).rejects.toThrow('redirect')
  expect(mocks.vehicles).not.toHaveBeenCalled()
})
it('retains legacy names for a caller allowed all entities', async () => {
  mocks.access.mockResolvedValue({ fundId: 'fund-a', isAdmin: true, access: { vehicles: { all: true, ids: [] } } })
  expect((await Page()).props.children.props.initialVehicles).toHaveLength(3)
})
