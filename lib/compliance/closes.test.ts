import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { closeMonthsFor, loadCloseDates } from './closes'

const db = () => memoryAdmin({
  fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I' }, { id: 'v2', fund_id: 'f1', name: 'Fund II' }, { id: 'vx', fund_id: 'f2', name: 'Other' }],
  vehicle_closings: [
    { id: 'c1', fund_id: 'f1', vehicle_id: 'v1', name: 'First Close', close_date: '2026-03-15' },
    { id: 'c2', fund_id: 'f1', vehicle_id: 'v1', name: 'Final Close', close_date: '2026-09-30' },
    { id: 'c3', fund_id: 'f1', vehicle_id: 'v2', name: 'First Close', close_date: '2025-11-01' },
    { id: 'c4', fund_id: 'f2', vehicle_id: 'vx', name: 'First Close', close_date: '2026-05-01' },
  ],
  fund_cash_flows: [
    // A fund that recorded its closes the old way keeps them; the same date twice counts once.
    { id: 'f-a', fund_id: 'f1', portfolio_group: 'Fund I', flow_type: 'commitment', flow_date: '2026-03-15' },
    { id: 'f-b', fund_id: 'f1', portfolio_group: 'Fund II', flow_type: 'commitment', flow_date: '2026-06-01' },
    { id: 'f-c', fund_id: 'f1', portfolio_group: 'Fund II', flow_type: 'distribution', flow_date: '2026-07-01' },
  ],
}).admin as any

describe('close dates for the compliance calendar', () => {
  it('reads closings by vehicle name, merged with legacy commitment rows, within the window and the fund', async () => {
    expect(await loadCloseDates(db(), 'f1', '2026-01-01', '2026-12-31')).toEqual({
      'Fund I': ['2026-03-15', '2026-09-30'],
      'Fund II': ['2026-06-01'],
    })
  })

  it('gives each vehicle its close months for a year', () => {
    expect(closeMonthsFor({ 'Fund I': ['2025-12-31', '2026-03-01', '2026-03-20', '2026-09-30'], 'Fund II': ['2025-11-01'] }, 2026))
      .toEqual({ 'Fund I': [3, 9] })
  })
})
