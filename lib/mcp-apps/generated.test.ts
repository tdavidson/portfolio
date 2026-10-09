import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { OUTPUTS, dashboardModule, pluginModule, tokenCss } from '../../scripts/build-mcp-app.mjs'

// The dashboard view and the plugin's files are served from GENERATED modules that are committed
// (why: scripts/build-mcp-app.mjs). That only works if the committed output is the output of the
// committed sources. This rebuilds both in memory and compares.
//
// If this fails, you changed lib/mcp-apps/app/, lib/mcp-apps/payload.ts, plugin/, or a token in
// app/globals.css. Run `npm run mcp:app` and commit the result.
describe('generated modules are up to date', () => {
  it('the dashboard view', async () => {
    expect(fs.readFileSync(OUTPUTS.dashboard, 'utf8'), 'run `npm run mcp:app` and commit lib/mcp-apps/dashboard-html.generated.ts')
      .toBe(await dashboardModule())
  }, 30_000)

  it('the plugin files', () => {
    expect(fs.readFileSync(OUTPUTS.plugin, 'utf8'), 'run `npm run mcp:app` and commit lib/plugin/plugin-files.generated.ts')
      .toBe(pluginModule())
  })
})

describe('the view carries the app\'s own tokens', () => {
  const css: string = tokenCss()

  it('lifts the light and dark token blocks out of app/globals.css', () => {
    expect(css).toMatch(/^:root\{/)
    expect(css).toContain('.dark{')
    for (const token of ['--background', '--foreground', '--card', '--primary', '--border', '--cat-1', '--warning', '--radius-card']) {
      expect(css, token).toContain(`${token}:`)
    }
  })

  it('takes declarations only: no selector, comment or rule comes with them', () => {
    expect(css).not.toContain('/*')
    expect(css).not.toMatch(/select|@apply|background-image/)
  })
})
