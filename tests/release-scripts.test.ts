import { describe, expect, it } from 'vitest'
import { changelogSection, migrationsNamed, releaseNotes } from '../scripts/release-notes.mjs'
import { compareVersions, latestTag } from '../scripts/upgrade.mjs'

const CHANGELOG = `# Changelog

## Unreleased

### New thing
- Did a thing.
- Migration: \`20990101000000_new_thing.sql\` (a column).

## 1.2.0 — 2099-01-01

- Older work. Migration: \`20980101000000_old_thing.sql\` and \`20980101000001_more.sql\`; again \`20980101000000_old_thing.sql\`.

## 1.1.0 — 2098-01-01

- Oldest.
`

describe('changelogSection', () => {
  it('reads Unreleased by default', () => {
    expect(changelogSection(CHANGELOG, null)).toMatch(/^### New thing/)
    expect(changelogSection(CHANGELOG, null)).not.toContain('Older work')
  })
  it('reads a dated version section', () => {
    expect(changelogSection(CHANGELOG, '1.2.0')).toContain('Older work')
    expect(changelogSection(CHANGELOG, '1.2.0')).not.toContain('Oldest')
  })
  it('reads the last section to the end of the file', () => {
    expect(changelogSection(CHANGELOG, '1.1.0')).toBe('- Oldest.')
  })
  it('returns null for a missing version', () => {
    expect(changelogSection(CHANGELOG, '9.9.9')).toBeNull()
  })
  it('does not match a version that only shares a prefix', () => {
    expect(changelogSection(CHANGELOG, '1.2')).toBeNull()
  })
})

describe('migrationsNamed', () => {
  it('lists each migration file once, in order', () => {
    expect(migrationsNamed(changelogSection(CHANGELOG, '1.2.0'))).toEqual([
      '20980101000000_old_thing.sql',
      '20980101000001_more.sql',
    ])
  })
})

describe('releaseNotes', () => {
  it('puts migrations first, sorted', () => {
    const notes = releaseNotes('- Change.', ['20990101000001_b.sql', '20990101000000_a.sql'])
    expect(notes.indexOf('## Migrations to apply')).toBe(0)
    expect(notes.indexOf('20990101000000_a.sql')).toBeLessThan(notes.indexOf('20990101000001_b.sql'))
    expect(notes.indexOf('## What changed')).toBeGreaterThan(notes.indexOf('20990101000001_b.sql'))
  })
  it('says so when there are none', () => {
    expect(releaseNotes('- Change.', [])).toMatch(/^_No database migrations in this release._/)
  })
})

describe('upgrade versions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.7')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0)
  })
  it('picks the newest release tag and ignores others', () => {
    expect(latestTag(['v0.9.6', 'v0.10.0', 'v0.9.10', 'demo-widget-latest', 'v1.0.0-rc1'])).toBe('v0.10.0')
    expect(latestTag(['demo-widget-latest'])).toBeNull()
  })
})
