#!/usr/bin/env node
/**
 * Build a GitHub Release body from CHANGELOG.md.
 *
 *   npm run release:notes              # the Unreleased section
 *   npm run release:notes -- 0.9.8     # the "## 0.9.8" section (a leading v is fine)
 *   npm run release:notes -- 0.9.8 --since v0.9.7   # also list migration files added since that tag
 *
 * Prints Markdown: a "Migrations to apply" block first (self-hosted installs apply them by hand,
 * so they lead), then the section as written. The migrations come from the section's own
 * "Migration: `<file>.sql`" lines and, with --since, from every file added under
 * supabase/migrations since that ref, so one the changelog forgot still shows.
 *
 * .github/workflows/release.yml runs this when a v* tag is pushed and creates the release.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sinceAt = args.indexOf('--since')
const since = sinceAt >= 0 ? args[sinceAt + 1] : null
const version = args.find((a, i) => !a.startsWith('--') && (sinceAt < 0 || i !== sinceAt + 1))?.replace(/^v/, '') ?? null

/** The body of one `## ` section: Unreleased when no version is given. */
export function changelogSection(changelog, wanted) {
  const lines = changelog.split('\n')
  const isWanted = line => {
    if (!line.startsWith('## ')) return false
    const title = line.slice(3).trim()
    return wanted ? title === wanted || title.startsWith(`${wanted} `) : /^unreleased$/i.test(title)
  }
  const start = lines.findIndex(isWanted)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

/** Migration file names a section names, in the order it names them, once each. */
export function migrationsNamed(section) {
  const found = section.match(/\b\d{14}_[a-z0-9_]+\.sql\b/g) ?? []
  return [...new Set(found)]
}

export function releaseNotes(section, migrations) {
  const out = []
  if (migrations.length) {
    out.push('## Migrations to apply', '')
    out.push('Self-hosted? Apply these in order before or right after deploying (`supabase db push`, or paste each file from `supabase/migrations/` into the SQL editor). `npm run upgrade` lists the ones your install still needs.', '')
    for (const m of [...migrations].sort()) out.push(`- \`${m}\``)
    out.push('')
  } else {
    out.push('_No database migrations in this release._', '')
  }
  out.push('## What changed', '', section.trim(), '')
  return out.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const section = changelogSection(changelog, version)
  if (section === null) {
    console.error(`release-notes: CHANGELOG.md has no "## ${version ?? 'Unreleased'}" section.`)
    process.exit(1)
  }
  const migrations = new Set(migrationsNamed(section))
  if (since) {
    let added
    try {
      added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${since}..HEAD`, '--', 'supabase/migrations'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      console.error(`release-notes: git does not know ${since}. Fetch tags first (git fetch --tags).`)
      process.exit(1)
    }
    for (const file of added.split('\n').filter(f => f.endsWith('.sql'))) migrations.add(path.basename(file))
  }
  process.stdout.write(releaseNotes(section, [...migrations]))
}
