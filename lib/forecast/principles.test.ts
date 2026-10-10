import { describe, expect, it } from 'vitest'
import { FORECASTING_PRINCIPLES } from './principles'
import { FORECAST_TOOL_MANIFEST } from '@/lib/agent/forecast-tools-manifest'
import { CONSTRUCTION_TOOL_MANIFEST } from '@/lib/agent/construction-tools-manifest'
import { WRITE_ACTIONS } from '@/lib/pending-actions/registry'

// The Analyst reasons from tool descriptions. Every tool that drafts a forecast or explains a
// construction figure carries the engine's rules, so what it says matches what the engine computes.
describe('forecasting principles reach the Analyst', () => {
  const has = (d: string | undefined) => (d ?? '').includes(FORECASTING_PRINCIPLES)

  it('on suggesting rules and on portfolio construction', () => {
    expect(has(FORECAST_TOOL_MANIFEST.find(t => t.name === 'forecast_suggest_rules')?.description)).toBe(true)
    expect(has(CONSTRUCTION_TOOL_MANIFEST.find(t => t.name === 'portfolio_construction')?.description)).toBe(true)
  })

  it('on creating and changing a plan', () => {
    expect(has(WRITE_ACTIONS.create_forecast_plan.description)).toBe(true)
    expect(has(WRITE_ACTIONS.update_forecast_plan.description)).toBe(true)
  })

  it('states the rules that are easy to get wrong', () => {
    expect(FORECASTING_PRINCIPLES).toMatch(/GP's own commitment pays no management fee and bears no carry/)
    expect(FORECASTING_PRINCIPLES).toMatch(/mode:"prepaid"/)
    expect(FORECASTING_PRINCIPLES).toMatch(/GP entity's forecast comes from the fund/)
  })
})
