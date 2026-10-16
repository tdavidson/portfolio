// Pure metadata for the DILIGENCE agent tools — the deal room: data room, checklist,
// extracted evidence, attention queue, memo. NO server imports, so this is safe in client
// components (the Settings key UI lists it). Handlers live in diligence-tools.ts.
//
// Fund-scoped, never vehicle-scoped: a diligence deal is a company the fund is
// evaluating, and it belongs to no vehicle at all — it has not been invested in yet.
//
// NAMING, DELIBERATELY: every tool here says `diligence_`. The fund has TWO things that
// a person would call a "deal" — an `inbound_deals` row (top-of-funnel email intake, see
// deals-tools-manifest.ts) and a `diligence_deals` row (the deal room). They are separate
// tables and separate stages of one funnel. A tool named `get_deal` would answer about
// the wrong one roughly half the time, so no tool is named that.
//
// The writes do what the Diligence page does (lib/diligence/service.ts, lib/memo-agent/enqueue.ts).
// From a connected chat each is staged, and applied when the person approves it in the chat.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { UPLOADED_FILES_SCHEMA } from './upload-tools-manifest'

const DEAL = { type: 'string', description: 'Diligence deal id, or the deal name (matched case-insensitively, aliases included).' }

export const DILIGENCE_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'diligence_list_deals',
    description: 'List deals in diligence with their status and how far through the memo pipeline they are.',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional: active | passed | won | lost | on_hold' },
        q: { type: 'string', description: 'Optional: match on deal name or sector.' },
      },
    },
  },
  {
    name: 'diligence_deal_detail',
    description:
      'One diligence deal in full: status, sector, stage, lead partner, plus a progress report across the five pipeline stages ' +
      '(data room, checklist, research, scoring, memo) with what is blocking each, and the memo agent\'s latest job ' +
      '(running, finished or failed, with its error) — check here after diligence_run_agent.',
    scope: 'read',
    domain: 'diligence',
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_ask',
    description:
      'Ask a question about a deal and get an answer grounded in its data room, with citations to the documents it came from. ' +
      'This is the tool to reach for on any "what does the data room say about X" question — it answers from the evidence the ' +
      'ingest stage extracted from every document, and says so plainly when the evidence does not cover it rather than guessing. ' +
      'Requires the data room to have been analyzed first (see diligence_deal_detail).',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        question: { type: 'string', description: 'The question, in plain English.' },
      },
      required: ['deal', 'question'],
    },
  },
  {
    name: 'diligence_checklist',
    description:
      'The diligence checklist for a deal: every item by section, with its status (found | partial | missing | not_applicable | unknown), ' +
      'the evidence behind it, and a coverage summary. Use this to answer "what are we still missing on this deal".',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        status: { type: 'string', description: 'Optional: only items with this status. "missing" gives you the gap list.' },
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_list_documents',
    description: "The deal's data room: every document, its detected type, and whether it has been parsed into evidence yet.",
    scope: 'read',
    domain: 'diligence',
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_document_text',
    description:
      'The text of one data-room document (PDF, Word, Excel, text), read now from the stored file: how you answer questions ' +
      'about a deal from its documents yourself, including when the fund has no server AI key. A scanned PDF has no text ' +
      'layer and comes back empty; say so rather than guessing. Page through a long one with offset.',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        document: { type: 'string', description: 'The document id, or its file name, from diligence_list_documents.' },
        offset: { type: 'number', description: 'Character offset to start from (default 0).' },
        max_chars: { type: 'number', description: '2000-60000; default 30000.' },
      },
      required: ['deal', 'document'],
    },
  },
  {
    name: 'diligence_evidence',
    description:
      'The raw evidence base extracted from the deal: per-document claims (with criticality), research findings, contradictions, ' +
      'competitive map, and the gap analysis. This is what the memo and the Q&A are built from — reach for it when you want the ' +
      'underlying facts rather than a written answer.',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        include: {
          type: 'string',
          description: "Optional: 'claims' | 'research' | 'gaps' | 'all' (default 'all'). Narrow it — the full evidence base is large.",
        },
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_memo',
    description:
      "The investment memo draft: its prose by section, the rubric scores, and the partner-attention queue (what must still be " +
      'addressed before it can be finalized).',
    scope: 'read',
    domain: 'diligence',
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_create_deal',
    description:
      'Open a deal room for a company the fund is evaluating, with the fund\'s checklist seeded and its memo preset for the stage ' +
      'applied. For a deal that came in through deal flow, use deals_promote_to_diligence instead so the two stay linked.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The company.' },
        sector: { type: 'string' },
        stage: { type: 'string', description: 'The round being considered, e.g. Seed, Series A.' },
        lead_partner: { type: 'string', description: 'A team member\'s email or name.' },
        drive_folder_url: { type: 'string', description: 'Optional: the data room folder link.' },
        vehicle: { type: 'string', description: 'The entity it is for (name or id). Required unless the user sees every entity.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'diligence_update_deal',
    description:
      'Change a diligence deal: its name, sector, stage, lead partner, entity, or status (active | passed | invested | on_hold). ' +
      'Marking it invested records the decision; recording the investment itself is record_investment.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        name: { type: 'string' },
        sector: { type: 'string' },
        stage: { type: 'string' },
        status: { type: 'string', description: 'active | passed | invested | on_hold' },
        lead_partner: { type: 'string', description: 'A team member\'s email or name. An empty string clears it.' },
        vehicle: { type: 'string', description: 'Move it to this entity (name or id).' },
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_add_checklist_item',
    description: 'Add an item to a deal\'s diligence checklist, under a section (found by name, or created).',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        label: { type: 'string', description: 'What needs checking.' },
        section: { type: 'string', description: 'Optional: the section, e.g. Team, Market, Financials.' },
      },
      required: ['deal', 'label'],
    },
  },
  {
    name: 'diligence_update_checklist_item',
    description:
      'Update one checklist item: mark its status (found | partial | missing | not_applicable | unknown), add the partner\'s notes, ' +
      'or record a fact the partner learned (from a call, a reference) as evidence. Find the item id with diligence_checklist.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        item: { type: 'string', description: 'The item id from diligence_checklist, or its exact label.' },
        status: { type: 'string', description: 'found | partial | missing | not_applicable | unknown' },
        partner_notes: { type: 'string', description: 'Replaces the partner notes on the item.' },
        add_fact: { type: 'string', description: 'A fact to add to the item\'s partner facts.' },
        label: { type: 'string', description: 'Rename the item.' },
      },
      required: ['deal', 'item'],
    },
  },
  {
    name: 'diligence_add_note',
    description: 'Add a note to a diligence deal (a call summary, a reference check, a concern), in the user\'s name.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: { deal: DEAL, body: { type: 'string', description: 'The note.' } },
      required: ['deal', 'body'],
    },
  },
  {
    name: 'diligence_add_documents',
    description:
      'Add files to a deal\'s data room (a deck, a model, a transcript). They are scanned and classified; run ' +
      'diligence_run_agent with stage "analyze" afterwards to read them into evidence. For a file on disk (anything over 3 MB, ' +
      'up to 100 MB) use diligence_document_upload_url first and pass uploaded_files: never ask the person to paste the file into chat.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: { deal: DEAL, files: {
          type: 'array',
          description: 'Up to 5 files, each up to 3 MB, as { filename, content_base64 }.',
          items: { type: 'object', properties: { filename: { type: 'string' }, content_base64: { type: 'string' } }, required: ['filename', 'content_base64'] },
        },
        uploaded_files: UPLOADED_FILES_SCHEMA('diligence_document_upload_url', 'up to 100 MB each, 20 per call'),
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_resolve_attention',
    description:
      'Close an item in a deal\'s attention queue (the open questions diligence_memo lists): done, ignore, or reopen with open.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        item: { type: 'string', description: 'The attention item id from diligence_memo.' },
        status: { type: 'string', description: 'done | ignore | open' },
        note: { type: 'string', description: 'Optional: how it was resolved.' },
      },
      required: ['deal', 'item', 'status'],
    },
  },
  {
    name: 'diligence_run_agent',
    description:
      'Start a stage of the memo agent on a deal: "analyze" reads the data room into evidence and checks the checklist ' +
      '(only what is new, unless full is true), "research" runs outside research, "draft" writes the memo, "score" scores it ' +
      'against the rubric. Each costs model spend, within the fund\'s caps, and runs in the background; follow it with ' +
      'diligence_deal_detail. With no server AI key it waits for you instead: run it with diligence_stage_next.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        stage: { type: 'string', enum: ['analyze', 'research', 'draft', 'score'] },
        full: { type: 'boolean', description: 'analyze only: re-read every document and re-check every item.' },
      },
      required: ['deal', 'stage'],
    },
  },
  {
    name: 'diligence_job_status',
    description:
      'How a memo-agent job is going: queued, running, done or failed, its latest progress message, and its error if it failed. ' +
      "Pass the job_id diligence_run_agent returned, or a deal for its recent jobs.",
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The job id a tool returned (its job.id).' }, deal: { type: 'string', description: 'Deal id or name: its latest jobs.' } },
    },
  },
  {
    name: 'diligence_write_memo',
    description:
      'Write in the memo draft in the partner\'s words: rewrite a paragraph (its id from diligence_memo), or add a paragraph to ' +
      'a section. Writing to the recommendation section fills in the partner placeholder, which must be done before finalizing.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        paragraph_id: { type: 'string', description: 'The paragraph to rewrite, from diligence_memo.' },
        section: { type: 'string', description: 'Or: the section to add to, e.g. recommendation.' },
        prose: { type: 'string' },
      },
      required: ['deal', 'prose'],
    },
  },
  {
    name: 'diligence_finalize_memo',
    description:
      'Finalize the deal\'s memo draft, locking it. Only an admin can approve this, and the recommendation must be written first.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_stage_next',
    description:
      'Run the memo agent on a deal with your own model, when the fund has no server AI key. diligence_run_agent queues a ' +
      'stage; this carries the deal\'s queued stages as far as it can and returns the calls that need your answer: each is a ' +
      'request the stage would have sent a model (a system prompt and content). Read them with diligence_stage_read, answer with ' +
      'diligence_stage_submit, and the stage stores its result exactly as it does with a key. Writes only into the open memo draft, ' +
      'which only a partner can finalise.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_stage_read',
    description:
      'Read one call diligence_stage_next listed: its content by call_id, or the stage\'s system prompt by system_id (once per ' +
      'system_id; calls share it). Long texts come in pages: pass offset = next_offset until it is null. An attachment (a ' +
      'scanned PDF or an image the call carries) comes back as an image: pass attachment, and page for a PDF.',
    scope: 'read',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        call_id: { type: 'string' },
        system_id: { type: 'string' },
        offset: { type: 'number' },
        max_chars: { type: 'number', description: '2000-60000; default 40000.' },
        attachment: { type: 'number', description: 'The attachment index the call\'s text names.' },
        page: { type: 'number', description: 'For a PDF attachment: the page, from 1.' },
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_stage_submit',
    description:
      'Answer calls diligence_stage_next listed, each with the JSON object its content asks for (nothing around it). For a call ' +
      'with web_search, pass the pages you read as sources. When every listed call is answered the stage carries on, and ' +
      'this returns the next calls, or what finished.',
    scope: 'write',
    domain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              call_id: { type: 'string' },
              text: { type: 'string', description: 'The JSON object, as text.' },
              sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] } },
            },
            required: ['call_id', 'text'],
          },
        },
      },
      required: ['deal', 'answers'],
    },
  },
]
