#!/usr/bin/env node
/** Browser measurements without recording page contents, cookies, or response bodies.
 * npm run perf:pages -- --url http://localhost:3000/dashboard --label admin --interactive
 * npm run perf:pages -- --url https://app.example/dashboard --label scoped-member --cookies-file /private/tmp/cookies.json
 * Cache modes refer to the BROWSER cache; this does not flush server/database caches.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

export function chromePath() {
  const candidates = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean)
  const found = candidates.find(file => fs.existsSync(file))
  if (!found) throw new Error('Set CHROME_PATH to an installed Chrome or Chromium executable.')
  return found
}

export async function launchBrowser(interactive = false) {
  return puppeteer.launch({ executablePath: chromePath(), headless: !interactive,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

export async function measurePage(page, url, { cache = false, selector = '[data-page-ready]', timeout = 30000 } = {}) {
  await page.goto('about:blank')
  const network = await page.createCDPSession()
  await network.send('Network.enable')
  await network.send('Network.setCacheDisabled', { cacheDisabled: !cache })
  const counts = { requests: 0, apiRequests: 0, apiErrors: 0, transferredBytes: 0 }
  network.on('Network.requestWillBeSent', ({ request }) => {
    counts.requests++
    if (new URL(request.url).pathname.startsWith('/api/')) counts.apiRequests++
  })
  network.on('Network.responseReceived', ({ response }) => {
    if (response.status >= 400 && new URL(response.url).pathname.startsWith('/api/')) counts.apiErrors++
  })
  network.on('Network.loadingFinished', ({ encodedDataLength }) => { counts.transferredBytes += encodedDataLength })
  const observer = await page.evaluateOnNewDocument(() => {
    window.__pageSpeedLcp = null
    new PerformanceObserver(list => {
      window.__pageSpeedLcp = list.getEntries().at(-1)?.startTime ?? null
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  })
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
    if (!response?.ok()) throw new Error('The target page did not return a successful response.')
    if (['/auth', '/pending', '/onboarding'].some(prefix => new URL(page.url()).pathname.startsWith(prefix))) {
      throw new Error('A signed-in account with access is required. Use --interactive or a private --cookies-file.')
    }
    await page.waitForSelector(selector, { visible: true, timeout }).catch(() => {
      throw new Error('The requested page did not become ready. Check the account access and --selector.')
    })
    const readyMs = await page.evaluate(() => performance.now())
    let networkSettled = true
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => { networkSettled = false })
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      return { ttfbMs: nav.responseStart - nav.requestStart, fcpMs: fcp?.startTime ?? null, lcpMs: window.__pageSpeedLcp }
    })
    return { ...timing, readyMs, ...counts, networkSettled }
  } finally {
    await page.removeScriptToEvaluateOnNewDocument(observer.identifier)
    await network.detach()
  }
}

export function summarize(samples) {
  const result = {}
  for (const key of ['ttfbMs', 'fcpMs', 'lcpMs', 'readyMs', 'requests', 'apiRequests', 'transferredBytes']) {
    const values = samples.map(s => s[key]).filter(v => typeof v === 'number').sort((a, b) => a - b)
    const percentile = p => values.length ? Math.round(values[Math.ceil(values.length * p) - 1] * 10) / 10 : null
    result[key] = { median: percentile(0.5), p95: percentile(0.95) }
  }
  return result
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: npm run perf:pages -- --url URL --label admin|scoped-member [--interactive | --cookies-file FILE] [--samples 5] [--selector CSS] [--output FILE]\nMeasures browser-cache-disabled and browser-cache-enabled visits. Server caches are untouched. Reports numeric timings/counts only.')
    return
  }
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const url = new URL(option('--url', 'http://localhost:3000/dashboard'))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Provide an HTTP(S) URL without embedded credentials.')
  const label = option('--label', 'unspecified')
  if (!['admin', 'scoped-member', 'viewer'].includes(label)) throw new Error('Use --label admin, scoped-member, or viewer for the account being measured.')
  const samples = Number(option('--samples', '5'))
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('--samples must be an integer from 1 to 30.')
  const selector = option('--selector', '[data-metrics-ready]')
  const interactive = args.includes('--interactive')
  const browser = await launchBrowser(interactive)
  try {
    const context = browser.defaultBrowserContext()
    const cookieFile = option('--cookies-file')
    if (cookieFile) {
      const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8'))
      const cookies = Array.isArray(parsed) ? parsed : parsed.cookies
      if (!Array.isArray(cookies)) throw new Error('Cookie file must contain a cookies array.')
      await context.setCookie(...cookies.filter(cookie => {
        const domain = cookie.domain?.replace(/^\./, '')
        return domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      }))
    }
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    if (interactive) {
      console.log('Sign in in the browser, then open the requested page. Measurement starts when its metrics appear.')
      await page.goto(url.href)
      await page.waitForSelector(selector, { timeout: 300000 })
    }
    const report = { account: label, cacheScope: 'browser only; server caches are untouched', scenarios: [] }
    for (const cache of [false, true]) {
      // Populate the browser cache before measuring the warm scenario.
      if (cache) await measurePage(page, url.href, { cache, selector })
      const runs = []
      for (let i = 0; i < samples; i++) runs.push(await measurePage(page, url.href, { cache, selector }))
      report.scenarios.push({ browserCache: cache ? 'enabled' : 'disabled', summary: summarize(runs), samples: runs })
    }
    const text = JSON.stringify(report, null, 2)
    const output = option('--output')
    if (output) fs.writeFileSync(output, text + '\n')
    console.log(text)
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
