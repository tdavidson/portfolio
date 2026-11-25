#!/usr/bin/env node
/**
 * Upgrade a self-hosted install to the latest Portfolio release, and say which database
 * migrations it needs.
 *
 *   npm run upgrade                  # show what's new and which migrations come with it; changes nothing
 *   npm run upgrade -- --apply       # merge the release into this checkout and write the SQL to paste
 *   npm run upgrade -- --to main     # track the main branch instead of the latest release tag
 *   npm run upgrade -- --remote upstream   # the remote that points at tdavidson/portfolio
 *
 * It never pushes and never touches the database. After --apply it prints the next steps: apply the
 * migrations (with `supabase db push`, or by pasting upgrade-<target>.sql into the SQL editor),
 * then push to deploy. The migrations listed are the files added under supabase/migrations between
 * this checkout and the target, in the order they must run. If your database already has some of
 * them (applied ahead of a deploy), `supabase migration list` shows which.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = 'https://github.com/tdavidson/portfolio'
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const tryGit = (...a) => { try { return git(...a) } catch { return null } }

/** Compare two semver-ish versions ("0.9.7", "v0.10.0"). */
export function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The newest v* tag in a list of tag names, or null. */
export function latestTag(tags) {
  const releases = tags.filter(t => /^v\d+\.\d+\.\d+$/.test(t))
  return releases.sort(compareVersions).at(-1) ?? null
}

function upstreamRemote() {
  const named = option('--remote')
  if (named) return named
  const remotes = git('remote', '-v').split('\n')
  const match = remotes.find(r => /github\.com[/:]tdavidson\/portfolio(\.git)?\s/.test(r))
  if (match) return match.split(/\s+/)[0]
  console.log(`No remote points at ${UPSTREAM}; adding it as "upstream".`)
  git('remote', 'add', 'upstream', UPSTREAM)
  return 'upstream'
}

function main() {
  // The SQL file a previous --apply wrote is left for the person to delete; it is not a change.
  const dirty = git('status', '--porcelain').split('\n').filter(l => l && !/^\?\? upgrade-[^/]*\.sql$/.test(l))
  if (dirty.length) {
    console.error('upgrade: this checkout has uncommitted changes. Commit or stash them first.')
    process.exit(1)
  }
  const remote = upstreamRemote()
  console.log(`Fetching releases from ${remote}…`)
  git('fetch', '--tags', '--quiet', remote, 'main')

  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const wantMain = option('--to') === 'main'
  const tag = latestTag(git('tag', '--list', 'v*').split('\n'))
  const target = wantMain ? `${remote}/main` : tag
  if (!target) {
    console.error('upgrade: no release tags found. Use --to main to track the main branch.')
    process.exit(1)
  }
  if (tryGit('merge-base', '--is-ancestor', target, 'HEAD') !== null) {
    console.log(`Up to date: this checkout (${current}) already includes ${target}.`)
    return
  }

  const added = git('diff', '--name-only', '--diff-filter=A', `HEAD...${target}`, '--', 'supabase/migrations')
    .split('\n').filter(f => f.endsWith('.sql')).sort()
  const commits = git('rev-list', '--count', `HEAD..${target}`)

  console.log('')
  console.log(`Installed: ${current}`)
  console.log(`Target:    ${target}${wantMain ? '' : ` (${UPSTREAM}/releases/tag/${target})`}`)
  console.log(`Changes:   ${commits} commits. What changed is in CHANGELOG.md after the merge, or on the release page.`)
  console.log('')
  if (added.length) {
    console.log(`Migrations to apply, in this order (${added.length}):`)
    for (const f of added) console.log(`  ${path.basename(f)}`)
  } else {
    console.log('No database migrations.')
  }
  console.log('')

  if (!flag('--apply')) {
    console.log('Nothing changed. Run `npm run upgrade -- --apply` to merge it into this checkout.')
    return
  }

  try {
    git('merge', '--no-edit', target)
  } catch {
    console.error('upgrade: the merge has conflicts, usually from your own changes to the same files.')
    console.error('Resolve them (git status lists them), commit, and run npm run upgrade again to see the migrations.')
    process.exit(1)
  }
  console.log(`Merged ${target}.`)

  if (added.length) {
    const name = `upgrade-${target.replace(/[^a-z0-9.]+/gi, '-')}.sql`
    const sql = added.map(f => `-- ${path.basename(f)}\n${fs.readFileSync(path.join(root, f), 'utf8').trim()}\n`).join('\n')
    fs.writeFileSync(path.join(root, name), sql)
    console.log('')
    console.log('Next:')
    console.log('  1. Apply the migrations: `supabase db push` if this checkout is linked to your project,')
    console.log(`     or paste ${name} into the Supabase SQL editor and run it. (${name} is not committed; delete it after.)`)
    console.log('  2. `npm install`, then push to deploy (git push).')
  } else {
    console.log('Next: `npm install`, then push to deploy (git push).')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
