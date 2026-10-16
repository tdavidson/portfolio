// Pure metadata for the INBOUND DEALS agent tools — top-of-funnel deal flow. NO server
// imports (the Settings key UI lists these). Handlers live in deals-tools.ts.
//
// THE DISTINCTION THAT MATTERS, and the reason every description below spells it out:
// the fund has two things a person calls a "deal", and they are different tables at
// different stages of one funnel.
//
//   inbound_emails → inbound_deals → (promoted) → diligence_deals → (invested) → companies
//                    ^^^^^^^^^^^^^                 ^^^^^^^^^^^^^^^
//                    THIS FILE                     diligence-tools-manifest.ts
//
// `inbound_deals` is screening: a pitch arrived by email, got scored against the thesis,
// and is waiting on a pass/advance call. `diligence_deals` is the deal room: documents,
// checklist, memo. A tool that blurred them would answer the wrong question silently, so
// the tool names carry the stage and the descriptions say which is which.
//
// The writes do what the Deals page does (lib/deals/service.ts), under the same entity rules. From
// a connected chat each is staged, and applied when the person approves it in the chat.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { UPLOADED_FILES_SCHEMA } from './upload-tools-manifest'

export const DEALS_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'deals_list_inbound',
    description:
      'List INBOUND deal flow — pitches that arrived by email and were screened against the fund thesis, with their fit score ' +
      'and status. This is top-of-funnel screening, BEFORE diligence: for deals in the deal room (documents, checklist, memo) ' +
      'use diligence_list_deals instead.',
    scope: 'read',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional: new | reviewing | passed | advancing | met | spam' },
        fit_score: { type: 'string', description: 'Optional: strong | moderate | weak | out_of_thesis' },
        intro_source: { type: 'string', description: 'Optional: referral | cold | warm_intro | accelerator | demo_day | event | other' },
        q: { type: 'string', description: 'Optional: match on company or founder name.' },
        limit: { type: 'number', description: 'Max rows (default 100, max 500).' },
      },
    },
  },
  {
    name: 'deals_inbound_detail',
    description:
      'One inbound deal in full: the company, the founders, how it reached us, the thesis-fit analysis, any automated research ' +
      'that has run on it, and whether it was promoted into diligence.',
    scope: 'read',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: { deal: { type: 'string', description: 'Inbound deal id, or the company name (matched case-insensitively).' } },
      required: ['deal'],
    },
  },
  {
    name: 'deals_create_inbound',
    description:
      'Add a deal to INBOUND deal flow by hand: a pitch the user heard about outside the fund\'s inbox. It runs through the same ' +
      'analyzer as an emailed pitch, so it lands on the Deals page scored against the thesis (with no server AI key it is saved ' +
      'unanalysed, and you write the analysis with deals_update_inbound). Attach the deck if the user has it: ' +
      'upload it first with deals_deck_upload_url and pass uploaded_files (never ask the person to paste the file into chat; ' +
      'files is only for something under 3 MB you already hold). Confirm the company, founder and pitch with the user first.',
    scope: 'write',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        founder_name: { type: 'string' },
        founder_email: { type: 'string' },
        pitch: { type: 'string', description: 'What the company does and why it is interesting, in the user\'s words.' },
        company_url: { type: 'string' },
        intro_source: { type: 'string', description: 'referral | cold | warm_intro | accelerator | demo_day | event | other' },
        referrer_name: { type: 'string' },
        referrer_email: { type: 'string' },
        vehicle: { type: 'string', description: 'The entity the deal is for (name or id). Required unless the user sees every entity.' },
        files: {
          type: 'array',
          description: 'Optional: up to 5 files (a deck, a one-pager), each up to 3 MB, as { filename, content_base64 }.',
          items: { type: 'object', properties: { filename: { type: 'string' }, content_base64: { type: 'string' } }, required: ['filename', 'content_base64'] },
        },
        uploaded_files: UPLOADED_FILES_SCHEMA('deals_deck_upload_url', 'up to 10 MB each, 10 per deal'),
      },
      required: ['company_name', 'founder_name', 'founder_email', 'pitch'],
    },
  },
  {
    name: 'deals_update_inbound',
    description:
      'Move an INBOUND deal: change its pipeline status (new, reviewing, advancing, met, diligence, invested, passed), ' +
      'the entity it belongs to, or who it is assigned to. Also writes its analysis (summary, thesis fit, stage, industry, raise): ' +
      'how an assistant analyses a deal when the fund has no server AI key, or corrects the model\'s. ' +
      'And it saves web research you ran yourself (research: summary, findings, the sources you read), stored where the ' +
      'app\'s own research goes. To open a deal room for it, use deals_promote_to_diligence instead.',
    scope: 'write',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: {
        deal: { type: 'string', description: 'Inbound deal id, or the company name.' },
        status: { type: 'string', description: 'new | reviewing | advancing | met | diligence | invested | passed' },
        vehicle: { type: 'string', description: 'Move it to this entity (name or id).' },
        assigned_to: { type: 'string', description: 'A team member\'s email or name. An empty string unassigns it.' },
        company_summary: { type: 'string', description: 'What the company does, in a few sentences.' },
        thesis_fit_analysis: { type: 'string', description: 'Why it does or does not fit the fund\'s thesis.' },
        thesis_fit_score: { type: 'string', enum: ['strong', 'moderate', 'weak', 'out_of_thesis', 'spam'] },
        stage: { type: 'string' },
        industry: { type: 'string' },
        raise_amount: { type: 'string', description: 'As stated, e.g. "$3M seed".' },
        research: {
          type: 'object',
          description: 'Web research you ran on the company and its founders. Replaces any earlier research on the deal.',
          properties: {
            summary: { type: 'string', description: 'Two or three sentences: what the research found, and how far it bears out the pitch.' },
            findings: {
              type: 'object',
              properties: {
                founder_background: { type: 'string' },
                prior_companies: { type: 'array', items: { type: 'string' } },
                traction_corroboration: { type: 'string', description: 'What public evidence supports or contradicts the claimed traction.' },
                market_context: { type: 'string' },
                red_flags: { type: 'array', items: { type: 'string' } },
                open_questions: { type: 'array', items: { type: 'string' } },
              },
            },
            sources: {
              type: 'array',
              description: 'The pages you actually read. At least one is required.',
              items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url'] },
            },
          },
          required: ['summary', 'sources'],
        },
      },
      required: ['deal'],
    },
  },
  {
    name: 'deals_research_inbound',
    description:
      'Queue external web research on an INBOUND deal (the company, its founders, its market), even one under the fund\'s usual ' +
      'interest bar. It costs model spend and runs in the background; read the result later with deals_inbound_detail.',
    scope: 'write',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: { deal: { type: 'string', description: 'Inbound deal id, or the company name.' } },
      required: ['deal'],
    },
  },
  {
    name: 'deals_research_status',
    description:
      'Whether external research on an inbound deal has finished: queued, running, done or failed, and the research once done. ' +
      'Pass the job_id deals_research_inbound returned, or the deal.',
    scope: 'read',
    domain: 'deals',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The job id a tool returned (its job.id).' }, deal: { type: 'string', description: 'Inbound deal id, or the company name.' } },
    },
  },
  {
    name: 'deals_promote_to_diligence',
    description:
      'Open a deal room for an INBOUND deal: creates the diligence deal pre-filled from it (with the fund\'s checklist) and moves ' +
      'the inbound deal to diligence. Returns the diligence deal id for the diligence_* tools.',
    scope: 'write',
    domain: 'deals',
    // The same gate as the web route: it creates a diligence record.
    accessDomain: 'diligence',
    inputSchema: {
      type: 'object',
      properties: { deal: { type: 'string', description: 'Inbound deal id, or the company name.' } },
      required: ['deal'],
    },
  },
]
