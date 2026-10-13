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

  it('offers the forecast prompts to anyone who can read the books — Forecast has no switch of its own', () => {
    const accountingOnly: CanRead = d => d === 'accounting'
    expect(promptsFor(accountingOnly).map(p => p.name)).toContain('draft_forecast')
  })

  it('turns the close checklist prompt people paste into chat into the app building one', () => {
    const p = promptsFor(d => d === 'accounting').find(t => t.name === 'quarter_end_close_checklist')!
    expect(p).toBeTruthy()
    const text = renderPrompt(p, { lp_delivery_date: '2026-11-16', fund_type: 'pe', portfolio_companies: '12', administrator: 'Juniper' })
      .messages[0].content.text
    expect(text).toContain('private equity fund with 12 portfolio companies, administrator Juniper, and LP reporting due 2026-11-16')
    expect(text).toContain('close_checklist_create')
    expect(text).toMatch(/Tied out/)
    expect(() => renderPrompt(p, {})).toThrow(PromptArgumentError)
    expect(promptsFor(only('portfolio')).map(t => t.name)).not.toContain('quarter_end_close_checklist')
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
