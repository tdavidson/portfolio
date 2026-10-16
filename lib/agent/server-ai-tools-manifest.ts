// Pure metadata for the SERVER-AI tools: work the fund's own model does, for an assistant that would
// rather not spend its own context on it. NO server imports (the Settings key UI lists these).
// Handlers live in server-ai-tools.ts.
//
// The assistant can always do the same itself (company_save_summary; reading rows and calling the
// write tools), so with no server key these refuse and say which tools to use instead
// (lib/ai/server-ai.ts). Each is gated like the web button it mirrors:
//
//   company_generate_summary → api/companies/[id]/summary (POST): a write, staged from a chat
//   portfolio_import_preview → api/import (POST), under the imports switch: it writes nothing, so
//                              it runs directly; the assistant applies it with tools that stage

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

export const SERVER_AI_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'company_generate_summary',
    description:
      'Have the app\'s own model write and save a portfolio company\'s AI summary, exactly as the company page\'s Summarise ' +
      'button does (same inputs: metrics, the latest update and its files, documents, earlier summaries; same prompt). Needs ' +
      'a server AI key: with none it refuses, and you write the summary yourself from company_detail, company_metrics and ' +
      'get_updates and save it with company_save_summary.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company id or name.' },
        provider: { type: 'string', enum: ['anthropic', 'openai'], description: 'Optional: which of the fund\'s providers to use.' },
      },
      required: ['company'],
    },
  },
  {
    name: 'portfolio_import_preview',
    description:
      'Have the app\'s own model read a pasted spreadsheet or CSV of portfolio companies (names, details, metric history), ' +
      'as the web AI import does, and return what it read as a proposal. Writes NOTHING: show the person the proposal, ' +
      'then apply it with create_company, record_metric_value and record_investment (several at once: stage_run). Needs a ' +
      'server AI key: with none it refuses, and you read the rows yourself and call those tools.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'imports',
    runsDirectly: true,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The rows, as pasted text or CSV (up to 500,000 characters).' },
      },
      required: ['text'],
    },
  },
]
