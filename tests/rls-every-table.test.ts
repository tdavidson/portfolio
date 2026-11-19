import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// Row-level security is the backstop behind the service-role routes: if a public table ships
// without it, any grant to anon or authenticated exposes every row to the browser, with only the
// public anon key. These checks read the migration SQL (same shape as db-security-hardening.test.ts),
// so they run in CI without a database:
//
//  1. Every table created in public has `enable row level security` somewhere in the history,
//     and no migration turns it off again.
//  2. New tables get no Data API grants by default (20261119120000), and no later migration hands
//     the defaults back to anon or authenticated.
//  3. Every table created after that migration carries its own grant, as CLAUDE.md requires;
//     without the defaults, a table with no grant is invisible to the app.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '')
const read = (f: string) => stripComments(readFileSync(join(MIGRATIONS, f), 'utf8'))
const sql = files.map(read).join('\n')

const DEFAULTS_MIGRATION = '20261119120000_default_privileges_and_anon_writes.sql'

/** A table name, optionally qualified with public and optionally quoted. */
const PUBLIC_IDENT = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`

/** Tables created in public: unqualified names land there, since search_path starts with it. */
function createdTables(text: string): string[] {
  const re = /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?("?\w+"?\.)?"?([a-z_][a-z0-9_]*)"?/gi
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    if (!m[1] || /^"?public"?\.$/i.test(m[1])) out.push(m[2].toLowerCase())
  }
  return out
}

function tablesMatching(pattern: string): Set<string> {
  const re = new RegExp(pattern.replace('IDENT', PUBLIC_IDENT), 'gi')
  return new Set([...sql.matchAll(re)].map(m => m[1].toLowerCase()))
}

describe('every public table has row-level security', () => {
  const created = new Set(createdTables(sql))
  const enabled = tablesMatching(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?IDENT\s+enable\s+row\s+level\s+security`)
  // A loop over table names (`format('alter table public.%I enable row level security', t)`)
  // cannot be matched by name, so a table it covers must also be enabled by name to pass.

  it('finds the tables (guards against a parser that silently matches nothing)', () => {
    expect(created.size).toBeGreaterThan(100)
  })

  it('enables RLS on each table created in public', () => {
    const missing = [...created].filter(t => !enabled.has(t)).sort()
    expect(missing, `add "alter table public.<name> enable row level security;" for: ${missing.join(', ')}`).toEqual([])
  })

  it('never disables RLS on a public table', () => {
    const disabled = tablesMatching(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?IDENT\s+disable\s+row\s+level\s+security`)
    expect([...disabled]).toEqual([])
  })
})

describe('new tables get no Data API grants by default', () => {
  const defaultsAt = files.indexOf(DEFAULTS_MIGRATION)

  it('the migration that removes the defaults exists', () => {
    expect(defaultsAt, `${DEFAULTS_MIGRATION} is missing`).toBeGreaterThanOrEqual(0)
    const body = read(DEFAULTS_MIGRATION).replace(/\s+/g, ' ').toLowerCase()
    expect(body).toContain('alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated')
  })

  it('no later migration grants table defaults back to anon or authenticated', () => {
    const regrants = files.slice(defaultsAt + 1).filter(f =>
      /alter\s+default\s+privileges[^;]*\bgrant\b[^;]*\bon\s+tables\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i.test(read(f)))
    expect(regrants).toEqual([])
  })

  it('every table created after it carries an explicit grant', () => {
    const ungranted: string[] = []
    for (const f of files.slice(defaultsAt + 1)) {
      const text = read(f)
      for (const t of createdTables(text)) {
        const granted = new RegExp(String.raw`\bgrant\s+[^;]*\bon\s+(?:table\s+)?(?:"?public"?\.)?"?${t}"?\s+to\b`, 'i').test(text)
        if (!granted) ungranted.push(`${f}: ${t}`)
      }
    }
    expect(ungranted, 'grant the new table to authenticated and/or service_role (see CLAUDE.md)').toEqual([])
  })
})
