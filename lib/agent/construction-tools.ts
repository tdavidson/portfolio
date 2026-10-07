import type { AgentToolHandler } from '@/lib/accounting/agent-tools'
import { getConstructionModel } from '@/lib/accounting/construction-service'

export const CONSTRUCTION_HANDLERS: Record<string, AgentToolHandler> = {
  portfolio_construction: async ({ admin, fundId, access }, input) => {
    if (typeof input?.vehicle !== 'string' || !input.vehicle.trim()) {
      throw new Error('vehicle is required')
    }
    return getConstructionModel({ admin, fundId, access }, { vehicle: input.vehicle })
  },
}
