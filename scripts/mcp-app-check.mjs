#!/usr/bin/env node
/**
 * Render the dashboard view inside the OFFICIAL MCP Apps host and check that it behaves.
 *
 *   npm run mcp:check
 *   npm run mcp:check -- --shots /tmp/shots     # and screenshot every view, light and dark
 *
 * The view speaks the MCP Apps protocol with a hand-written client (lib/mcp-apps/app/bridge.ts),
 * because the official one is twenty times the size of the view. This is what keeps that honest:
 * `AppBridge` from @modelcontextprotocol/ext-apps is the host side Claude's and other hosts'
 * implementations are built on, and it validates every message it receives against the
 * specification's schemas. A malformed handshake, tool call or size report fails here.
 *
 * For each view it checks: the handshake completes, the tool result renders, the view reports a
 * size, and the page raises no error. On the portfolio view it also drills into a company
 * (a `tools/call` through the host, then a model-context update), goes fullscreen, follows a
 * host theme change and answers a teardown.
 *
 * The SDK is installed into a cache directory on first run rather than added to package.json:
 * it and its peer dependencies exist only for this check, and nothing the app ships imports them.
 * Chromium is the one demo:check uses (CHROME_PATH to override).
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildDashboardHtml } from './build-mcp-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

const SDK = {
  '@modelcontextprotocol/ext-apps': '2.0.3',
  '@modelcontextprotocol/client': '^2.0.0',
  '@modelcontextprotocol/core': '^2.0.0',
  '@modelcontextprotocol/server': '^2.0.0',
  zod: '^4.2.0',
}

const argv = process.argv.slice(2)
const shotsAt = argv.indexOf('--shots')
const shots = shotsAt >= 0 ? path.resolve(argv[shotsAt + 1]) : null
const chrome = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

// 1. The SDK, once ------------------------------------------------------------------------------
const cache = path.join(os.tmpdir(), `portfolio-mcp-app-check-${SDK['@modelcontextprotocol/ext-apps']}`)
if (!fs.existsSync(path.join(cache, 'node_modules', '@modelcontextprotocol', 'ext-apps'))) {
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'package.json'), JSON.stringify({ private: true, dependencies: SDK }))
  console.log('Installing the MCP Apps SDK for the check (first run only)…')
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: cache, stdio: 'inherit' })
}

// 2. The host page ------------------------------------------------------------------------------
const hostSource = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { SAMPLE_DASHBOARDS, SAMPLE_BY_TOOL } from ${JSON.stringify(path.join(root, 'lib', 'mcp-apps', 'fixtures.ts'))}

const result = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload.data) }], structuredContent: payload })
const events = (window.__events = [])
const params = new URLSearchParams(location.hash.slice(1))
const iframe = document.getElementById('view')

;(async () => {
  const bridge = (window.__bridge = new AppBridge(null, { name: 'mcp-app-check', version: '1.0.0' },
    { serverTools: {}, updateModelContext: { text: {} } },
    { hostContext: { theme: params.get('theme') || 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-US', platform: 'web' } }))
  bridge.onerror = e => events.push('error: ' + (e && e.message ? e.message : e))
  bridge.onsizechange = p => { events.push('size'); if (p.height && !document.body.classList.contains('full')) iframe.style.height = p.height + 'px' }
  bridge.oncalltool = async p => { events.push('call ' + p.name); return SAMPLE_BY_TOOL[p.name] ? result(SAMPLE_BY_TOOL[p.name]) : { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] } }
  bridge.onrequestdisplaymode = async p => { events.push('mode ' + p.mode); document.body.classList.toggle('full', p.mode === 'fullscreen'); iframe.style.height = ''; return { mode: p.mode } }
  bridge.onupdatemodelcontext = async () => { events.push('context'); return {} }
  bridge.oninitialized = async () => {
    events.push('initialized')
    await bridge.sendToolInput({ arguments: {} })
    await bridge.sendToolResult(result(SAMPLE_DASHBOARDS[params.get('view') || 'portfolio']))
  }
  // Listening BEFORE the view loads, as a real host is: the view sends ui/initialize the moment
  // its script runs, and a host that connects afterwards never hears it.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow))
  iframe.srcdoc = window.__html
})()
`

const bundled = await build({
  stdin: { contents: hostSource, resolveDir: cache, loader: 'js' },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: ['es2020'], logLevel: 'error',
  nodePaths: [path.join(cache, 'node_modules')],
  tsconfig: path.join(root, 'tsconfig.json'),
})
const inline = text => text.replace(/<\/(script)/gi, '<\\/$1')
const viewHtml = await buildDashboardHtml()
const page = theme => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: ${theme === 'dark' ? '#262624' : '#faf9f5'}; }
  iframe { display: block; width: 100%; height: 160px; border: 0; border-radius: 12px; }
  body.full { padding: 0; } body.full iframe { height: 100vh; border-radius: 0; }
</style></head><body><iframe id="view" sandbox="allow-scripts"></iframe>
<script>window.__html = ${inline(JSON.stringify(viewHtml))}</script>
<script>${inline(bundled.outputFiles[0].text)}</script></body></html>`

// 3. Drive it -----------------------------------------------------------------------------------
const puppeteer = require('puppeteer-core')
const browser = await puppeteer.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
if (shots) fs.mkdirSync(shots, { recursive: true })

async function open(view, theme, width) {
  const tab = await browser.newPage()
  const errors = []
  tab.on('pageerror', e => errors.push(String(e)))
  tab.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await tab.setViewport({ width, height: 900, deviceScaleFactor: 1 })
  // The view and theme travel in the fragment; setContent has no URL of its own to carry them.
  await tab.setContent(page(theme).replace('location.hash.slice(1)', JSON.stringify(`view=${view}&theme=${theme}`)), { waitUntil: 'load' })
  await wait(600)
  const frame = tab.frames().find(f => f !== tab.mainFrame())
  return { tab, frame, errors, events: () => tab.evaluate(() => window.__events) }
}

const expect = (label, ok, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

for (const view of ['portfolio', 'company', 'statements', 'lps']) {
  for (const theme of ['light', 'dark']) {
    const { tab, frame, errors, events } = await open(view, theme, 760)
    const seen = await events()
    const title = await frame.evaluate(() => document.querySelector('h1')?.textContent ?? null)
    const isDark = await frame.evaluate(() => document.documentElement.classList.contains('dark'))
    const overflow = await frame.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(`${view} ${theme}: handshake`, seen.includes('initialized'), seen.join(', '))
    expect(`${view} ${theme}: renders a dashboard`, !!title, 'no heading')
    expect(`${view} ${theme}: reports its size`, seen.includes('size'))
    expect(`${view} ${theme}: follows the host theme`, isDark === (theme === 'dark'))
    expect(`${view} ${theme}: no horizontal overflow`, !overflow)
    expect(`${view} ${theme}: no errors`, errors.length === 0 && !seen.some(e => e.startsWith('error')), [...errors, ...seen.filter(e => e.startsWith('error'))].join(' | '))
    if (shots) await tab.screenshot({ path: path.join(shots, `${view}-${theme}-inline.png`), fullPage: true })

    // The full dashboard, through the host's display-mode request.
    await frame.evaluate(() => document.querySelector('.btn-primary')?.click())
    await wait(400)
    expect(`${view} ${theme}: goes fullscreen`, (await events()).includes('mode fullscreen'))
    if (shots) {
      const height = await frame.evaluate(() => document.documentElement.scrollHeight)
      await tab.setViewport({ width: 1080, height: Math.max(700, height), deviceScaleFactor: 1 })
      await wait(300)
      await tab.screenshot({ path: path.join(shots, `${view}-${theme}-full.png`) })
    }
    await tab.close()
  }
}

// The interactions that cross the bridge, once.
{
  const { tab, frame, errors, events } = await open('portfolio', 'light', 760)
  await frame.evaluate(() => document.querySelector('.bar-row-action')?.click())
  await wait(500)
  const seen = await events()
  const title = await frame.evaluate(() => document.querySelector('h1')?.textContent)
  expect('drill-in: calls the company tool through the host', seen.includes('call show_company_dashboard'), seen.join(', '))
  expect('drill-in: shows the company', title === 'Meridian Robotics', String(title))
  expect('drill-in: updates the model context', seen.includes('context'))
  await tab.evaluate(() => window.__bridge.setHostContext({ theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }))
  await wait(200)
  expect('host context change: switches to dark', await frame.evaluate(() => document.documentElement.classList.contains('dark')))
  const torn = await tab.evaluate(async () => { try { await window.__bridge.teardownResource({}); return true } catch { return false } })
  expect('teardown: answered', torn)
  expect('interactions: no errors', errors.length === 0, errors.join(' | '))
  await tab.close()
}

await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\nThe dashboard view passes against @modelcontextprotocol/ext-apps ${SDK['@modelcontextprotocol/ext-apps']}.${shots ? ` Screenshots in ${shots}.` : ''}`)
