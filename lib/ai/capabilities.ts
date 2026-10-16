// Every feature that calls a model, and whether it works without a server AI key.
//
// A fund can run two ways. With a server key (Settings → AI providers), the app calls the model
// itself: the web app's AI buttons, inbound email parsing and the background jobs all work. With
// no key, the person's own assistant (Claude, ChatGPT, Claude Code) connected over MCP does the
// thinking: it reads the data with read tools and writes the result back with write tools. That
// covers anything a person asks for in chat, but not the web app's own buttons (a button has no
// model to borrow) and not work that runs with nobody present.
//
// ONE list, read by every surface that says what works without a key: the onboarding wizard,
// Settings, the getting-started checklist, the /setup health page, `setup_status` over MCP, the
// bootstrap script and the DOCS table. So they cannot disagree. `lib/ai/capabilities.test.ts`
// checks every tool named here exists and that DOCS.md carries every label.
//
// It describes what is true NOW. When a feature gains a keyless path, move it in the same change.

import { hasAnyAIKeyFrom } from '@/lib/credentials/env'

export type KeylessSupport =
  /** Works with no server key: ask your assistant, and it uses the tools listed. */
  | 'assistant'
  /**
   * Runs unattended with a key. With none, the work is saved and waits until you ask your
   * assistant to do it (the prompt), instead of failing.
   */
  | 'on_demand'
  /** Needs a server AI key today. `why` says what is missing. */
  | 'needs_key'

export interface AICapability {
  key: string
  label: string
  keyless: KeylessSupport
  /** One line. For `assistant`: how it works without a key. For `needs_key`: why it can't. */
  why: string
  /** For `assistant` and `on_demand`: what to type into your assistant. */
  prompt?: string
  /** For `assistant` and `on_demand`: the MCP tools it uses. */
  tools?: string[]
}

export const AI_CAPABILITIES: AICapability[] = [
  {
    key: 'analyst',
    label: 'Questions about the fund (the Analyst)',
    keyless: 'assistant',
    why: 'Your assistant answers from the same data the Analyst reads, through the read tools.',
    prompt: 'How is the portfolio doing this quarter?',
    tools: ['portfolio_summary', 'company_detail', 'lp_capital_summary', 'fund_performance'],
  },
  {
    key: 'forecast_draft',
    label: 'Drafting a forecast',
    keyless: 'assistant',
    why: 'Your assistant builds the plan from the forecast tools.',
    prompt: 'Draft a forecast for Fund I.',
    tools: ['forecast_create_plan', 'forecast_update_plan', 'forecast_series'],
  },
  {
    key: 'lp_letter',
    label: 'Writing the quarterly LP letter',
    keyless: 'assistant',
    why: 'Your assistant reads the quarter\'s figures and writes the draft back.',
    prompt: 'Write the Q3 letter for Fund I.',
    tools: ['lp_create_letter', 'lp_letter_data', 'lp_write_letter'],
  },
  {
    key: 'letter_template',
    label: 'Learning a letter template from an example',
    keyless: 'assistant',
    why: 'Your assistant reads the example and saves the template.',
    prompt: 'Use this past letter as our letter template.',
    tools: ['document_template_get', 'document_template_save'],
  },
  {
    key: 'company_update',
    label: 'Reading a company update you share in chat',
    keyless: 'assistant',
    why: 'Your assistant reads the letter, deck or KPI sheet and records each figure.',
    prompt: 'Here is Acme\'s Q3 update: record the metrics.',
    tools: ['company_detail', 'record_metric_value'],
  },
  {
    key: 'imports',
    label: 'Importing companies, investments and LPs from a paste or spreadsheet',
    keyless: 'assistant',
    why: 'Your assistant parses the rows and records each one. With a server key, portfolio_import_preview has the app\'s model read them into a proposal first, which your assistant then applies.',
    prompt: 'Import these investments.',
    tools: ['create_company', 'record_metric_value', 'record_investment', 'lp_create_investor', 'lp_record_commitment'],
  },
  {
    key: 'bank_categorize',
    label: 'Categorising bank transactions',
    keyless: 'assistant',
    why: 'Your assistant matches each transaction to the chart of accounts and sets it.',
    prompt: 'Categorise the uncategorised bank transactions.',
    tools: ['list_bank_transactions', 'list_accounts', 'set_bank_transaction_account'],
  },
  {
    key: 'deal_analysis',
    label: 'Adding and analysing a deal against the thesis',
    keyless: 'assistant',
    why: 'A deal added from chat is saved unanalysed; your assistant reads it and the thesis and writes the analysis back.',
    prompt: 'Add this pitch to deal flow and analyse it against our thesis.',
    tools: ['deals_create_inbound', 'deals_inbound_detail', 'deals_update_inbound'],
  },
  {
    key: 'memo_edit',
    label: 'Editing an investment memo',
    keyless: 'assistant',
    why: 'Your assistant reads the memo and evidence and rewrites paragraphs.',
    prompt: 'Tighten the risks section of the Acme memo.',
    tools: ['diligence_memo', 'diligence_evidence', 'diligence_write_memo'],
  },
  {
    key: 'portal_analyst',
    label: 'Investor questions in the LP portal',
    keyless: 'assistant',
    why: 'An investor connects their own assistant to the portal and asks it.',
  },
  {
    key: 'web_ai_buttons',
    label: 'AI buttons in the web app (Analyst panel, Generate letter, AI import, Summarise)',
    keyless: 'needs_key',
    why: 'A button in the browser has no model of its own to borrow; without a key, do the same thing from your assistant.',
  },
  {
    key: 'inbound_email',
    label: 'Reading emailed company updates',
    keyless: 'on_demand',
    why: 'With a key it runs as each email arrives. Without one, each update is saved and waits in an inbox your assistant clears when you ask.',
    prompt: 'Process my inbox.',
    tools: ['inbox_waiting', 'inbox_read', 'record_metric_value', 'inbox_done'],
  },
  {
    key: 'inbound_routing',
    label: 'Sorting inbound email into deals, diligence and updates',
    keyless: 'needs_key',
    why: 'It runs as each email arrives, with nobody present. Without a key, everything is treated as a company update.',
  },
  {
    key: 'ocr',
    label: 'Reading scanned pages in company updates',
    keyless: 'on_demand',
    why: 'With a key a background job reads them. Without one, scans wait until you ask: your assistant looks at each page and saves its text. Text PDFs are read without a model either way.',
    prompt: 'Read the scanned updates waiting for me.',
    tools: ['ocr_waiting', 'ocr_page', 'ocr_save_text'],
  },
  {
    key: 'memo_pipeline',
    label: 'The memo agent (ingest, research, draft, score)',
    keyless: 'on_demand',
    why: 'With a key its stages run as background jobs. Without one, a stage waits until you ask: your assistant answers each request the stage would have sent a model, and the stage stores the result as it would with a key.',
    prompt: 'Run the memo agent on Acme: analyse the data room, then draft the memo.',
    tools: ['diligence_run_agent', 'diligence_stage_next', 'diligence_stage_read', 'diligence_stage_submit'],
  },
  {
    key: 'diligence_qa',
    label: 'Asking questions of a deal\'s data room',
    keyless: 'assistant',
    why: 'Your assistant reads the documents\' text and the memo agent\'s evidence, and answers in chat.',
    prompt: 'What does Acme\'s data room say about churn?',
    tools: ['diligence_list_documents', 'diligence_document_text', 'diligence_evidence'],
  },
  {
    key: 'company_summary',
    label: 'Saving an AI summary on a company page',
    keyless: 'assistant',
    why: 'Your assistant reads the company\'s metrics and updates, writes the summary and saves it to the company. With a server key, company_generate_summary has the app\'s model write it, as the Summarise button does.',
    prompt: 'Write and save a summary for Acme.',
    tools: ['company_detail', 'company_metrics', 'get_updates', 'company_save_summary'],
  },
  {
    key: 'deal_research',
    label: 'Web research on inbound deals',
    keyless: 'assistant',
    why: 'Your assistant searches the web with its own tools and saves the findings and sources to the deal.',
    prompt: 'Research the founders of Acme and save what you find.',
    tools: ['deals_inbound_detail', 'deals_update_inbound'],
  },
]

