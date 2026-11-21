import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { renderToolCatalogue, toolCatalogueGroups } from './tool-catalogue'
import { MCP_TOOLS } from '@/lib/mcp-apps/server'

describe('MCP tool catalogue', () => {
  it('lists every tool the server can list, once', () => {
    const listed = toolCatalogueGroups().flatMap(g => g.rows.map(r => r.name))
    expect(listed.filter((n, i) => listed.indexOf(n) !== i)).toEqual([])
    for (const t of MCP_TOOLS) expect(listed, t.name).toContain(t.name)
  })

  it('MCP-TOOLS.md is up to date (run npm run docs:mcp-tools)', () => {
    const committed = readFileSync(join(process.cwd(), 'MCP-TOOLS.md'), 'utf8')
    expect(committed).toBe(renderToolCatalogue())
  })
})
