import { describe, expect, it, vi } from 'vitest'
import type { AIProvider } from '@/lib/ai/types'
import { draftSystemPrompt, draftViewSpec, extractJson, ViewDraftError } from './draft'
import { parseViewSpec } from './spec'

const GOOD = {
  title: 'Largest positions',
  params: ['vehicle'],
  blocks: [{ type: 'bar', label: 'Fair value', source: { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company', 'fair_value'], limit: 10 } }, x: 'company', y: 'fair_value', format: 'currency' }],
}
const BAD = { ...GOOD, blocks: [{ ...GOOD.blocks[0], y: 'valuation' }] }

const usage = { inputTokens: 100, outputTokens: 50 }
function provider(...replies: string[]) {
  const createMessage = vi.fn(async () => ({ text: replies.shift() ?? '', usage, truncated: false }))
  return { provider: { createMessage } as unknown as AIProvider, createMessage }
}

describe('extractJson', () => {
  it('reads a bare object, a fenced one, or one with a sentence around it', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Here it is: {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } })
    expect(() => extractJson('no spec here')).toThrow(ViewDraftError)
  })
})

describe('draftSystemPrompt', () => {
  it('names every dataset and the block types, and carries no fund data', () => {
    const prompt = draftSystemPrompt()
    for (const d of ['positions', 'lp_positions', 'journal_lines', 'diligence_deals']) expect(prompt).toContain(`"${d}"`)
    for (const t of ['"kpi"', '"column"', '"scatter"', '"waterfall"', '"table"', '"text"']) expect(prompt).toContain(t)
  })
})

describe('draftViewSpec', () => {
  it('returns a validated spec from the model\'s reply', async () => {
    const { provider: p, createMessage } = provider(JSON.stringify(GOOD))
    const result = await draftViewSpec({ provider: p, model: 'm', instruction: 'largest positions by vehicle' })
    expect(result.spec).toEqual(parseViewSpec(GOOD))
    expect(result.attempts).toBe(1)
    expect(result.usage).toEqual([usage])
    expect((createMessage.mock.calls[0] as any[])[0].content).toBe('Build a view: largest positions by vehicle')
  })

  it('gives the model the validator\'s message and one more try', async () => {
    const { provider: p, createMessage } = provider(JSON.stringify(BAD), JSON.stringify(GOOD))
    const result = await draftViewSpec({ provider: p, model: 'm', instruction: 'largest positions' })
    expect(result.attempts).toBe(2)
    expect(result.usage).toHaveLength(2)
    expect((createMessage.mock.calls[1] as any[])[0].content).toMatch(/It was rejected: .*y must be a column of the result/)
  })

  it('gives up after two invalid replies, saying why', async () => {
    const { provider: p } = provider('not json', JSON.stringify(BAD))
    await expect(draftViewSpec({ provider: p, model: 'm', instruction: 'x' })).rejects.toThrow(/Could not build a valid view .*y must be a column/)
  })

  it('revises a current spec by the instruction', async () => {
    const { provider: p, createMessage } = provider(JSON.stringify({ ...GOOD, title: 'Renamed' }))
    const current = parseViewSpec(GOOD)
    const result = await draftViewSpec({ provider: p, model: 'm', instruction: 'rename it', current })
    expect(result.spec.title).toBe('Renamed')
    const content = (createMessage.mock.calls[0] as any[])[0].content as string
    expect(content).toContain('Current spec:')
    expect(content).toContain('Change it like this: rename it')
  })

  it('refuses an empty or overlong description without calling the model', async () => {
    const { provider: p, createMessage } = provider()
    await expect(draftViewSpec({ provider: p, model: 'm', instruction: '  ' })).rejects.toThrow(/Describe the view/)
    await expect(draftViewSpec({ provider: p, model: 'm', instruction: 'x'.repeat(2001) })).rejects.toThrow(/under 2000/)
    expect(createMessage).not.toHaveBeenCalled()
  })
})
