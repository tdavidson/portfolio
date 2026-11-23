import { describe, it, expect } from 'vitest'
import { fetchAllRowsById } from './load'

// A fake PostgREST table that honours the keyset filters and caps each response at 1000 rows, and
// counts how many rows it handed out, so the test can show each row is read once.
function keysetTable(rows: { id: string; v: number }[]) {
  const served = { rows: 0, calls: 0 }
  const base = () => {
    const filters: ((r: any) => boolean)[] = []
    let max = Infinity
    const q: any = {
      gte: (k: string, v: string) => { filters.push(r => r[k] >= v); return q },
      lt: (k: string, v: string) => { filters.push(r => r[k] < v); return q },
      gt: (k: string, v: string) => { filters.push(r => r[k] > v); return q },
      order: () => q,
      limit: (n: number) => { max = n; return q },
      range: () => { throw new Error('keyset reads do not use OFFSET') },
      then: (resolve: (v: any) => any) => {
        const out = rows.filter(r => filters.every(f => f(r))).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, Math.min(max, 1000))
        served.rows += out.length; served.calls++
        return resolve({ data: out, error: null })
      },
    }
    return q
  }
  return { base, served }
}

// Deterministic uuid-shaped ids spread over the whole id space.
const uuid = (i: number) => {
  const h = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0')
  return `${h}-0000-4000-8000-${String(i).padStart(12, '0')}`
}

describe('fetchAllRowsById', () => {
  it('reads every row once, in id order, across slices and pages', async () => {
    const rows = Array.from({ length: 5_321 }, (_, i) => ({ id: uuid(i), v: i }))
    const t = keysetTable(rows)
    const got = await fetchAllRowsById<{ id: string; v: number }>(t.base)
    expect(got.map(r => r.id)).toEqual([...rows].map(r => r.id).sort())
    expect(t.served.rows).toBe(rows.length)
  })

  it('gives the same rows with one slice', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => ({ id: uuid(i), v: i }))
    const got = await fetchAllRowsById<{ id: string; v: number }>(keysetTable(rows).base, { shards: 1 })
    expect(got.map(r => r.id)).toEqual(rows.map(r => r.id).sort())
  })

  it('pages with OFFSET when the builder has no keyset filters', async () => {
    const rows = Array.from({ length: 1_500 }, (_, i) => ({ id: uuid(i), v: i }))
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))
    const base = () => {
      let from = 0, to = 0
      const q: any = {
        order: () => q,
        range: (f: number, t: number) => { from = f; to = t; return q },
        then: (resolve: (v: any) => any) => resolve({ data: sorted.slice(from, to + 1), error: null }),
      }
      return q
    }
    expect(await fetchAllRowsById(base)).toHaveLength(1_500)
  })
})
