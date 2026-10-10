import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import JSZip from 'jszip'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * GET /api/plugin: the package a member installs in Claude or ChatGPT. What matters is that it
 * is members-only, that it carries THIS deployment's address (the one the request came in on),
 * and that it is not handed out while the fund's agent switch is off.
 */

let user: { id: string } | null = { id: 'user-me' }
let enabled = true
const store = memoryAdmin({
  fund_members: [{ user_id: 'user-me', fund_id: 'fund-1', role: 'member' }],
  funds: [{ id: 'fund-1', name: 'Northgate Ventures' }],
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => enabled }))

import { GET } from '@/app/api/plugin/route'

const get = (query: string, host = 'portfolio.northgate.vc') =>
  GET(new NextRequest(`https://${host}/api/plugin${query}`, { headers: { host } }))

beforeEach(() => { user = { id: 'user-me' }; enabled = true })

describe('GET /api/plugin', () => {
  it('builds the Claude package for the address the member is on', async () => {
    const res = await get('?target=claude')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="portfolio-portfolio-northgate-vc-claude.zip"')
    expect(res.headers.get('cache-control')).toContain('no-store')

    const zip = await JSZip.loadAsync(await res.arrayBuffer())
    expect(JSON.parse(await zip.file('.mcp.json')!.async('string')).mcpServers.portfolio.url).toBe('https://portfolio.northgate.vc/api/mcp')
    expect(JSON.parse(await zip.file('.claude-plugin/plugin.json')!.async('string')).displayName).toBe('Northgate Ventures Portfolio')
    expect(zip.file('skills/fund-dashboards/SKILL.md')).toBeTruthy()
  })

  it('follows the host the request came in on, as the OAuth metadata does', async () => {
    // A second custom domain, a preview deploy: the assistant must be sent back to the same one.
    const zip = await JSZip.loadAsync(await (await get('?target=chatgpt', 'funds.example.org')).arrayBuffer())
    const server = JSON.parse(await zip.file('mcp.json')!.async('string')).mcpServers.portfolio
    expect(server.url).toBe('https://funds.example.org/api/mcp')
    expect(server.extensions['com.openai'].auth.registrationUrl).toBe('https://funds.example.org/api/oauth/register')
  })

  it('is for signed-in members only', async () => {
    user = null
    expect((await get('?target=claude')).status).toBe(401)
    user = { id: 'someone-with-no-fund' }
    expect((await get('?target=claude')).status).toBe(403)
  })

  it('refuses an unknown target', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?target=gemini')).status).toBe(400)
  })

  it('is not handed out while agent access is off for the fund', async () => {
    enabled = false
    const res = await get('?target=claude')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/Agent access is disabled/)
  })
})
