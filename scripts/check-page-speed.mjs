#!/usr/bin/env node
/** Real-browser regression check with synthetic data only; no credentials or live accounts.
 * Compares eager vs deferred panels, then checks scroll, manual activation, anchors and fallback.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { build } from 'esbuild'
import { launchBrowser, measurePage } from './measure-page-speed.mjs'

const bundle = await build({
  stdin: { contents: `
    import React, { lazy, useEffect, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { DeferredPanel } from './components/deferred-panel'
    const params = new URLSearchParams(location.search)
    if (params.has('noObserver')) delete window.IntersectionObserver
    function Panel({ id }) {
      const [ready, setReady] = useState(false)
      useEffect(() => { fetch('/api/panel/' + id).then(r => r.json()).then(() => setReady(true)) }, [id])
      return <p data-loaded={ready ? id : undefined}>{ready ? id + ' loaded' : 'Loading'}</p>
    }
    const LazyPanel = lazy(async () => ({ default: Panel }))
    function App() {
      return <><h1 data-page-ready="synthetic">Synthetic page</h1>{['updates', 'documents', 'interactions'].map(id =>
        <React.Fragment key={id}><div style={{height: 2000}} />{params.has('eager') ? <Panel id={id} /> :
          <DeferredPanel id={id} label={id}><LazyPanel id={id} /></DeferredPanel>}
        </React.Fragment>
      )}</>
    }
    createRoot(document.getElementById('root')).render(<App />)
  `, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'synthetic-performance.tsx' },
  bundle: true, write: false, minify: true, platform: 'browser', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const script = bundle.outputFiles[0].text
const seen = []
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/app.js') {
    res.setHeader('Content-Type', 'application/javascript'); res.end(script)
  } else if (pathname.startsWith('/api/panel/')) {
    seen.push(pathname.split('/').at(-1))
    res.setHeader('Content-Type', 'application/json')
    // A fixed synthetic payload makes transferred-byte differences observable.
    res.end(JSON.stringify({ rows: Array.from({ length: 100 }, (_, id) => ({ id, text: 'synthetic'.repeat(12) })) }))
  } else {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><html><head><style>body{font:16px sans-serif}.min-h-48{min-height:192px}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await launchBrowser()
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const origin = `http://127.0.0.1:${server.address().port}`
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const eager = await measurePage(page, origin + '/?eager')
  assert.equal(eager.apiRequests, 3)
  seen.length = 0
  const deferred = await measurePage(page, origin)
  assert.equal(deferred.apiRequests, 0, 'offscreen panels must not fetch during initial load')
  assert.ok(deferred.transferredBytes < eager.transferredBytes)

  await page.$eval('#updates', element => element.scrollIntoView())
  await page.waitForSelector('[data-loaded="updates"]')
  assert.deepEqual(seen, ['updates'], 'scroll loads only the nearby panel')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.$eval('#updates', element => element.scrollIntoView())
  await page.waitForNetworkIdle({ idleTime: 100 })
  assert.deepEqual(seen, ['updates'], 'a mounted panel remains mounted when scrolled away')

  // Click programmatically while offscreen to test keyboard/manual activation independently of intersection.
  await page.$eval('#documents button', button => button.click())
  await page.waitForSelector('[data-loaded="documents"]')
  assert.ok(seen.includes('documents'))

  await page.evaluate(() => { location.hash = 'interactions' })
  await page.waitForSelector('[data-loaded="interactions"]')
  await page.goto(origin + '/#documents')
  await page.waitForSelector('[data-loaded="documents"]')

  await page.goto(origin + '/?noObserver')
  for (const id of ['updates', 'documents', 'interactions']) await page.waitForSelector(`[data-loaded="${id}"]`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ fixture: 'synthetic panels; not production timings', eager, deferred,
    checks: ['offscreen deferral', 'scroll activation', 'state preservation', 'manual activation', 'incoming/hash-change links', 'observer fallback'],
    passed: true }, null, 2))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