/** How AI runs for this fund. */
export type AIMode = 'server_key' | 'assistant'

export function isAIMode(v: unknown): v is AIMode {
  return v === 'server_key' || v === 'assistant'
}

/**
 * The fund's effective mode. A saved key always wins: it is what can actually run. Otherwise the
 * admin's recorded choice, or null when nobody has chosen yet (the checklist still asks).
 */
export function effectiveAIMode(hasKey: boolean, stored: unknown): AIMode | null {
  if (hasKey) return 'server_key'
  return stored === 'assistant' ? 'assistant' : null
}

/** The fund_settings columns that hold a provider key. */
export const AI_KEY_COLUMNS = ['claude_api_key_encrypted', 'openai_api_key_encrypted', 'openrouter_api_key_encrypted'] as const

/** Any server AI key: one saved in Settings, or one set in the deployment's environment (lib/credentials/env.ts). */
export function hasAnyAIKey(settings: Record<string, unknown> | null | undefined): boolean {
  return (!!settings && AI_KEY_COLUMNS.some(c => !!settings[c])) || hasAnyAIKeyFrom(null)
}

export interface AIStatus {
  mode: AIMode | null
  hasKey: boolean
  /** What your assistant can do without a server key. */
  worksWithoutKey: { feature: string; how: string; ask?: string }[]
  /** Unattended work that, without a key, is saved and waits until you ask your assistant. */
  waitsForYou: { feature: string; how: string; ask?: string }[]
  /** What needs a server key, and why. */
  needsKey: { feature: string; why: string }[]
}

/** The summary `setup_status` returns and the scripts print. */
export function aiStatus(hasKey: boolean, stored: unknown): AIStatus {
  return {
    mode: effectiveAIMode(hasKey, stored),
    hasKey,
    worksWithoutKey: AI_CAPABILITIES.filter(c => c.keyless === 'assistant')
      .map(c => ({ feature: c.label, how: c.why, ...(c.prompt ? { ask: c.prompt } : {}) })),
    waitsForYou: AI_CAPABILITIES.filter(c => c.keyless === 'on_demand')
      .map(c => ({ feature: c.label, how: c.why, ...(c.prompt ? { ask: c.prompt } : {}) })),
    needsKey: AI_CAPABILITIES.filter(c => c.keyless === 'needs_key').map(c => ({ feature: c.label, why: c.why })),
  }
}

/** The DOCS.md table ("AI without a server key"); a test checks DOCS carries it verbatim. */
export function aiCapabilityTable(): string {
  const rows = AI_CAPABILITIES.map(c => {
    const tools = c.tools?.length ? ` (${c.tools.map(t => `\`${t}\``).join(', ')})` : ''
    const support = c.keyless === 'assistant' ? 'Yes, from your assistant' : c.keyless === 'on_demand' ? 'Waits for your assistant' : 'Needs a key'
    return `| ${c.label} | ${support} | ${c.why}${tools} |`
  })
  return ['| Feature | Without a server key | How, or why not |', '|---|---|---|', ...rows].join('\n')
}
