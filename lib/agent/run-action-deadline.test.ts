import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A run keeps its own clock (lib/agent/run-action.ts executeRun): it starts a step only with time
 * left, hands a close the time that is left, runs a close again while months remain and time allows,
 * pauses cleanly instead of being killed by the function limit, saves progress around every step,
 * and continues from where it paused.
 */

let clock = 0
const calls: { tool: string; deadline?: number }[] = []
let handlers: Record<string, (input: any) => unknown> = {}

vi.mock('./tool-call-action', async importOriginal => ({
  ...(await importOriginal<typeof import('./tool-call-action')>()),
  executeToolCall: async (deps: { deadline?: number }, step: { tool: string; input: any }) => {
    calls.push({ tool: step.tool, deadline: deps.deadline })
    return { tool: step.tool, result: handlers[step.tool](step.input) }
  },
}))
vi.mock('./run-checks', async importOriginal => ({
  ...(await importOriginal<typeof import('./run-checks')>()),
  evaluateChecks: async () => [],
}))

import { executeRun, runResumeAt, RunStepError, RUN_TIME_BUDGET_MS, type RunResult } from './run-action'

const deps = { admin: {} as any, fundId: 'fund-1', userId: 'user-1', access: {} as any }
const now = () => clock
const run = (steps: { tool: string; input?: Record<string, unknown> }[]) =>
  ({ title: 'Fix', rationale: '', steps: steps.map(s => ({ tool: s.tool, input: s.input ?? {} })), expected: [] })

beforeEach(() => {
  clock = 0
  calls.length = 0
  handlers = {
    post_entry: () => { clock += 10_000; return { entryId: `e-${clock}` } },
  }
})

describe('a run with its own clock', () => {
  it('finishes in one request when it fits, and saves progress around every step', async () => {
    const progress: RunResult[] = []
    const out = await executeRun(deps, run([{ tool: 'post_entry' }, { tool: 'post_entry' }]), {
      now, onProgress: async p => { progress.push(structuredClone(p)) },
    }) as unknown as RunResult
    expect(out.run.steps.map(s => s.status)).toEqual(['applied', 'applied'])
    expect(runResumeAt(out)).toBeNull()
    // Before step 1, after step 1, before step 2, after step 2.
    expect(progress.map(p => [p.run.inFlight ?? null, p.run.resumeAt ?? null])).toEqual([[1, 1], [null, 2], [2, 2], [null, null]])
    // Every step is told when the request must be done.
    expect(calls.every(c => c.deadline === RUN_TIME_BUDGET_MS)).toBe(true)
  })

  it('pauses before a step that would not fit, and continues from it under the same approval', async () => {
    handlers.post_entry = () => { clock += 100_000; return { entryId: `e-${clock}` } }
    const steps = run([{ tool: 'post_entry' }, { tool: 'post_entry' }, { tool: 'post_entry' }])
    const first = await executeRun(deps, steps, { now }) as unknown as RunResult
    // 200s spent: 40s left is under the reserve, so step 3 waits.
    expect(first.run.steps.map(s => s.status)).toEqual(['applied', 'applied', 'pending'])
    expect(runResumeAt(first)).toBe(3)
    expect(first.run.paused?.message).toMatch(/continue from step 3/)

    clock = 1_000_000
    const second = await executeRun(deps, steps, { now, resume: first }) as unknown as RunResult
    expect(second.run.steps.map(s => s.status)).toEqual(['applied', 'applied', 'applied'])
    expect(runResumeAt(second)).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('runs a close again while months remain and time allows, and counts it applied only when done', async () => {
    let round = 0
    handlers.close_period = () => {
      round++
      clock += 60_000
      return round < 3
        ? { closed: [{ id: `p${round}`, label: `M${round}`, netIncome: 0 }], remaining: { from: 'x', through: '2026-10-31', months: 3 - round, message: 'left' } }
        : { closed: [{ id: 'p3', label: 'M3', netIncome: 0 }] }
    }
    const out = await executeRun(deps, run([{ tool: 'close_period', input: { periodEnd: '2026-10-31' } }]), { now }) as unknown as RunResult
    expect(out.run.steps[0].status).toBe('applied')
    expect((out.run.steps[0].result as any).closed.map((c: any) => c.id)).toEqual(['p1', 'p2', 'p3'])
    expect((out.run.steps[0].result as any).remaining).toBeUndefined()
  })

  it('pauses a close that runs out of time partway, keeping its months, and finishes it on continue', async () => {
    let round = 0
    handlers.close_period = () => {
      round++
      clock += 120_000
      return round < 3
        ? { closed: [{ id: `p${round}`, label: `M${round}`, netIncome: 0 }], remaining: { from: 'x', through: '2026-10-31', months: 3 - round, message: `${3 - round} months left` } }
        : { closed: [{ id: 'p3', label: 'M3', netIncome: 0 }] }
    }
    const steps = run([{ tool: 'close_period', input: { periodEnd: '2026-10-31' } }, { tool: 'post_entry' }])
    const first = await executeRun(deps, steps, { now }) as unknown as RunResult
    expect(first.run.steps.map(s => s.status)).toEqual(['pending', 'pending'])
    expect(first.run.steps[0].summary).toBe('1 months left')
    expect(runResumeAt(first)).toBe(1)

    clock = 5_000_000
    const second = await executeRun(deps, steps, { now, resume: first }) as unknown as RunResult
    expect(second.run.steps.map(s => s.status)).toEqual(['applied', 'applied'])
    expect((second.run.steps[0].result as any).closed.map((c: any) => c.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('re-runs a close whose request died mid-step, but refuses to guess about any other step', async () => {
    handlers.close_period = () => ({ closed: [{ id: 'p1', label: 'M1', netIncome: 0 }] })
    const steps = run([{ tool: 'post_entry' }, { tool: 'close_period', input: { periodEnd: '2026-10-31' } }])
    const diedInClose: RunResult = {
      run: {
        steps: [{ step: 1, tool: 'post_entry', status: 'applied' }, { step: 2, tool: 'close_period', status: 'pending' }],
        checks: [], checksFailed: null, stoppedAt: null, undoable: false, resumeAt: 2, inFlight: 2,
      },
    }
    const out = await executeRun(deps, steps, { now, resume: diedInClose }) as unknown as RunResult
    expect(out.run.steps.map(s => s.status)).toEqual(['applied', 'applied'])
    expect(calls.map(c => c.tool)).toEqual(['close_period'])

    const diedInEntry: RunResult = {
      run: {
        steps: [{ step: 1, tool: 'post_entry', status: 'pending' }, { step: 2, tool: 'close_period', status: 'pending' }],
        checks: [], checksFailed: null, stoppedAt: null, undoable: false, resumeAt: 1, inFlight: 1,
      },
    }
    await expect(executeRun(deps, steps, { now, resume: diedInEntry })).rejects.toThrow(RunStepError)
    await expect(executeRun(deps, steps, { now, resume: diedInEntry })).rejects.toThrow(/not known whether it applied/)
  })
})
