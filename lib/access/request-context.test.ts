import { beforeEach, expect, it, vi } from 'vitest'
const read = vi.hoisted(() => vi.fn())
vi.mock('./effective', () => ({ loadAccessContext: read }))
import { loadGateAccess, withRequestAccess } from './request-context'
beforeEach(() => { read.mockReset() })
it('shares concurrent checks on one request but refreshes the next request', async () => {
  const gate = withRequestAccess({ fundId: 'fund-a', userId: 'user-a', role: 'member' })
  const admin = {} as never
  read.mockResolvedValueOnce({ granted: true }).mockResolvedValueOnce({ granted: false })
  const [a, b] = await Promise.all([loadGateAccess(admin, gate), loadGateAccess(admin, gate)])
  expect(a).toBe(b)
  expect(read).toHaveBeenCalledTimes(1)
  expect(await loadGateAccess(admin, { fundId: gate.fundId, userId: gate.userId, role: gate.role })).toEqual({ granted: false })
  expect(read).toHaveBeenCalledTimes(2)
})
it('keeps a failed resolution failed for every consumer', async () => {
  const gate = withRequestAccess({ fundId: 'fund-a', userId: 'user-a', role: 'member' })
  read.mockRejectedValue(new Error('unavailable'))
  await expect(loadGateAccess({} as never, gate)).rejects.toThrow('unavailable')
  await expect(loadGateAccess({} as never, gate)).rejects.toThrow('unavailable')
  expect(read).toHaveBeenCalledTimes(1)
})

it('does not cache plain contexts that may be reused outside an HTTP request', async () => {
  const gate = { fundId: 'fund-a', userId: 'user-a', role: 'member' }
  read.mockResolvedValueOnce({ granted: true }).mockResolvedValueOnce({ granted: false })
  await loadGateAccess({} as never, gate)
  expect(await loadGateAccess({} as never, gate)).toEqual({ granted: false })
})
