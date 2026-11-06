import { describe, it, expect } from 'vitest'
import { compileSpecterProfile, profileFileName, profileTitle, unwrapMarkdown } from './profile'
import type { AIProvider, CreateToolLoopParams } from '@/lib/ai/types'

const SERVER = { name: 'specter', url: 'https://mcp.tryspecter.com/mcp', authorizationToken: 't', allowedTools: ['find_company'] }

function provider(text: string, seen: CreateToolLoopParams[] = []): AIProvider {
  return {
    supportsToolLoop: true,
    createToolLoop: async (p: CreateToolLoopParams) => {
      seen.push(p)
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ name: 'find_company', input: {}, resultPreview: '', isError: false, server: 'specter' }] }
    },
  } as unknown as AIProvider
}

describe('compileSpecterProfile', () => {
  it('returns the Markdown profile and its title, passing only the member’s server', async () => {
    const seen: CreateToolLoopParams[] = []
    const md = '# Acme Robotics\n\nAcme builds robots.\n\n## Funding and investors\nNot in Specter.'
    const out = await compileSpecterProfile({ provider: provider('```markdown\n' + md + '\n```', seen), model: 'm', server: SERVER, query: 'acme.example', dealName: 'Acme', today: '2026-11-06' })
    expect(out.markdown).toBe(md)
    expect(out.companyName).toBe('Acme Robotics')
    expect(seen[0].mcpServers).toEqual([SERVER])
    expect(seen[0].tools).toBeUndefined()
    expect(String(seen[0].content)).toContain('acme.example')
  })

  it('reports a company Specter couldn’t resolve', async () => {
    const out = await compileSpecterProfile({ provider: provider('NOT_FOUND: two companies named Acme'), model: 'm', server: SERVER, query: 'Acme', dealName: 'Acme', today: '2026-11-06' })
    expect(out.markdown).toBeNull()
    expect(out.notFound).toBe('two companies named Acme')
  })

  it('refuses a provider without tool use', async () => {
    await expect(compileSpecterProfile({ provider: { supportsToolLoop: false } as AIProvider, model: 'm', server: SERVER, query: 'q', dealName: 'd', today: 't' }))
      .rejects.toThrow(/Claude/)
  })
})

describe('profile helpers', () => {
  it('reads the title and unwraps fences', () => {
    expect(profileTitle('intro\n# Northwind  \n')).toBe('Northwind')
    expect(profileTitle('no title')).toBeNull()
    expect(unwrapMarkdown('```md\n# X\n```')).toBe('# X')
    expect(unwrapMarkdown('  # X  ')).toBe('# X')
  })

  it('makes a safe, dated file name', () => {
    expect(profileFileName('Acme / Robotics: "Inc"', 'q', '2026-11-06')).toBe('Specter profile - Acme Robotics Inc (2026-11-06).md')
    expect(profileFileName(null, 'acme.example', '2026-11-06')).toBe('Specter profile - acme.example (2026-11-06).md')
  })
})
