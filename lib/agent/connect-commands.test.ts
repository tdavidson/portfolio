import { describe, expect, it } from 'vitest'
import { connectSteps, CONNECTOR_NAME } from './connect-commands'

describe('connectSteps', () => {
  const url = 'https://portfolio.fund.example/api/mcp'
  const steps = connectSteps(url)

  it('fills every command with the deployment URL', () => {
    const commands = steps.filter(s => s.command).map(s => s.command!)
    expect(commands.length).toBeGreaterThan(4)
    for (const c of commands) expect(c).toContain(url)
  })

  it('covers the clients the docs promise', () => {
    const clients = steps.map(s => s.client).join(' | ')
    for (const name of ['Claude', 'ChatGPT', 'Claude Code', 'Codex', 'VS Code', 'Cursor']) {
      expect(clients).toContain(name)
    }
  })

  it('writes valid JSON for the config-based clients', () => {
    const cursor = steps.find(s => s.client === 'Cursor')!.command!
    expect(JSON.parse(cursor).mcpServers[CONNECTOR_NAME].url).toBe(url)
    const vscode = steps.find(s => s.client === 'VS Code')!.command!
    expect(JSON.parse(vscode.slice(vscode.indexOf("'") + 1, vscode.lastIndexOf("'")))).toEqual({ name: CONNECTOR_NAME, type: 'http', url })
  })

  it('shows a placeholder before the URL loads', () => {
    expect(connectSteps('').find(s => s.client === 'Claude Code')!.command).toContain('<MCP URL>')
  })
})
