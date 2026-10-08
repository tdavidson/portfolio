import { describe, it, expect } from 'vitest'
import { currentOwnership, type InvestmentRow } from './load'

/**
 * `lp_investments` holds one row per LP *per snapshot*, each carrying that snapshot's
 * cumulative-to-date figures. Summing them multiplied every commitment by the fund's
 * snapshot count, which fed capital-call pro-rata, management-fee basis, the close's
 * allocation basis, and published LP statements. These tests pin the dedupe.
 */
describe('currentOwnership', () => {
  const snap = (as_of_date: string, created_at = '2026-01-01T00:00:00Z') => ({ as_of_date, created_at })

  it('takes the latest snapshot rather than summing across snapshots', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 1_000_000, paid_in_capital: 250_000, distributions: 0, snapshot_id: 's1', lp_snapshots: snap('2026-03-31') },
      { entity_id: 'a', commitment: 1_000_000, paid_in_capital: 500_000, distributions: 50_000, snapshot_id: 's2', lp_snapshots: snap('2026-06-30') },
    ]
    expect(currentOwnership(rows)).toEqual([
      { lpEntityId: 'a', commitment: 1_000_000, paidIn: 500_000, distributions: 50_000 },
    ])
  })

  it('does not care what order the rows arrive in', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 900_000, snapshot_id: 's3', lp_snapshots: snap('2026-09-30') },
      { entity_id: 'a', commitment: 500_000, snapshot_id: 's1', lp_snapshots: snap('2026-03-31') },
      { entity_id: 'a', commitment: 700_000, snapshot_id: 's2', lp_snapshots: snap('2026-06-30') },
    ]
    expect(currentOwnership(rows)[0].commitment).toBe(900_000)
  })

  it('picks up a commitment increase recorded on the newer snapshot', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 1_000_000, snapshot_id: 's1', lp_snapshots: snap('2026-03-31') },
      { entity_id: 'a', commitment: 1_500_000, snapshot_id: 's2', lp_snapshots: snap('2026-06-30') },
    ]
    expect(currentOwnership(rows)[0].commitment).toBe(1_500_000)
  })

  it('breaks a same-as_of_date tie on the snapshot created_at', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 100, snapshot_id: 's1', lp_snapshots: snap('2026-06-30', '2026-07-01T00:00:00Z') },
      { entity_id: 'a', commitment: 200, snapshot_id: 's2', lp_snapshots: snap('2026-06-30', '2026-07-02T00:00:00Z') },
    ]
    expect(currentOwnership(rows)[0].commitment).toBe(200)
  })

  it('prefers a snapshotted row over an unsnapshotted one', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 999, snapshot_id: null, updated_at: '2026-12-31T00:00:00Z' },
      { entity_id: 'a', commitment: 1_000_000, snapshot_id: 's1', lp_snapshots: snap('2026-03-31') },
    ]
    expect(currentOwnership(rows)[0].commitment).toBe(1_000_000)
  })

  it('falls back to the most recent unsnapshotted row when the entity has no snapshotted one', () => {
    // The accounting Add-LP path writes an unsnapshotted row when the fund has no snapshots.
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 300, snapshot_id: null, updated_at: '2026-05-01T00:00:00Z' },
      { entity_id: 'a', commitment: 400, snapshot_id: null, updated_at: '2026-06-01T00:00:00Z' },
    ]
    expect(currentOwnership(rows)[0].commitment).toBe(400)
  })

  it('keeps entities separate and tolerates Supabase returning the join as an array', () => {
    const rows: InvestmentRow[] = [
      { entity_id: 'a', commitment: 600_000, snapshot_id: 's1', lp_snapshots: [snap('2026-06-30')] },
      { entity_id: 'b', commitment: 400_000, snapshot_id: 's1', lp_snapshots: [snap('2026-06-30')] },
    ]
    const out = currentOwnership(rows).sort((x, y) => x.lpEntityId.localeCompare(y.lpEntityId))
    expect(out.map(o => o.commitment)).toEqual([600_000, 400_000])
  })

  it('treats missing money columns as zero, not NaN', () => {
    const rows: InvestmentRow[] = [{ entity_id: 'a', snapshot_id: 's1', lp_snapshots: snap('2026-06-30') }]
    expect(currentOwnership(rows)).toEqual([{ lpEntityId: 'a', commitment: 0, paidIn: 0, distributions: 0 }])
  })
})
