import { describe, expect, it } from 'vitest'
import { buildHelp, helpTopic, HELP_TOPICS, type HelpInput } from './help'
import { AREAS, type CanRead } from './getting-started'
import { startersFor, STARTER_VIEWS } from '@/lib/custom-views/starters'
import { MCP_TOOLS } from '@/lib/mcp-apps/server'
import { GATEWAY_TOOLS } from '@/lib/mcp-apps/gateway'
import { LIST_FUNDS, USE_FUND } from './master-admin'

const only = (...domains: string[]): CanRead => d => domains.includes(d)

const input = (over: Partial<HelpInput> = {}): HelpInput => ({
  fundName: 'Example Fund',
  canRead: only('portfolio'),
  dashboards: ['Portfolio overview'],
  savedDashboards: [],
  savedViews: ['Monday view'],
  starters: startersFor(only('portfolio')),
  ...over,
})

describe('help topics', () => {
  it('reads a topic by name or near miss, and falls back to the overview', () => {
    expect(helpTopic(undefined)).toBe('overview')
    expect(helpTopic('Views')).toBe('views')
    expect(helpTopic('custom view')).toBe('views')
    expect(helpTopic('common views')).toBe('starters')
    expect(helpTopic('graphs')).toBe('charts')
    expect(helpTopic('PDF')).toBe('exports')
    expect(helpTopic('LP capital')).toBe('lps')
    expect(helpTopic('something else')).toBe('overview')
  })

  it('covers every area of the getting-started catalog', () => {
    for (const a of AREAS) expect(HELP_TOPICS).toContain(a.key)
  })
})

describe('buildHelp', () => {
  it('gives an overview scoped to the member, with their views and the starters they can use', () => {
    const h = buildHelp(input())
    expect(h.topic).toBe('overview')
    expect(h.text).toContain("Example Fund's Portfolio app")
    expect(h.text).toContain('Portfolio: ')
    expect(h.text).not.toContain('LP capital: ')
    expect(h.text).toContain('Monday view')
    expect(h.saved_views).toEqual(['Monday view'])
    expect(h.starters!.map(s => s.key)).toEqual(startersFor(only('portfolio')).map(s => s.key))
    // Areas the member cannot read are not offered as topics.
    expect(h.more_topics.map(t => t.topic)).not.toContain('lps')
    expect(h.more_topics.map(t => t.topic)).toContain('views')
  })

  it('returns each starter with a spec ready to preview, only on the starters topic', () => {
    const h = buildHelp(input({ topic: 'starters' }))
    expect(h.starters!.every(s => s.spec && Array.isArray((s.spec as any).blocks))).toBe(true)
    expect(buildHelp(input({ topic: 'views' })).starters!.every(s => s.spec === undefined)).toBe(true)
  })

  it('says so when no starter fits, and never describes an area the member lacks', () => {
    expect(buildHelp(input({ topic: 'starters', starters: [] })).text).toContain('None of the starters')
    const lp = buildHelp(input({ topic: 'lps' }))
    expect(lp.text).toContain('does not include that area')
    expect(lp.text).not.toContain('capital call')
  })

  it('answers an area with its questions and its own starters', () => {
    const all = STARTER_VIEWS
    const h = buildHelp(input({ topic: 'lps', canRead: only('portfolio', 'lp_capital'), starters: all }))
    expect(h.text).toContain('Who has funded their capital calls?')
    expect(h.starters!.map(s => s.key)).toEqual(all.filter(s => s.area === 'lps').map(s => s.key))
  })

  it('keeps tool names out of the text for the user, and names only tools the server serves', () => {
    const served = new Set([...MCP_TOOLS.map(t => t.name), ...GATEWAY_TOOLS.map(t => t.name), LIST_FUNDS, USE_FUND])
    const everything: CanRead = () => true
    for (const topic of HELP_TOPICS) {
      const h = buildHelp(input({ topic, canRead: everything, starters: STARTER_VIEWS }))
      expect(h.text, topic).not.toMatch(/\b(show|list|open|save|preview|export)_[a-z_]+\b/)
      for (const name of (h.for_assistant.match(/\b[a-z]+_[a-z_]+\b/g) ?? []).filter(n => n !== 'as_of')) expect(served, `${topic} names ${name}`).toContain(name)
    }
  })
})
