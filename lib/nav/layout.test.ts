import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { NAV_LAYOUTS, NAV_LAYOUT_OPTIONS, DEFAULT_NAV_LAYOUT, parseNavLayout, isNavLayout } from './layout'

describe('nav layout', () => {
  it('reads anything unrecognised as the original sidebar', () => {
    expect(DEFAULT_NAV_LAYOUT).toBe('sidebar')
    expect(parseNavLayout(undefined)).toBe('sidebar')
    expect(parseNavLayout('sideways')).toBe('sidebar')
    expect(parseNavLayout('top')).toBe('top')
    expect(isNavLayout('fixed')).toBe(true)
    expect(isNavLayout(3)).toBe(false)
  })

  it('offers every layout in Settings exactly once', () => {
    expect(NAV_LAYOUT_OPTIONS.map(o => o.value).sort()).toEqual([...NAV_LAYOUTS].sort())
  })

  it('matches the values the database allows', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261123120000_member_nav_layout.sql'), 'utf8')
    const allowed = sql.match(/nav_layout in \(([^)]*)\)/)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1))
    expect(allowed?.sort()).toEqual([...NAV_LAYOUTS].sort())
    expect(sql).toContain(`default '${DEFAULT_NAV_LAYOUT}'`)
  })
})
