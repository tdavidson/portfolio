import { describe, expect, it } from 'vitest'
import {
  AREAS, PROMPT_TEMPLATES, PromptArgumentError, areasFor, describePrompt, helpText, promptsFor, renderPrompt,
  type CanRead,
} from './getting-started'
import { DOMAINS } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import { MCP_TOOLS } from '@/lib/mcp-apps/server'

const only = (...domains: string[]): CanRead => d => domains.includes(d)

describe('getting-started catalog', () => {
  it('names real domains and feature switches', () => {
    for (const x of [...AREAS, ...PROMPT_TEMPLATES]) {
      if (x.domain) expect(DOMAINS, (x as any).label ?? (x as any).name).toContain(x.domain)
      if (x.feature) expect(Object.keys(DEFAULT_FEATURE_VISIBILITY)).toContain(x.feature)
    }
  })

  it('filters areas and prompts to what the member can read', () => {
    expect(areasFor(only('portfolio')).map(a => a.key)).toEqual(['portfolio'])
    const names = promptsFor(only('portfolio')).map(p => p.name)
    expect(names).toEqual(['get_started', 'portfolio_review', 'company_check_in'])
    // No member to filter for (the Support page, the plugin README): everything.
    expect(areasFor().length).toBe(AREAS.length)
  })

  it('keeps forecast prompts behind the Forecast switch, not just accounting', () => {
    const accountingOnly: CanRead = (d, f) => d === 'accounting' && f !== 'budgeting'
    expect(promptsFor(accountingOnly).map(p => p.name)).not.toContain('draft_forecast')
  })

  it('renders a template with its arguments, and refuses a missing required one', () => {
    const p = PROMPT_TEMPLATES.find(t => t.name === 'company_check_in')!
    expect(renderPrompt(p, { company: 'Meridian' }).messages[0].content.text).toContain('Open the dashboard for Meridian')
    expect(() => renderPrompt(p, {})).toThrow(PromptArgumentError)
    expect(describePrompt(p)).toMatchObject({ name: 'company_check_in', title: 'Company check-in', arguments: [{ name: 'company', required: true }] })
  })

  it('only mentions tools the MCP endpoint actually serves', () => {
    const names = new Set(MCP_TOOLS.map(t => t.name))
    for (const p of PROMPT_TEMPLATES) {
      const mentioned = p.text({ vehicle: 'X', company: 'Y' }).match(/\b[a-z]+_[a-z_]+\b/g) ?? []
      for (const tool of mentioned.filter(m => m !== 'last_quarter')) expect(names, `${p.name} names ${tool}`).toContain(tool)
    }
  })

  it('writes help text without tool names, scoped to the areas given', () => {
    const text = helpText({ fundName: 'Northgate', canRead: only('portfolio'), dashboards: ['Portfolio overview'], saved: [] })
    expect(text).toContain("Northgate's Portfolio deployment")
    expect(text).toContain('Portfolio (')
    expect(text).not.toContain('LP capital (')
  })
})
