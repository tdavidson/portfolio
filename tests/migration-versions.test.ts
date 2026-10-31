import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'

// The Supabase CLI records a migration by the number before the first underscore
// (supabase_migrations.schema_migrations), so two files sharing one make a fresh `supabase db push`
// apply the first and fail on the second with a duplicate key.

const files = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))

describe('migration versions', () => {
  it('every file starts with a version and a name', () => {
    expect(files.filter(f => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f))).toEqual([])
  })

  it('no two files share a version', () => {
    const seen = new Map<string, string[]>()
    for (const f of files) {
      const v = f.split('_')[0]
      seen.set(v, [...(seen.get(v) ?? []), f])
    }
    expect(Array.from(seen.values()).filter(fs => fs.length > 1)).toEqual([])
  })
})
