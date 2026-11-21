// Writes MCP-TOOLS.md from the tool registries (lib/agent/tool-catalogue.ts).
// Run after adding, renaming or re-describing an MCP tool: npm run docs:mcp-tools
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToolCatalogue } from '../lib/agent/tool-catalogue'

const out = join(process.cwd(), 'MCP-TOOLS.md')
writeFileSync(out, renderToolCatalogue())
console.log(`Wrote ${out}`)
