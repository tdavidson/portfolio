import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { connectorUrl, isPluginTarget, pluginFilename, pluginFiles, pluginName, pluginZip } from './build'
import { PLUGIN_FILES } from './plugin-files.generated'
import { MCP_TOOLS } from '@/lib/mcp-apps/server'

const ctx = { origin: 'https://portfolio.northgate.vc', fundName: 'Northgate Ventures', version: '1.2.3' }

describe('the plugin\'s identity', () => {
  it('points the connector at this deployment\'s own MCP endpoint', () => {
    expect(connectorUrl('https://portfolio.northgate.vc')).toBe('https://portfolio.northgate.vc/api/mcp')
    expect(connectorUrl('https://portfolio.northgate.vc/')).toBe('https://portfolio.northgate.vc/api/mcp')
  })

  it('is named after the host, so two funds\' plugins are two plugins', () => {
    expect(pluginName('https://portfolio.northgate.vc')).toBe('portfolio-portfolio-northgate-vc')
    expect(pluginName('https://portfolio.northgate.vc')).not.toBe(pluginName('https://app.otherfund.com'))
  })

  it('is always kebab-case and bounded, whatever the host looks like', () => {
    for (const origin of ['http://localhost:3000', 'https://UPPER.Example.COM', 'https://xn--bcher-kva.example', `https://${'a'.repeat(200)}.example.com`, 'not a url', '']) {
      const name = pluginName(origin)
      expect(name, origin).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(name.length, origin).toBeLessThanOrEqual(64)
    }
  })
})

describe('the Claude package', () => {
  const files = pluginFiles('claude', ctx)

  it('has the manifest where Claude looks for it, and only the manifest there', () => {
    const manifest = JSON.parse(files['.claude-plugin/plugin.json'])
    expect(manifest).toMatchObject({ name: 'portfolio-portfolio-northgate-vc', displayName: 'Northgate Ventures Portfolio', version: '1.2.3', license: 'Apache-2.0' })
    expect(manifest.description.length).toBeGreaterThan(40)
    expect(Object.keys(files).filter(p => p.startsWith('.claude-plugin/'))).toEqual(['.claude-plugin/plugin.json'])
  })

  it('bundles the connector as a fixed https URL and nothing else', () => {
    expect(JSON.parse(files['.mcp.json'])).toEqual({ mcpServers: { portfolio: { type: 'http', url: 'https://portfolio.northgate.vc/api/mcp' } } })
  })

  it('has nothing that stops claude.ai installing it', () => {
    // A top-level bin/ makes claude.ai and Cowork refuse the whole plugin; a templated URL is ignored.
    expect(Object.keys(files).some(p => p.startsWith('bin/'))).toBe(false)
    expect(files['.mcp.json']).not.toContain('${')
  })
})

describe('the ChatGPT package', () => {
  const files = pluginFiles('chatgpt', ctx)

  it('has the manifest and the connector at the root, registering clients on request', () => {
    const manifest = JSON.parse(files['plugin.json'])
    expect(manifest).toMatchObject({ name: 'portfolio-portfolio-northgate-vc', version: '1.2.3' })
    expect(manifest.extensions['com.openai'].interface.displayName).toBe('Northgate Ventures Portfolio')

    const server = JSON.parse(files['mcp.json']).mcpServers.portfolio
    expect(server).toMatchObject({ type: 'streamable-http', url: 'https://portfolio.northgate.vc/api/mcp' })
    expect(server.extensions['com.openai'].auth).toEqual({
      type: 'oauth', client: { mode: 'dcr' }, registrationUrl: 'https://portfolio.northgate.vc/api/oauth/register',
    })
  })

  it('does not carry Claude\'s manifest, nor Claude\'s the other way', () => {
    expect(files['.claude-plugin/plugin.json']).toBeUndefined()
    expect(pluginFiles('claude', ctx)['plugin.json']).toBeUndefined()
  })
})

describe('both packages', () => {
  it.each(['claude', 'chatgpt'] as const)('%s: carries every skill, each with a name matching its folder', target => {
    const files = pluginFiles(target, ctx)
    const skills = Object.keys(files).filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p))
    expect(skills.sort()).toEqual(['skills/fund-analysis/SKILL.md', 'skills/fund-dashboards/SKILL.md'])
    for (const path of skills) {
      const folder = path.split('/')[1]
      const front = /^---\n([\s\S]*?)\n---\n/.exec(files[path])
      expect(front, path).toBeTruthy()
      expect(front![1], path).toMatch(new RegExp(`^name: ${folder}$`, 'm'))
      expect(front![1], path).toMatch(/^description: /m)
    }
  })

  it.each(['claude', 'chatgpt'] as const)('%s: holds no credential and no placeholder for one', target => {
    const all = Object.values(pluginFiles(target, ctx)).join('\n')
    expect(all).not.toMatch(/lk_[A-Za-z0-9_-]{8,}|mcp_at_|Bearer |Authorization|client_secret|api[_-]?key/i)
  })

  it('has a README that says what it does and what data it sends, with this deployment\'s address', () => {
    const readme = pluginFiles('claude', ctx)['README.md']
    expect(readme.split(/\s+/).length).toBeGreaterThan(40)
    expect(readme).toMatch(/## Data/)
    expect(readme).toContain('https://portfolio.northgate.vc/api/mcp')
  })

  it('falls back to the product\'s name when the fund has none', () => {
    const manifest = JSON.parse(pluginFiles('claude', { ...ctx, fundName: null })['.claude-plugin/plugin.json'])
    expect(manifest.displayName).toBe('Portfolio')
    expect(manifest.author.name).toBe('Portfolio')
  })

  it('zips with the plugin at the archive root', async () => {
    const zip = await JSZip.loadAsync(await pluginZip('claude', ctx))
    expect(Object.keys(zip.files)).toContain('.claude-plugin/plugin.json')
    expect(Object.keys(zip.files)).toContain('skills/fund-dashboards/SKILL.md')
    expect(await zip.file('.mcp.json')!.async('string')).toContain('https://portfolio.northgate.vc/api/mcp')
    expect(pluginFilename('claude', ctx)).toBe('portfolio-portfolio-northgate-vc-claude.zip')
  })

  it('knows its two targets', () => {
    expect(isPluginTarget('claude')).toBe(true)
    expect(isPluginTarget('chatgpt')).toBe(true)
    expect(isPluginTarget('gemini')).toBe(false)
    expect(isPluginTarget(null)).toBe(false)
  })
})

describe('the skills name only tools that exist', () => {
  // A skill that tells the assistant to call a tool the server does not have fails in front of
  // the user. Every `backticked_name` in a skill that looks like a tool must be one.
  const known = new Set(MCP_TOOLS.map(t => t.name))
  const NOT_TOOLS = new Set(['this_quarter', 'last_quarter', 'prior_year', 'as_of'])

  it.each(Object.keys(PLUGIN_FILES).filter(p => p.endsWith('SKILL.md')))('%s', path => {
    const mentioned = Array.from(PLUGIN_FILES[path].matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)).map(m => m[1])
    expect(mentioned.length).toBeGreaterThan(3)
    expect(mentioned.filter(name => !known.has(name) && !NOT_TOOLS.has(name))).toEqual([])
  })
})
