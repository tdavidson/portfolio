#!/usr/bin/env node
/**
 * Walk every page of the built demo widget in a real browser and report what broke.
 *
 *   npm run demo:widget && node scripts/demo-check.mjs [--strict] [--only /deals] [--shots dir]
 *
 * Serves demo-widget/dist on a local port, mounts the widget with its own data files, visits
 * every URL the route table serves, and for each collects: uncaught errors (a page that crashed),
 * console errors, and API requests nothing could answer (mock-api.ts's misses — routes the
 * recorder has not covered), and links to URLs the widget does not build (a 404 on the site when
 * opened in a new tab). Exits non-zero on a crash; with --strict, on a miss or a dead link as well.
 * The workflow runs it before publishing, so a component that no longer renders on the snapshot
 * stops the publish rather than the site.
 *
 * CHROME_PATH points at a Chromium binary (the workflow sets it; locally the default below is
 * Playwright's).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'demo-widget', 'dist')
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const shots = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null
const chrome = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

if (!fs.existsSync(path.join(dist, 'widget.js'))) {
  console.error('demo-check: demo-widget/dist is empty; run `npm run demo:widget` first.')
  process.exit(2)
}

const HOST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>demo check</title>
<link rel="stylesheet" href="/widget.css">
<style>:root{--font-sans-face:Inter,system-ui,sans-serif}body{margin:0;padding:24px;font-family:Inter,system-ui,sans-serif;background:#fff;color:#111}.dark body{background:#121316;color:#f2f2f4}</style>
</head><body><div id="demo"></div><script type="module" src="/widget.js"></script>
<script type="module">
window.__misses = []; window.__pending = 0;
Promise.all(['snapshot','answers','pages','api'].map(f => fetch('/' + f + '.json').then(r => r.json()))).then(([snapshot, answers, pages, api]) => {
  const orig = window.fetch;
  window.__demo = PortfolioDemo.mount(document.getElementById('demo'), { snapshot, answers, pages, api, basePath: '/demo', onMiss: k => window.__misses.push(k) });
  // Count in-flight /api requests so the walker can wait for a page to settle.
  const wrapped = window.fetch;
  window.fetch = function (input, init) { const p = wrapped.call(this, input, init); const u = typeof input === 'string' ? input : input.url ?? String(input); if (u.includes('/api/')) { window.__pending++; p.finally(() => { window.__pending--; }); } return p; };
  window.__routes = PortfolioDemo.routes(snapshot, pages);
  window.__ready = true;
});
</script></body></html>`

const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HOST) }
  const file = path.join(dist, path.normalize(url.pathname))
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await puppeteer.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })

const report = { routes: [], crashes: 0, consoleErrors: 0, misses: new Set(), deadLinks: new Set() }
let current = null
page.on('pageerror', e => { if (current) { current.errors.push(String(e.message).slice(0, 400)); report.crashes++ } })
page.on('console', m => {
  if (m.type() !== 'error' || !current) return
  const text = m.text()
  // React's own hydration/warning noise is not a crash; 404s from the mock are reported as misses.
  if (/Failed to load resource|DialogTitle|DialogContent/.test(text)) return
  current.console.push(text.slice(0, 300)); report.consoleErrors++
})

async function open() {
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction('window.__ready === true', { timeout: 30000 })
}
await open()
// `--only` with a query (`/funds/<id>/ledger?account=1000&preset=ytd`) visits exactly that URL.
const routes = only?.includes('?') ? [only] : (await page.evaluate('window.__routes')).filter(h => !only || h.startsWith(only))

async function settle() {
  const start = Date.now()
  // Give effects a tick to fire their first requests, then wait for the in-flight count to reach zero.
  await new Promise(r => setTimeout(r, 250))
  while (Date.now() - start < 8000) {
    const pending = await page.evaluate('window.__pending')
    if (pending === 0) break
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 300))
}

for (const href of routes) {
  current = { href, errors: [], console: [], misses: [] }
  await page.evaluate('window.__misses = []')
  await page.evaluate(h => window.__demo.navigate(h), href)
  await settle()
  current.misses = await page.evaluate('window.__misses')
  for (const m of current.misses) report.misses.add(m)
  // Visible links whose app path (data-app-href, hrefs.ts) the widget does not build. Hidden ones
  // are hrefs.ts's HIDDEN_IN_DEMO, which the demo hides on purpose.
  current.deadLinks = await page.evaluate(served => {
    const ok = new Set(['/', ...served])
    return [...new Set([...document.querySelectorAll('.oa-demo-root a[data-app-href]')]
      .filter(a => a.style.display !== 'none')
      .map(a => a.getAttribute('data-app-href'))
      .filter(h => !ok.has(h.split(/[?#]/)[0] || '/')))]
  }, routes)
  for (const l of current.deadLinks) report.deadLinks.add(`${l}  (on ${href})`)
  const text = await page.evaluate('document.querySelector(".oa-demo")?.innerText.length ?? 0')
  current.chars = text
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, href.replace(/[^a-z0-9]+/gi, '_').replace(/^_/, '') + '.png') })
  }
  report.routes.push(current)
  const flag = current.errors.length ? 'CRASH' : current.console.length ? 'error' : current.deadLinks.length ? 'link ' : current.misses.length ? 'miss ' : 'ok   '
  console.log(`${flag} ${href}${current.misses.length ? `  (${current.misses.length} unanswered)` : ''}`)
  for (const l of current.deadLinks) console.log(`       → ${l} is not a demo URL`)
  for (const e of current.errors) console.log(`       ! ${e}`)
  for (const e of current.console) console.log(`       ~ ${e}`)
  // A crash unmounts the React tree; start over so the next page is judged on its own. Report the
  // page first: clearing `current` before the log above is what turned every crash into a
  // TypeError that hid the page and the error.
  if (current.errors.length) { current = null; await open() }
}

await browser.close()
server.close()

const misses = [...report.misses].sort()
const deadLinks = [...report.deadLinks].sort()
fs.writeFileSync(path.join(root, 'demo-widget', 'check-report.json'), JSON.stringify({ ...report, misses, deadLinks }, null, 2))
console.log(`\n${routes.length} pages: ${report.crashes} crashes, ${report.consoleErrors} console errors, ${misses.length} unanswered API requests, ${deadLinks.length} dead links.`)
if (misses.length) console.log(`Unanswered (record them with scripts/demo-record.mjs):\n  ${misses.join('\n  ')}`)
if (deadLinks.length) console.log(`Links to URLs the widget does not build (add a route in demo-widget/route-table.ts, or hide it in demo-widget/hrefs.ts):\n  ${deadLinks.join('\n  ')}`)
if (report.crashes || (strict && (misses.length || deadLinks.length))) process.exit(1)
