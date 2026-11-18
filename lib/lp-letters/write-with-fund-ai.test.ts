import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMessage = vi.fn()
vi.mock('@/lib/ai', () => ({
  createFundAIProvider: async () => ({ provider: { createMessage }, model: 'claude-example-1', providerType: 'anthropic' }),
}))
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: async () => {} }))
vi.mock('./brief', async orig => ({ ...(await orig<typeof import('./brief')>()), writerPrompt: () => 'Write the letter.' }))

import { writeWithFundAI, LetterDraftError, LETTER_MAX_TOKENS } from './draft-from-brief'

const usage = { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 }
const write = () => writeWithFundAI({} as any, 'fund-1', 'user-1', {} as any, {} as any, null)

beforeEach(() => createMessage.mockReset())

describe('writeWithFundAI', () => {
  it('asks for room for a whole letter at low effort and returns the text', async () => {
    createMessage.mockResolvedValueOnce({ text: '  Dear partners.\n\n## Fund performance\nNet TVPI is 1.5x.  ', usage, truncated: false })
    expect(await write()).toBe('Dear partners.\n\n## Fund performance\nNet TVPI is 1.5x.')
    expect(createMessage.mock.calls[0][0]).toMatchObject({ maxTokens: LETTER_MAX_TOKENS, effort: 'low' })
    expect(LETTER_MAX_TOKENS).toBeGreaterThan(8000)
  })

  it('says the limit ran out before any text when the model used it all thinking', async () => {
    createMessage.mockResolvedValueOnce({ text: '', usage: { ...usage, outputTokens: LETTER_MAX_TOKENS }, truncated: true })
    await expect(write()).rejects.toThrow(LetterDraftError)
    createMessage.mockResolvedValueOnce({ text: '', usage, truncated: true })
    await expect(write()).rejects.toThrow(/before writing any of the letter/)
  })

  it('refuses a letter cut off at the limit rather than returning half of it', async () => {
    createMessage.mockResolvedValueOnce({ text: 'Dear partners.\n\n## Acme\nAcme gr', usage, truncated: true })
    await expect(write()).rejects.toThrow(/cut off/)
  })
})
