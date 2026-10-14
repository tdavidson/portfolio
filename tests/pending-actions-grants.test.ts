import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// A staged action executes its `args` when an admin approves it, but the admin is shown its `preview`.
// If the browser could write the table, a member could stage (or later rewrite) args that don't match
// the preview. So: service role writes, the browser only reads.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const lastIndex = (re: RegExp) => files.reduce((at, f, i) => (re.test(readFileSync(join(MIGRATIONS, f), 'utf8')) ? i : at), -1)

describe('pending_actions reach from the browser', () => {
  it('revokes authenticated writes after the last grant of them', () => {
    const granted = lastIndex(/grant\s+[^;]*\b(insert|update|delete)\b[^;]*on\s+(?:table\s+)?public\.pending_actions\s+to\s+[^;]*\bauthenticated\b/i)
    const revoked = lastIndex(/revoke\s+insert,\s*update,\s*delete\s+on\s+public\.pending_actions\s+from\s+authenticated/i)
    expect(revoked).toBeGreaterThan(granted)
  })

  it('is only written with the service-role client', () => {
    const hits = execSync(
      'grep -rn "from(\'pending_actions\')" app lib --include=*.ts --include=*.tsx | grep -v "\\.test\\." || true',
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean)
    // The one user-context read is the layout's Approvals badge count.
    const userClient = hits.filter(h => h.startsWith('app/(app)/layout.tsx'))
    expect(userClient.length).toBe(1)
    const layout = readFileSync(join(process.cwd(), 'app', '(app)', 'layout.tsx'), 'utf8')
    expect(layout).toMatch(/from\('pending_actions'\)\s*\.select\(/)
  })
})
