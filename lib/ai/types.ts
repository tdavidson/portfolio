// cacheControl marks a block as a prompt-cache breakpoint (Anthropic ephemeral
// cache). Set it on a large, byte-identical leading block that's re-sent across
// many calls (e.g. shared data-room evidence across checklist batches) so those
// calls become cache reads. Ignored by providers without prompt caching.
export interface TextBlock { type: 'text'; text: string; cacheControl?: boolean }
export interface DocumentBlock { type: 'document'; mediaType: string; data: string }
export interface ImageBlock { type: 'image'; mediaType: string; data: string }

export type ContentBlock = TextBlock | DocumentBlock | ImageBlock
export type MessageContent = string | ContentBlock[]

/** How hard the model thinks before answering. Providers that lack the knob ignore it. */
export type AIEffort = 'low' | 'medium' | 'high' | 'max'
export const AI_EFFORTS: AIEffort[] = ['low', 'medium', 'high', 'max']

export interface CreateMessageParams {
  model: string
  maxTokens: number
  system?: string
  content: MessageContent
  effort?: AIEffort
  /** Cancels the provider request when the originating client disconnects or explicitly stops. */
  signal?: AbortSignal
  /**
   * Enable provider-side web search. Only honored by Anthropic right now; other
   * providers ignore the flag (the prompt fallback handles graceful degradation).
   * Adds Anthropic's web_search billing (~$10 / 1,000 searches) on top of tokens.
   */
  enableWebSearch?: boolean
  /**
   * Maximum web search invocations per request. Only used when enableWebSearch
   * is true. Defaults to 5 if omitted.
   */
  webSearchMaxUses?: number
}

export interface AIModel { id: string; name: string }

export interface TokenUsage {
  /** Non-cached input tokens (Anthropic reports cached input separately). */
  inputTokens: number
  outputTokens: number
  /** Tokens served from the prompt cache (billed ~0.1x input). */
  cacheReadTokens?: number
  /** Tokens written to the prompt cache (billed ~1.25x input). */
  cacheCreationTokens?: number
}

export interface AIResult {
  text: string
  usage: TokenUsage
  truncated: boolean
  /**
   * Number of server-side web searches the model actually performed. Only
   * meaningful when the request was made with enableWebSearch. 0 means the
   * tool was attached but the model chose not to search (or couldn't).
   */
  webSearchCount?: number
  /**
   * URLs the model cited via the web_search tool. Anthropic attaches citations
   * as metadata on text blocks; when the model writes JSON output it often
   * doesn't echo the URL into the JSON, so we surface them here for callers
   * that want to render or merge them. Deduped across blocks.
   */
  webSearchCitations?: Array<{ url: string; title: string }>
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CreateChatParams {
  model: string
  maxTokens: number
  system?: string
  messages: ChatMessage[]
  effort?: AIEffort
  /** Cancels the provider request when the originating client disconnects or explicitly stops. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Tool use
// ---------------------------------------------------------------------------

/**
 * A tool the model can call, executed by US (client-side). The provider runs the
 * request → tool_use → execute → tool_result loop internally and returns only
 * the final text, so callers never have to model tool blocks in their own
 * message history.
 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
}

export interface ToolInvocation {
  name: string
  input: Record<string, unknown>
}

/** Executes one tool call and returns the result as text for the model. */
export type ToolExecutor = (call: ToolInvocation) => Promise<string>

/**
 * A remote MCP server the PROVIDER connects to on our behalf (Anthropic's MCP
 * connector). Its tools execute on the MCP server, not here — so no executor is
 * needed, and `executeTool` is never called for them.
 */
export interface McpServerConfig {
  name: string
  url: string
  /** Bearer token passed to the MCP server (for Affinity: the user's API key). */
  authorizationToken?: string
}

export interface CreateToolLoopParams extends Omit<CreateMessageParams, 'content'> {
  /**
   * A single opening user message. Use for one-shot agentic calls (e.g. diligence Q&A).
   * Provide EITHER this or `messages`; when both are set, `messages` wins.
   */
  content?: MessageContent
  /**
   * Multi-turn conversation history to seed the loop with — for chat surfaces (the Analyst) that
   * must keep prior turns. Roles map straight to the provider's user/assistant turns.
   */
  messages?: ChatMessage[]
  tools?: ToolDefinition[]
  executeTool?: ToolExecutor
  mcpServers?: McpServerConfig[]
  /** Safety valve: stop after this many model round-trips. Defaults to 6. */
  maxIterations?: number
  /** Called before each model round-trip (0 = the first), so a caller can say it is thinking. */
  onRound?: (round: number) => void
}

export interface ToolCallRecord {
  name: string
  input: Record<string, unknown>
  /** Truncated — for surfacing "what the assistant looked up", not for replay. */
  resultPreview: string
  isError: boolean
}

export interface ToolLoopResult extends AIResult {
  toolCalls: ToolCallRecord[]
  /** The loop hit maxIterations with tool calls still asked for — it stopped, it did not finish. */
  stoppedAtLimit?: boolean
}

export interface AIProvider {
  createMessage(params: CreateMessageParams): Promise<AIResult>
  createChat(params: CreateChatParams): Promise<AIResult>
  testConnection(): Promise<void>
  listModels(): Promise<AIModel[]>
  /**
   * Run an agentic tool-use loop. Optional: only providers that support tool
   * calling implement it. Callers MUST check `supportsToolLoop` and fall back to
   * a plain createMessage — the fund's provider may be OpenAI/Gemini/Ollama.
   */
  readonly supportsToolLoop?: boolean
  createToolLoop?(params: CreateToolLoopParams): Promise<ToolLoopResult>
}
