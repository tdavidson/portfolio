// Entry point of the dashboard view: connect to the host, wait for a dashboard tool's result,
// draw it, and redraw when the user drills in or the host changes theme or display mode.
//
// Built by scripts/build-mcp-app.mjs into lib/mcp-apps/dashboard-html.generated.ts, which the MCP
// endpoint serves from `resources/read`. Edit here, then `npm run mcp:app`.

import { HostBridge, type DisplayMode, type HostContext, type ToolResult } from './bridge'
import { clear, h } from './dom'
import { clockTime, createFormatters } from './format'
import { button, hideTooltip, note } from './ui'
import { renderView, type StatementTab, type ViewContext } from './views'
import { isDashboardPayload, type DashboardPayload } from '../payload'

/** Reported to the host in the handshake. Bump when the view's behaviour changes in a way a host log should show. */
const APP_INFO = { name: 'portfolio-dashboards', version: '1.0.0' }

interface State {
  payload: DashboardPayload | null
  /** Views to go back to, oldest first. Filled by drill-ins, emptied by a new result from the host. */
  history: DashboardPayload[]
  busy: boolean
  error: string | null
  displayMode: DisplayMode
  /** The full dashboard shown in place, on a host that has no fullscreen to give. */
  expandedInPlace: boolean
  statementTab: StatementTab
}

const state: State = {
  payload: null,
  history: [],
  busy: false,
  error: null,
  displayMode: 'inline',
  expandedInPlace: false,
  statementTab: 'balance',
}

const bridge = new HostBridge()
const root = document.getElementById('app') as HTMLElement
let disposers: (() => void)[] = []

/** ChatGPT's own globals, used only if the standard handshake never completes there. */
const openai = (window as unknown as { openai?: {
  toolOutput?: unknown
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
} }).openai

// ---------------------------------------------------------------------------------------------
// Host context: theme, the host's own style variables, safe areas, display mode
// ---------------------------------------------------------------------------------------------

function applyHostContext(context: HostContext): void {
  const el = document.documentElement
  const dark = context.theme
    ? context.theme === 'dark'
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  el.classList.toggle('dark', dark)

  // The host's palette and font, so the neutrals of the view are the neutrals around it. The
  // stylesheet reads each one with this app's own token as the fallback (styles.css).
  const variables = context.styles?.variables ?? {}
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value === 'string' && /^--[a-z0-9-]+$/.test(name)) el.style.setProperty(name, value)
  }

  const inset = context.safeAreaInsets
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    el.style.setProperty(`--safe-${side}`, `${Math.max(0, Number(inset?.[side]) || 0)}px`)
  }

  if (context.displayMode) state.displayMode = context.displayMode
}

/**
 * The fund's own colours, from the payload. Only the properties a theme is allowed to set
 * (lib/theme.ts `themeCssVars`), each with a value that can only be a colour triple or a length:
 * the string came from this deployment's database, but it is applied as style, so it is checked
 * here as well as where it was built. Fonts are skipped; the view has only the host's.
 */
const THEME_PROPERTY = /^--(primary|primary-foreground|ring|brand|brand-foreground|brand-\d{2,3}|radius|radius-card)$/
const THEME_VALUE = /^[0-9.]+(rem|%)?(\s+[0-9.]+%){0,2}$/

