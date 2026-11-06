// Pure metadata for the LP LETTER tools. NO server imports (the Settings key UI lists these).
// Handlers live in letter-tools.ts; the functions they call in lib/lp-letters/service.ts, the same
// ones the LP Letters pages call.
//
// Access is the letters pages' own: LP relations, under the LP letters switch. A letter belongs to
// one entity, so a member scoped to some entities sees and writes only theirs.
//
// The assistant in the conversation can be the writer: lp_letter_data gives it the figures the
// fund's own generator works from, and lp_write_letter takes its company sections and rebuilds the
// table and the full draft around them, as generation does.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const LETTER = { type: 'string', description: 'The letter id, from lp_letters.' }
const PERIOD = {
  type: 'object' as const,
  properties: {
    vehicle: { type: 'string', description: 'The entity (portfolio_group) the letter is for.' },
    year: { type: 'integer' },
    quarter: { type: 'integer', minimum: 1, maximum: 4 },
    year_end: { type: 'boolean', description: 'Also the year-end letter.' },
    template: { type: 'string', description: "The fund's letter template (name) that sets the structure and style. Default: the fund's default template." },
    guidance: { type: 'string', description: 'Extra guidance for this letter, e.g. what to open with. Kept with the letter.' },
    partner_notes: { type: 'string', description: "The partners' own notes for this letter: facts and emphasis. A source like any other; kept with the letter." },
    sources: {
      type: 'array',
      description: 'Documents to write from, as text (a market report, a board deck). Kept with the letter; never shown to investors.',
      items: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
    },
  } as Record<string, any>,
  required: ['vehicle', 'year', 'quarter'],
}
const base = { domain: 'lp' as const, accessDomain: 'lp_relations' as const, accessFeature: 'lp_letters' as const }

export const LETTER_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'lp_letters',
    description: 'The fund\'s quarterly LP letters, newest first: period, entity and status (generating, draft, or final once reviewed).',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { vehicle: { type: 'string', description: 'Only this entity\'s letters.' } } },
  },
  {
    name: 'lp_letter',
    description:
      'One LP letter: its sections in order (each with its id, heading and text, and a company_id for a company\'s), its full ' +
      'text, its internal notes and its prompt. Edit a section with lp_write_letter by its section_id.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_letter_data',
    description:
      'The figures a letter is written from: each company the entity holds (invested, fair value, MOIC, status, stage), ' +
      'its reported metrics for the quarter, and the fund totals. The same data the fund\'s letter generator uses. ' +
      'Use it to write the company sections for lp_write_letter.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_letter_skill',
    description:
      'The lp-quarterly-letter skill, as this app holds it: SKILL.md (the structure, sizing, voice rules and review checklist ' +
      'every LP letter follows) and its references, voice.md and examples.md. Where the fund has saved its own voice (its ' +
      'letter template), that replaces the general voice and examples. Read it before writing a letter from lp_letter_brief; ' +
      'it is always the current version, so prefer it to a copy you hold.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { template: PERIOD.properties.template } },
  },
  {
    name: 'lp_letter_brief',
    description:
      'Everything a quarterly LP letter may be written from, for an entity and quarter, as of the quarter end: each company\'s ' +
      'stored updates, KPI values and team notes for the quarter, its figures from the books labeled gross, net, cost or cash, ' +
      'the write-offs, down rounds and markdowns the books show, and what is missing. Its instructions are the fund\'s letter ' +
      'voice plus the rules every letter keeps. No LP or investor-level data is included. Follow the instructions exactly ' +
      'when writing, and the lp-quarterly-letter skill (read it with lp_letter_skill); then save with lp_draft_letter (text).',
    scope: 'read',
    ...base,
    inputSchema: PERIOD,
  },
  {
    name: 'lp_draft_letter',
    description:
      'Draft the quarterly LP letter for an entity and quarter, in the fund\'s letter template, as a NEW unshared draft for a person to review. With no ' +
      'text, the fund\'s own AI writes it from lp_letter_brief\'s sources; with text, saves the letter you wrote from that ' +
      'brief. Returns the draft and review flags (numbers not in the sources, performance figures not labeled gross or net, ' +
      'events not stated, a missing "Missing information" section). Show the user the draft and every flag. Never marks a ' +
      'letter final or shares it.',
    scope: 'write',
    ...base,
    inputSchema: {
      ...PERIOD,
      properties: {
        ...PERIOD.properties,
        text: { type: 'string', description: 'The letter you wrote from lp_letter_brief. Omit to have the fund\'s AI write it.' },
      },
    },
  },
  {
    name: 'lp_letter_pdf',
    description:
      'A download link to an LP letter as a PDF, the same document LPs receive. The link works for an hour; give it to the user ' +
      'as a link, and call again rather than re-sharing an old one.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_create_letter',
    description: 'Start a draft LP letter for an entity and quarter. Then write it with lp_write_letter, or generate it on the LP Letters page.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'The entity (portfolio_group) the letter is for.' },
        year: { type: 'integer' },
        quarter: { type: 'integer', minimum: 1, maximum: 4 },
        year_end: { type: 'boolean', description: 'Also the year-end letter.' },
        prompt: { type: 'string', description: 'Guidance kept with the letter for generating it.' },
      },
      required: ['vehicle', 'year', 'quarter'],
    },
  },
  {
    name: 'lp_write_letter',
    description:
      'Write an LP letter. sections replaces those sections\' text: name each by section_id (from lp_letter), or a company\'s by ' +
      'company_id (ids from lp_letter_data), which adds its section if the letter has none. full_draft replaces the whole text ' +
      'instead, with a "## " line opening each section; each section keeps the sources it was written from. Writes come back ' +
      'with review flags against the letter\'s sources, each naming its section; show them to the user. Show the user the text ' +
      'before calling.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        letter_id: LETTER,
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              section_id: { type: 'string', description: 'The section, from lp_letter.' },
              company_id: { type: 'string', description: 'Or a company, for its section.' },
              heading: { type: 'string', description: 'A new heading for the section (section_id only).' },
              text: { type: 'string', description: 'The section\'s text, without its heading.' },
              narrative: { type: 'string', description: 'The same as text (older name).' },
            },
          },
        },
        full_draft: { type: 'string' },
        mark_final: { type: 'boolean', description: 'Mark the letter final: a person has reviewed it. Only a final letter can be shared.' },
      },
      required: ['letter_id'],
    },
  },
  {
    name: 'lp_share_letter',
    description:
      'Set which investors see an LP letter in their portal. The list replaces the current one; an empty list unshares it. ' +
      'Investors are names or ids. Only a final letter (lp_write_letter mark_final) can be shared. Admin only.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: { letter_id: LETTER, investors: { type: 'array', items: { type: 'string' } } },
      required: ['letter_id', 'investors'],
    },
  },
]
