import { describe, it, expect } from 'vitest'
import { getWriteAction, WRITE_ACTIONS } from '@/lib/pending-actions/registry'

describe('write-action registry', () => {
  it('maps each action to its access domain', () => {
    expect(getWriteAction('update_company_metric')?.domain).toBe('portfolio')
    expect(getWriteAction('record_investment')?.domain).toBe('portfolio')
    expect(getWriteAction('issue_capital_call')?.domain).toBe('lp_capital')
    expect(getWriteAction('update_portfolio_construction')?.domain).toBe('accounting')
  })

  it('requires accounting write access to stage construction changes', () => {
    expect(getWriteAction('update_portfolio_construction')?.stageAccess).toBe('write')
  })

  it('stages budget & forecast changes behind accounting write, with no switch of their own', () => {
    for (const name of ['create_forecast_plan', 'update_forecast_plan', 'publish_forecast_plan']) {
      const a = getWriteAction(name)!
      expect(a.domain, name).toBe('accounting')
      expect(a.accessFeature, name).toBeUndefined()
      expect(a.stageAccess, name).toBe('write')
      expect(a.entity, name).toBe('required')
      expect(a.managementCompanies, name).toBe(true)
    }
  })

  it('carries the investments feature on record_investment', () => {
    expect(getWriteAction('record_investment')?.accessFeature).toBe('investments')
  })

  it('returns undefined for an unknown action', () => {
    expect(getWriteAction('nope')).toBeUndefined()
  })

  it('gives every action a preview and execute', () => {
    for (const action of Object.values(WRITE_ACTIONS)) {
      expect(typeof action.preview).toBe('function')
      expect(typeof action.execute).toBe('function')
      expect(action.inputSchema).toBeTypeOf('object')
    }
  })
})

describe('agent tools that stage a pending action', () => {
  // A `stagesAs` tool's schema is a copy of its action's (the manifest cannot import the server
  // registry). Approval runs the action's input, so a field the tool drops is a field the person
  // asked for and silently lost.
  it('take the same input as the action they stage, and agree on its domain', async () => {
    const { AGENT_TOOLS } = await import('@/lib/accounting/agent-tools')
    const staged = AGENT_TOOLS.filter(t => t.stagesAs)
    expect(staged.map(t => t.name).sort()).toEqual(['issue_capital_call', 'publish_call_notices'])
    for (const tool of staged) {
      const action = getWriteAction(tool.stagesAs!)!
      expect(action, tool.name).toBeTruthy()
      expect(tool.accessDomain, tool.name).toBe(action.domain)
      expect(Object.keys(tool.inputSchema.properties).sort(), tool.name)
        .toEqual(Object.keys((action.inputSchema as any).properties).sort())
      // Descriptions may be worded for the chat; the types may not differ.
      const types = (props: Record<string, any>) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.type]))
      expect(types(tool.inputSchema.properties), tool.name).toEqual(types((action.inputSchema as any).properties))
    }
  })
})
