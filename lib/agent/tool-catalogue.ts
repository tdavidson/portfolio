/**
 * The MCP tool catalogue (MCP-TOOLS.md), rendered from the registries the server itself lists.
 *
 * `scripts/generate-mcp-tools-doc.ts` writes it; `lib/agent/tool-catalogue.test.ts` fails when the
 * committed file differs from what this renders, so adding, renaming or re-describing a tool means
 * regenerating the catalogue in the same change. Nothing here is fund data: names, descriptions and
 * the rules each tool runs under.
 */

import { MCP_TOOLS, isPendingTool, type McpTool } from '@/lib/mcp-apps/server'
import { GATEWAY_TOOLS } from '@/lib/mcp-apps/gateway'
import { MASTER_ADMIN_TOOLS } from '@/lib/agent/master-admin'
import { accessDomainFor, type AgentTool } from '@/lib/accounting/agent-tools'
import { hasDraftMode } from '@/lib/agent/dispatch'
import { ADMIN_ONLY_TOOLS } from '@/lib/access/admin-only'
import { DOMAINS, DOMAIN_META } from '@/lib/access/domains'
import type { DashboardTool } from '@/lib/agent/dashboard-tools'

interface Row {
  name: string
  change: boolean
  fromChat: string
  summary: string
}

interface Group {
  title: string
  intro: string
  rows: Row[]
}

/** The first sentence of a description, as search_tools lists it, made safe for a table cell. */
export function firstSentence(description: string): string {
  const first = (description.split(/(?<=[.!?])\s/)[0] ?? description).trim()
  const short = first.length > 200 ? `${first.slice(0, 197)}...` : first
  return short.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
}

/** What a write does when a connected Claude or ChatGPT calls it. Reads are blank. */
function fromChat(tool: McpTool): string {
  if (tool.scope === 'read') return ''
  if (isPendingTool(tool) || (tool as DashboardTool).personal) return 'Runs at once'
  const t = tool as AgentTool
  const notes: string[] = []
  if (t.destructive) notes.push('Admin approves; only offered when the deployment turns deletes on')
  else if (t.stagesAs) notes.push('Always waits for a person, even from a script')
  else if (t.runsDirectly) notes.push('Runs at once')
  else notes.push(hasDraftMode(t.name) ? 'Waits for approval; drafts and previews run at once' : 'Waits for approval')
  if (t.proposable) notes.push('a proposer\'s call becomes a draft proposal')
  const adminOnly = ADMIN_ONLY_TOOLS[t.name]
  if (adminOnly && !t.destructive) notes.push(adminOnly.when ? 'some calls admin only' : 'admin only')
  return notes.join('; ')
}

function row(tool: { name: string; description: string; scope?: string }, chat: string): Row {
  return { name: tool.name, change: tool.scope === 'write', fromChat: chat, summary: firstSentence(tool.description) }
}

/** Every tool the server can list, grouped by the access area that decides who sees it. */
export function toolCatalogueGroups(): Group[] {
  const byDomain = new Map<string, Row[]>()
  const dashboards: Row[] = []
  const approvals: Row[] = []

  for (const tool of MCP_TOOLS) {
    if (isPendingTool(tool)) { approvals.push(row(tool, fromChat(tool))); continue }
    const dash = tool as DashboardTool
    if (dash.ui || dash.personal || DASHBOARD_NAMES.has(tool.name)) { dashboards.push(row(tool, fromChat(tool))); continue }
    const t = tool as AgentTool
    const domain = t.areaInput ? 'records' : accessDomainFor(t)
    const list = byDomain.get(domain) ?? []
    list.push(row(tool, fromChat(tool)))
    byDomain.set(domain, list)
  }

  const groups: Group[] = [{
    title: 'Connection',
    intro: 'Always listed. `list_funds` and `use_fund` appear only on a connection that can work in more than one fund.',
    rows: [
      ...GATEWAY_TOOLS.map(t => row({ ...t, scope: t.name === 'call_tool' ? 'write' : 'read' }, t.name === 'call_tool' ? 'As the tool it runs' : '')),
      ...MASTER_ADMIN_TOOLS.map(t => row({ ...t, scope: 'read' }, '')),
    ],
  }, {
    title: 'Home, help, dashboards and views',
    intro: 'Listed for every member. Each dashboard or view checks the access of the area it reads before it shows a figure.',
    rows: dashboards,
  }, {
    title: 'Approvals',
    intro: 'Staged changes and runs. A member sees and decides only the changes they staged; an admin sees all of them.',
    rows: approvals,
  }]

  for (const domain of DOMAINS) {
    const rows = byDomain.get(domain)
    if (!rows?.length) continue
    groups.push({ title: DOMAIN_META[domain].label, intro: DOMAIN_META[domain].description, rows })
    byDomain.delete(domain)
  }
  for (const [domain, rows] of Array.from(byDomain.entries())) groups.push({ title: domain, intro: '', rows })

  for (const g of groups) g.rows.sort((a, b) => a.name.localeCompare(b.name))
  return groups
}

/** Dashboard-family tools that are neither drawn nor personal (help, the custom-view tools). */
const DASHBOARD_NAMES = new Set(['help', 'whoami'])

export function renderToolCatalogue(): string {
  const groups = toolCatalogueGroups()
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const lines: string[] = [
    '# MCP tool catalogue',
    '',
    '<!-- Generated by `npm run docs:mcp-tools` from the tool registries. Do not edit by hand: lib/agent/tool-catalogue.test.ts fails when this file is out of date. -->',
    '',
    `Every tool the fund's MCP server (\`/api/mcp\`) can list: ${total} in all. How to connect, approvals, funds and limits are in [MCP](./MCP.md).`,
    '',
    'A connection lists only the tools its member may use: the areas they can read, the features the fund has on, and changes only when the connection may change things. The REST agent API (`/api/agent`) runs the same tools apart from the connection, dashboard and approval groups.',
    '',
    '- **Change**: the tool writes. A read-only connection is refused.',
    '- **From a chat**: what a change does when Claude or ChatGPT calls it. With an API key, a change runs at once unless it says it always waits.',
    '- **Admin only**: a member who is not an admin can still propose it from a chat; an admin approves it.',
    '',
    '## Contents',
    '',
    ...groups.map(g => `- [${g.title}](#${anchor(g.title)}) (${g.rows.length})`),
    '',
  ]
  for (const g of groups) {
    lines.push(`## ${g.title}`, '')
    if (g.intro) lines.push(g.intro, '')
    lines.push('| Tool | Change | From a chat | What it does |', '| --- | --- | --- | --- |')
    for (const r of g.rows) lines.push(`| \`${r.name}\` | ${r.change ? 'Yes' : ''} | ${r.fromChat} | ${r.summary} |`)
    lines.push('')
  }
  return lines.join('\n')
}

function anchor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-')
}
