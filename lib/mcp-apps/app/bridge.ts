// The view's side of the MCP Apps protocol: JSON-RPC 2.0 over postMessage with the host that
// rendered it (Claude, ChatGPT, or any other MCP Apps host).
//
// Specification: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
//
// WHY THIS IS WRITTEN OUT RATHER THAN IMPORTED. The official client (`@modelcontextprotocol/
// ext-apps`) bundles to about 590 KB, nearly all of it schema validation, and this document is
// returned whole from every `resources/read`. The protocol the view needs is a handshake, four
// notifications and four requests, which is what is below. scripts/mcp-app-check.mjs drives this
// file against the official host implementation (`AppBridge`), so the two cannot quietly disagree.
//
// The handshake, in order:
//   view -> host   ui/initialize                 (request)
//   host -> view   result: hostContext, hostCapabilities
//   view -> host   ui/notifications/initialized  (notification)
//   host -> view   ui/notifications/tool-input   then  ui/notifications/tool-result

export const PROTOCOL_VERSION = '2026-01-26'

export type DisplayMode = 'inline' | 'fullscreen' | 'pip'

export interface HostContext {
  theme?: 'light' | 'dark'
  displayMode?: DisplayMode
  availableDisplayModes?: DisplayMode[]
  locale?: string
  platform?: 'web' | 'desktop' | 'mobile'
  styles?: { variables?: Record<string, string | undefined> }
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number }
  [key: string]: unknown
}

export interface HostCapabilities {
  serverTools?: object
  updateModelContext?: object
  message?: object
  openLinks?: object
  [key: string]: unknown
}

export interface ToolResult {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string }
}

/** How long a request to the host may take. A tool call builds a whole statement package. */
const REQUEST_TIMEOUT_MS = 60_000

export class HostBridge {
  hostContext: HostContext = {}
  hostCapabilities: HostCapabilities = {}
  connected = false

  onToolResult: (result: ToolResult) => void = () => {}
  onToolInput: (args: Record<string, unknown>) => void = () => {}
  onToolCancelled: (reason: string | undefined) => void = () => {}
  onHostContextChanged: (context: HostContext) => void = () => {}

  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>()
  private readonly host: Window | null

  constructor() {
    // Rendered directly (a file opened in a tab, a test page) there is no host to talk to.
    this.host = window.parent && window.parent !== window ? window.parent : null
    window.addEventListener('message', event => this.receive(event))
  }

  get hasHost(): boolean {
    return this.host !== null
  }

  async connect(appInfo: { name: string; version: string }, availableDisplayModes: DisplayMode[]): Promise<void> {
    if (!this.host) throw new Error('No host')
    const result = await this.request('ui/initialize', {
      appInfo,
      appCapabilities: { availableDisplayModes },
      protocolVersion: PROTOCOL_VERSION,
    })
    this.hostContext = (result?.hostContext as HostContext) ?? {}
    this.hostCapabilities = (result?.hostCapabilities as HostCapabilities) ?? {}
    this.connected = true
    this.notify('ui/notifications/initialized', {})
  }

  /** Call a tool on this view's own MCP server, through the host. Subject to the host's consent. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.request('tools/call', { name, arguments: args })
  }

  /** Ask for a display mode. The host answers with the mode it actually set. */
  async requestDisplayMode(mode: DisplayMode): Promise<DisplayMode> {
    const result = await this.request('ui/request-display-mode', { mode })
    return (result?.mode as DisplayMode) ?? mode
  }

  /**
   * Tell the model what the view now shows, without starting a turn. After a drill-in or a period
   * change the conversation's last tool result is stale; this is how "what is this company's MOIC"
   * gets answered about the screen the user is actually looking at. Each call replaces the last.
   */
  updateModelContext(text: string): void {
    if (!this.connected || !this.hostCapabilities.updateModelContext) return
    this.request('ui/update-model-context', { content: [{ type: 'text', text }] }).catch(() => {})
  }

  /** Report the content's size so an inline view is given exactly the height it needs. */
  sendSize(width: number, height: number): void {
    if (this.connected) this.notify('ui/notifications/size-changed', { width, height })
  }

  // -------------------------------------------------------------------------------------------

  private post(message: JsonRpcMessage): void {
    // '*' because a sandboxed view cannot know its host's origin. Nothing here is a secret from
    // the host: it is the party that fetched this document and holds the connection.
    this.host?.postMessage(message, '*')
  }

  private notify(method: string, params: unknown): void {
    this.post({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.host) return Promise.reject(new Error('No host'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The assistant did not respond in time.'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ jsonrpc: '2.0', id, method, params })
    })
  }

  private receive(event: MessageEvent): void {
    // Only the window that embedded this view. Any other frame on the page is not the host.
    if (!this.host || event.source !== this.host) return
    const message = event.data as JsonRpcMessage | null
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return

    // A response to one of our requests.
    if (message.method === undefined) {
      const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (!waiting) return
      this.pending.delete(message.id as number)
      window.clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(message.error.message || 'The request was refused.'))
      else waiting.resolve(message.result)
      return
    }

    // A request from the host: it expects an answer.
    if (message.id !== undefined && message.id !== null) {
      if (message.method === 'ui/resource-teardown' || message.method === 'ping') {
        this.post({ jsonrpc: '2.0', id: message.id, result: {} })
      } else {
        this.post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
      }
      return
    }

    // A notification.
    switch (message.method) {
      case 'ui/notifications/tool-result':
        this.onToolResult((message.params ?? {}) as ToolResult)
        break
      case 'ui/notifications/tool-input':
        this.onToolInput((message.params?.arguments ?? {}) as Record<string, unknown>)
        break
      case 'ui/notifications/tool-cancelled':
        this.onToolCancelled(message.params?.reason)
        break
      case 'ui/notifications/host-context-changed':
        // A partial update: only the fields that changed.
        this.hostContext = { ...this.hostContext, ...(message.params ?? {}) }
        this.onHostContextChanged(this.hostContext)
        break
    }
  }
}
