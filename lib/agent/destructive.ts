// Destructive agent tools: deletes, merges, and undoing posted books (manifest `destructive: true`).
//
// Two rules, checked here and nowhere else:
//   1. They exist only where the deployment turns them on, with AGENT_DESTRUCTIVE_ACTIONS=true in
//      its environment. Otherwise they are not listed (tools/list, search_tools, GET /api/agent) and
//      every call is refused naming the flag: directly, through call_tool, as a stage_run step, and
//      when a person approves one staged before the flag was turned off.
//   2. Where they exist, they are ALWAYS staged as a pending action, from any credential, an admin's
//      API key included, and only an admin approves them (each is in ADMIN_ONLY_TOOLS). See
//      `shouldStage` in ./dispatch.ts.
//
// Pure: no server imports, so the gateway, the REST route and the tests read the same answer.

export const DESTRUCTIVE_FLAG = 'AGENT_DESTRUCTIVE_ACTIONS'

/** Whether this deployment offers the destructive tools. Read per call, so a redeploy is not needed to test it. */
export function destructiveToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[DESTRUCTIVE_FLAG]?.trim().toLowerCase() === 'true'
}

export const DESTRUCTIVE_DISABLED_MESSAGE =
  `This tool deletes or undoes records, and destructive tools are turned off on this deployment. ` +
  `To turn them on, set ${DESTRUCTIVE_FLAG}=true in the deployment's environment and redeploy. ` +
  `Even then, every such change waits for an admin's approval. Until then, make this change in the app.`

/** Null when the tool may be offered and called; otherwise the refusal, naming the flag. */
export function destructiveRefusal(tool: { destructive?: boolean } | undefined | null): string | null {
  if (!tool?.destructive || destructiveToolsEnabled()) return null
  return DESTRUCTIVE_DISABLED_MESSAGE
}

/** Whether a listing should show this tool. */
export function isToolOffered(tool: { destructive?: boolean }): boolean {
  return destructiveRefusal(tool) === null
}