function applyFundTheme(cssVars: string): void {
  for (const pair of cssVars.split(';')) {
    const at = pair.indexOf(':')
    if (at < 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (THEME_PROPERTY.test(name) && THEME_VALUE.test(value)) document.documentElement.style.setProperty(name, value)
  }
}

// ---------------------------------------------------------------------------------------------
// Results in, tool calls out
// ---------------------------------------------------------------------------------------------

function errorText(result: ToolResult): string {
  const text = result.content?.find(c => c.type === 'text' && c.text)?.text
  return text && text.length < 400 ? text : 'The dashboard could not be loaded.'
}

/** Take a tool result. Returns false (and sets the error) when it carries no dashboard. */
function accept(result: ToolResult): boolean {
  if (result.isError) { state.error = errorText(result); return false }
  if (!isDashboardPayload(result.structuredContent)) {
    state.error = 'This result has no dashboard to show.'
    return false
  }
  state.payload = result.structuredContent
  state.error = null
  applyFundTheme(state.payload.branding?.cssVars ?? '')
  return true
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (bridge.connected) return bridge.callTool(name, args)
  if (openai?.callTool) return openai.callTool(name, args)
  throw new Error('This view is not connected to an assistant.')
}

async function open(tool: string, args: Record<string, unknown>, mode: 'push' | 'replace'): Promise<void> {
  if (state.busy) return
  const previous = state.payload
  state.busy = true
  state.error = null
  // The current view stays up, dimmed, while the next one loads: no blank frame, no jump.
  render()
  try {
    const result = await callTool(tool, args)
    if (accept(result)) {
      if (mode === 'push' && previous) state.history.push(previous)
      // The conversation's last tool result now describes a screen the user has left.
      const text = result.content?.find(c => c.type === 'text' && c.text)?.text
      if (text) bridge.updateModelContext(`The user is now viewing this dashboard:\n${text}`)
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'The dashboard could not be loaded.'
  } finally {
    state.busy = false
    render()
    if (mode === 'push') window.scrollTo(0, 0)
  }
}

function back(): void {
  const previous = state.history.pop()
  if (!previous) return
  state.payload = previous
  state.error = null
  render()
  window.scrollTo(0, 0)
}

async function expand(): Promise<void> {
  const modes = bridge.hostContext.availableDisplayModes ?? []
  if (bridge.connected && modes.includes('fullscreen')) {
    try {
      state.displayMode = await bridge.requestDisplayMode('fullscreen')
    } catch { /* fall through to expanding in place */ }
  }
  if (state.displayMode !== 'fullscreen') state.expandedInPlace = true
  render()
}

async function collapse(): Promise<void> {
  if (state.displayMode === 'fullscreen' && bridge.connected) {
    try {
      state.displayMode = await bridge.requestDisplayMode('inline')
    } catch { /* the host's own close control still works */ }
  }
  state.expandedInPlace = false
  render()
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

function skeleton(): HTMLElement {
  // The shape of what is coming, so the card does not change size when the figures arrive.
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading dashboard' },
    h('div', { class: 'sk sk-title' }),
    h('div', { class: 'tiles' }, [0, 1, 2, 3].map(() => h('div', { class: 'tile' }, h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-value' })))),
    h('div', { class: 'sk sk-block' }))
}

function render(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  hideTooltip()
  clear(root)

  const full = state.displayMode === 'fullscreen' || state.expandedInPlace
  document.documentElement.dataset.mode = state.displayMode === 'fullscreen' ? 'fullscreen' : 'inline'
  root.className = state.busy ? 'app busy' : 'app'

  const payload = state.payload
  if (!payload) {
    root.appendChild(state.error ? note(state.error, 'warning') : skeleton())
    return
  }

  const locale = bridge.hostContext.locale ?? navigator.language
  const ctx: ViewContext = {
    fmt: createFormatters(payload.branding?.currency || 'USD', locale),
    compact: !full,
    canExpand: true,
    expand: () => { void expand() },
    open: (tool, args, mode) => { void open(tool, args, mode) },
    onDispose: dispose => { disposers.push(dispose) },
    statementTab: state.statementTab,
    setStatementTab: tab => { state.statementTab = tab; render() },
  }

  const read = clockTime(payload.generatedAt, locale)
  const source = [payload.branding?.fundName, read ? `read at ${read}` : null].filter(Boolean).join(' · ')

  root.appendChild(h('header', { class: 'head' },
    h('div', { class: 'head-main' },
      state.history.length > 0 ? button('← Back', back) : null,
      h('div', null,
        h('h1', { class: 'title' }, payload.title),
        payload.subtitle ? h('p', { class: 'subtitle' }, payload.subtitle) : null)),
    full ? button(state.displayMode === 'fullscreen' ? 'Exit full screen' : 'Show less', () => { void collapse() }) : null,
  ))

  if (state.error) root.appendChild(note(state.error, 'warning'))
  root.appendChild(h('main', { class: 'body' }, renderView(payload, ctx)))
  if (source) root.appendChild(h('footer', { class: 'foot' }, source))
}

// ---------------------------------------------------------------------------------------------
// Size: an inline view is given exactly the height its content needs
// ---------------------------------------------------------------------------------------------

function watchSize(): void {
  let scheduled = false
  let lastW = 0, lastH = 0
  const measure = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const el = document.documentElement
      // Measured at max-content, so a height the host imposed does not report itself back.
      const previous = el.style.height
      el.style.height = 'max-content'
      const height = Math.ceil(el.getBoundingClientRect().height)
      el.style.height = previous
      const width = Math.ceil(window.innerWidth)
      if (width !== lastW || height !== lastH) {
        lastW = width; lastH = height
        bridge.sendSize(width, height)
      }
    })
  }
  const observer = new ResizeObserver(measure)
  observer.observe(document.documentElement)
  observer.observe(document.body)
  measure()
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

bridge.onToolResult = result => {
  // A new result from the conversation replaces whatever the user had drilled into.
  if (accept(result)) state.history = []
  state.busy = false
  render()
}
bridge.onToolCancelled = () => {
  if (!state.payload) { state.error = 'The request was cancelled.'; render() }
}
bridge.onHostContextChanged = context => {
  applyHostContext(context)
  render()
}

applyHostContext({})
render()

if (bridge.hasHost) {
  bridge.connect(APP_INFO, ['inline', 'fullscreen'])
    .then(() => {
      applyHostContext(bridge.hostContext)
      watchSize()
      render()
    })
    .catch(() => {
      if (!state.payload && !openai?.toolOutput) { state.error = 'Could not connect to the assistant.'; render() }
    })
}

// ChatGPT also exposes the result as a global. It implements the standard bridge above, so this
// only matters if that handshake did not deliver a result.
if (openai?.toolOutput && !state.payload && isDashboardPayload(openai.toolOutput)) {
  accept({ structuredContent: openai.toolOutput })
  render()
}

if (!bridge.hasHost && !state.payload) {
  state.error = 'This view is shown by an assistant (Claude or ChatGPT) when it opens a dashboard.'
  render()
}
