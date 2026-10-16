// Tools that ask the SERVER's model to do the work (lib/agent/server-ai-tools.ts). The assistant
// in the chat can always do the same itself, so with no server key these refuse, early, and say
// which tools to use instead: at the call, and before a chat stages one (a staged call that could
// never run would only fail at approval).

import type { SupabaseClient } from '@supabase/supabase-js'
import { fundHasAIKey } from './keyless'

export const SERVER_AI_TOOLS: Record<string, { what: string; instead: string }> = {
  company_generate_summary: {
    what: 'write the company summary itself',
    instead: 'Write it in chat instead: read the company with company_detail, company_metrics and get_updates, write the ' +
      'summary, and save it with company_save_summary.',
  },
  portfolio_import_preview: {
    what: 'read the pasted rows itself',
    instead: 'Do it in chat instead: read the rows yourself, then record them with create_company, record_metric_value and ' +
      'record_investment (several changes at once: stage_run, so they are approved together).',
  },
}

export function noServerAIMessage(toolName: string): string {
  const t = SERVER_AI_TOOLS[toolName]
  return `This fund has no server AI key, so the app's own model can't ${t?.what ?? 'do this'}. ${t?.instead ?? ''}`.trim()
}

/** The refusal for a server-AI tool on a fund with no key; null when it may run (or is not one). */
export async function serverAIRefusal(admin: SupabaseClient, fundId: string, toolName: string): Promise<string | null> {
  if (!(toolName in SERVER_AI_TOOLS)) return null
  return (await fundHasAIKey(admin, fundId)) ? null : noServerAIMessage(toolName)
}
