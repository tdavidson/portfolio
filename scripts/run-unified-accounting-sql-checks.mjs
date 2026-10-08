// Start a throwaway PostgreSQL cluster, run both unified-accounting SQL check scripts against
// it, and tear it down. Reproducible on any machine with PostgreSQL binaries on PATH
// (`brew install postgresql@17`) and no Docker, no Supabase project and no network.
//
//   npm run sql:check:accounting
//
// The correctness script also runs on PGlite (see its header) but the concurrency script needs a
// real server: one PGlite instance has one session and cannot show a row lock between
// transactions. The `pg` client is installed on demand into the work directory rather than added
// to this project's dependencies — nothing here ships.
//
// Keep the data directory and socket path SHORT: a Unix socket path over 103 bytes makes the
// server refuse to start, which is what the long sandbox scratch paths produce.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = process.env.UNIFIED_SQL_WORKDIR ?? join(tmpdir(), 'uasql')
const DATA = join(WORK, 'data')
const PORT = process.env.UNIFIED_SQL_PORT ?? '55433'
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const psql = args => run('psql', ['-h', WORK, '-p', PORT, '-U', 'postgres', '-d', 'postgres', ...args], { stdio: 'pipe' })

let started = false
try {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  console.log('• initialising a throwaway cluster')
  run('initdb', ['-D', DATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe' })
  run('pg_ctl', ['-D', DATA, '-l', join(WORK, 'server.log'), '-o',
    `-k ${WORK} -p ${PORT} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' })
  started = true

  const clientDir = join(WORK, 'client')
  mkdirSync(clientDir, { recursive: true })
  console.log('• installing a pg client for the checks')
  run('npm', ['install', 'pg', '--no-save', '--loglevel=error'], { cwd: clientDir, stdio: 'pipe' })
  const pgModule = join(clientDir, 'node_modules', 'pg', 'lib', 'index.js')
  if (!existsSync(pgModule)) throw new Error(`pg client not found at ${pgModule}`)

  const env = { ...process.env, PG_MODULE: pgModule, PGHOST: WORK, PGPORT: PORT, PGUSER: 'postgres' }
  for (const [database, script] of [
    ['unified_check', 'scripts/check-unified-accounting-migrations.mjs'],
    ['unified_concurrency', 'scripts/check-unified-accounting-concurrency.mjs'],
    ['investment_ownership', 'scripts/check-investment-ownership.mjs'],
  ]) {
    psql(['-c', `create database ${database}`])
    console.log(`\n• ${script}`)
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: { ...env, PGDATABASE: database } })
    if (result.status !== 0) process.exitCode = result.status ?? 1
  }
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', DATA, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' }) } catch {}
  }
  rmSync(WORK, { recursive: true, force: true })
}
