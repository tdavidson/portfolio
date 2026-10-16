import { describe, it, expect, vi, beforeEach } from 'vitest'

const service = vi.hoisted(() => ({
  listAgentRuns: vi.fn(),
  undoAgentRun: vi.fn(),
}))
vi.mock('@/lib/pending-actions/service', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/pending-actions/service')>()),
  listAgentRuns: service.listAgentRuns,
  undoAgentRun: service.undoAgentRun,
}))

import { getPendingTool } from './pending-tools'
import { PendingActionServiceError } from '@/lib/pending-actions/service'

const ctx = (keyId: string) => ({
  admin: {} as any,
  auth: { userId: 'u1', fundId: 'f1', role: 'admin', keyId } as any,
  access: {} as any,
  origin: 'https://fund.example',
})

const RUN = {
  id: 'run1', status: 'applied', createdVia: 'mcp', updatedAt: '2026-10-01T00:00:00Z',
  preview: { summary: 'Fix Acme holdings' }, appliedResult: { run: { steps: [] } },
}

beforeEach(() => vi.clearAllMocks())

describe('list_runs and undo_run', () => {
  it('lists runs as the Approvals page does, as the caller', async () => {
    service.listAgentRuns.mockResolvedValue({ runs: [RUN] })
    const out = await getPendingTool('list_runs')!.run(ctx('oauth:c1'), { limit: 500 })
    expect(service.listAgentRuns).toHaveBeenCalledWith({}, expect.objectContaining({ userId: 'u1', fundId: 'f1', credentialKind: 'oauth' }), 50)
    expect(out).toEqual({ runs: [{ id: 'run1', summary: 'Fix Acme holdings', status: 'applied', stagedVia: 'mcp', updatedAt: RUN.updatedAt, result: RUN.appliedResult }] })
  })

  it('undoes through the service, which holds it to the approval rules', async () => {
    service.undoAgentRun.mockResolvedValue({ ok: true, replayed: false, action: RUN })
    const out = await getPendingTool('undo_run')!.run(ctx('lk_1'), { id: ' run1 ' })
    expect(service.undoAgentRun).toHaveBeenCalledWith({}, expect.objectContaining({ credentialId: 'lk_1' }), 'run1')
    expect(out).toMatchObject({ replayed: false, summary: 'Fix Acme holdings' })
  })

  it('hands the person the app link when the credential that staged the run tries to undo it', async () => {
    service.undoAgentRun.mockRejectedValue(new PendingActionServiceError('You staged this.', 403, 'SELF_APPROVAL'))
    await expect(getPendingTool('undo_run')!.run(ctx('lk_1'), { id: 'run1' }))
      .rejects.toThrow('https://fund.example/pending-actions')
  })

  it('needs a run id', async () => {
    await expect(getPendingTool('undo_run')!.run(ctx('lk_1'), {})).rejects.toThrow('id')
    expect(service.undoAgentRun).not.toHaveBeenCalled()
  })

  it('is a read and a write, decided per run by the service', () => {
    expect(getPendingTool('list_runs')).toMatchObject({ scope: 'read', pendingDecision: true })
    expect(getPendingTool('undo_run')).toMatchObject({ scope: 'write', pendingDecision: true })
  })
})
