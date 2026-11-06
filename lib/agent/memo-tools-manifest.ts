// Pure metadata for the investment MEMO tools: the investment-memo skill, the fund's memo voice and
// design settings, the memo brief, saving a memo written in a chat, outside research, export and
// Word re-import. NO server imports. Handlers live in memo-tools.ts.
//
// These give a connected assistant what the Diligence pages give a partner (and the reverse, see
// tests/memo-parity.test.ts), so a memo can be written in either place to the same structure, voice,
// design and review. Fund-scoped like the other diligence tools.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const DEAL = { type: 'string', description: 'Diligence deal id, or the deal name (matched case-insensitively, aliases included).' }
const base = { domain: 'diligence' as const }
const FILE = {
  type: 'object',
  description: 'The file, up to 3 MB, as { filename, content_base64 }.',
  properties: { filename: { type: 'string' }, content_base64: { type: 'string' } },
  required: ['filename', 'content_base64'],
}

export const MEMO_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'diligence_memo_skill',
    description:
      'The investment-memo skill, as this app holds it: SKILL.md (the process, hard rules, citation rules and review checklist ' +
      'every memo follows) with the fund\'s own voice, examples and house rules where it has saved them (else a general voice), ' +
      'and the memo\'s sections (with a deal: that deal\'s; without: the fund\'s default) and design template. Read it before ' +
      'writing a memo from diligence_memo_brief. It is always the current version, so prefer it to a copy you hold.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { deal: { ...DEAL, description: 'Optional: the deal, for its own sections.' } } },
  },
  {
    name: 'diligence_memo_brief',
    description:
      'Everything a deal\'s investment memo may be written from, each item with a citation ref: the data-room claims, research ' +
      'findings (including those added from chat), contradictions, partner Q&A answers, partner notes and checklist facts, ' +
      'the checklist\'s gaps, and the memo\'s sections in order with each one\'s depth and what it covers. Write from it with ' +
      'the skill (diligence_memo_skill), citing refs on every paragraph, then save with diligence_draft_memo.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { deal: DEAL }, required: ['deal'] },
  },
  {
    name: 'diligence_draft_memo',
    description:
      'Save an investment memo you wrote from diligence_memo_brief as a NEW open draft for the deal: paragraphs by section ' +
      '(id or title), each with the brief refs it rests on. The partners\' sections (the recommendation) keep their placeholder. ' +
      'Returns the draft and the review\'s flags (uncited paragraphs, refs not in the brief, figures not in the sources, a ' +
      'recommendation or team judgment, unlabeled projections, empty sections). Fix what you can and save again; show the ' +
      'person the rest. Never finalizes. To have the fund\'s own AI write the memo instead, use diligence_run_agent with stage "draft".',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        paragraphs: {
          type: 'array',
          description: 'The memo, in order.',
          items: {
            type: 'object',
            properties: {
              section: { type: 'string', description: 'The section id or title, from the brief.' },
              text: { type: 'string', description: 'One paragraph. A bulleted list is one paragraph of "- " lines.' },
              sources: { type: 'array', items: { type: 'string' }, description: 'Brief refs, e.g. "claim:claim_2_3", "finding:f_7".' },
            },
            required: ['section', 'text', 'sources'],
          },
        },
        header: {
          type: 'object',
          description: 'Optional: the first-page facts the design template fills.',
          properties: {
            company_name: { type: 'string' }, sector: { type: 'string' }, stage: { type: 'string' }, round_size: { type: 'string' },
            valuation: { type: 'string' }, memo_date: { type: 'string' }, location: { type: 'string' }, website: { type: 'string' },
          },
        },
        attention: {
          type: 'array',
          description: 'Optional: what a partner must look at before the memo is final.',
          items: {
            type: 'object',
            properties: {
              body: { type: 'string' },
              urgency: { type: 'string', enum: ['must_address', 'should_address', 'fyi'] },
              sources: { type: 'array', items: { type: 'string' } },
            },
            required: ['body'],
          },
        },
        notes: { type: 'string', description: 'Optional: what was hard, missing, or least certain.' },
      },
      required: ['deal', 'paragraphs'],
    },
  },
  {
    name: 'diligence_add_research',
    description:
      'Add findings from outside research you did with your own tools (company data, CRM, the web) to a deal\'s evidence, so ' +
      'a memo can cite them. Each needs a topic, the evidence, at least one source (title and link), and whether it verifies, ' +
      'contradicts or only repeats a company claim. Returns each finding\'s ref. Writes only into the deal\'s open draft.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
              evidence: { type: 'string', description: 'What was found, as the memo would rely on it.' },
              status: { type: 'string', enum: ['verified', 'contradicted', 'company_stated', 'inconclusive'] },
              sources: {
                type: 'array',
                items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title'] },
              },
              checks: { type: 'string', description: 'Optional: the data-room claim it checks, as a brief ref (claim:…).' },
            },
            required: ['topic', 'evidence', 'sources'],
          },
        },
      },
      required: ['deal', 'findings'],
    },
  },
  {
    name: 'diligence_memo_voice',
    description:
      "The fund's saved memo voice, house rules and examples (or that it has none and the general voice applies). With " +
      'include_sample_memos, also the text of the fund\'s sample memos, so you can learn a voice from them yourself and save it ' +
      'with diligence_memo_voice_save.',
    scope: 'read',
    ...base,
    inputSchema: {
      type: 'object',
      properties: { include_sample_memos: { type: 'boolean', description: 'Also return the sample memos\' text (long).' } },
    },
  },
  {
    name: 'diligence_memo_voice_learn',
    description:
      "Learn a memo voice, house rules and examples from the fund's sample memos with the fund's own AI (model spend). " +
      'Saves nothing: show the person the result, let them edit it, then save it with diligence_memo_voice_save. Lists any ' +
      'names or figures the examples reused from the memos, to replace first.',
    scope: 'read',
    ...base,
    inputSchema: {
      type: 'object',
      properties: { sample_memos: { type: 'array', items: { type: 'string' }, description: 'Optional: sample memo ids to learn from (default all).' } },
    },
  },
  {
    name: 'diligence_memo_voice_save',
    description:
      "Save the fund's memo voice: the voice, house rules and examples every memo is written in, by the memo agent and in chat. " +
      'Fields left out are kept; pass an empty string to clear one. Examples must use invented companies and figures. Show the ' +
      'person the text before saving; from a chat it waits for their approval.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        voice: { type: 'string' },
        house_rules: { type: 'string' },
        examples: { type: 'string' },
        learned_from: { type: 'array', items: { type: 'string' }, description: 'Optional: the sample memo ids it was learned from.' },
      },
    },
  },
  {
    name: 'diligence_memo_settings',
    description:
      "How the fund's memos are set up: the design template (the sample memo whose Word design exports copy, with the section " +
      'headings and first-page fields read from it), the first-page exemplar, the sample memos to choose from, the memo schemas ' +
      'and their versions, the fund\'s memo presets, and with a deal its own sections, depth, guidance and analyst persona. ' +
      'With schema, also that schema\'s full YAML.',
    scope: 'read',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        deal: { ...DEAL, description: 'Optional: include this deal\'s memo settings.' },
        schema: { type: 'string', enum: ['rubric', 'qa_library', 'data_room_ingestion', 'research_dossier', 'memo_output', 'style_anchors', 'instructions'] },
      },
    },
  },
  {
    name: 'diligence_memo_settings_save',
    description:
      'Change how memos are set up. Fund-wide: design_template (a sample memo id or name, or "" for the standard layout) and ' +
      'first_page_exemplar. For a deal: its sections (ordered, each { id or title, title, included, depth, cover for a new ' +
      'one }), or use_design_sections to take the design template\'s headings, plus partner_guidance and analyst_persona. ' +
      'Or a memo schema: schema and schema_yaml (validated, saved as a new version). From a chat it waits for approval.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        design_template: { type: 'string', description: 'A sample memo id or name; "" for the standard layout.' },
        first_page_exemplar: { type: 'string', description: 'A sample memo id or name; "" for none.' },
        deal: DEAL,
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, title: { type: 'string' }, included: { type: 'boolean' },
              depth: { type: 'string', enum: ['brief', 'standard', 'detailed', 'comprehensive'] },
              cover: { type: 'string', description: 'For a section the schema does not have: what it covers.' },
            },
            required: ['title'],
          },
        },
        use_design_sections: { type: 'boolean', description: "Set the deal's sections from the design template's headings." },
        partner_guidance: { type: 'string' },
        analyst_persona: { type: 'string' },
        schema: { type: 'string', enum: ['rubric', 'qa_library', 'data_room_ingestion', 'research_dossier', 'memo_output', 'style_anchors', 'instructions'] },
        schema_yaml: { type: 'string' },
        schema_note: { type: 'string', description: 'What changed, for the schema history.' },
      },
    },
  },
  {
    name: 'diligence_add_sample_memo',
    description:
      'Add one of the fund\'s past memos as a sample memo (PDF, Word or Markdown): it teaches the memo voice, and a Word file can ' +
      'be the design template. Its text is extracted for learning. From a chat it waits for approval.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        file: FILE,
        title: { type: 'string' },
        voice: { type: 'string', enum: ['exemplary', 'representative', 'atypical', 'do_not_match_voice'] },
        notes: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'diligence_memo_export',
    description:
      'A deal\'s memo as the partners would circulate it: "docx" (Word, in the fund\'s design template when it has one), ' +
      '"gdoc" (a Google Doc in the deal\'s data-room folder), "pdf" (the Word file converted by Google Drive, keeping its design) ' +
      'or "markdown" (text). Word and PDF come back as a download link that works for a day. Defaults to the latest draft.',
    scope: 'read',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        format: { type: 'string', enum: ['docx', 'gdoc', 'pdf', 'markdown'], description: 'Default docx.' },
        draft_id: { type: 'string', description: 'Optional: a specific draft.' },
      },
      required: ['deal'],
    },
  },
  {
    name: 'diligence_import_memo',
    description:
      'Bring a memo the partners edited in Word back in as a new draft version: its sections are matched by heading and its ' +
      'paragraphs to the draft it was exported from, so unchanged ones keep their citations. Returns the new draft, every ' +
      'change (edited, added, removed) and the review\'s flags. Never finalizes.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        deal: DEAL,
        file: FILE,
        draft_id: { type: 'string', description: 'Optional: the draft it was exported from (default the latest).' },
      },
      required: ['deal', 'file'],
    },
  },
]
