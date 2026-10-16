// Pure metadata for the DOCUMENT TEMPLATE agent tools. NO server imports (the Settings key UI
// lists these). Handlers live in document-tools.ts.
//
// A fund keeps its own LP letter layouts as templates in its database (document_templates), not in
// code: the HTML, its wording, and the shape of the quarter's data are the fund's own. Generating a
// letter is "fill this template from this data" — the assistant gathers the quarter's figures, the
// server fills and prints. The template language is logic-less (lib/document-templates/engine.ts).

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

// Fund-scoped (the `portfolio` dispatch group, like forecasts), and answering to the LP letters
// grant. Not the `lp` group: that one is LP records, which stay read-only from an agent — a
// template is the fund's own layout, not a partner's figures.
const LETTERS = { domain: 'portfolio' as const, accessDomain: 'lp_relations' as const, accessFeature: 'lp_letters' as const }

export const TEMPLATE_LANGUAGE =
  'Template language: {{path}} (escaped), {{helper arg …}}, subexpressions in ( ), {{#each list}}…{{else}}…{{/each}} ' +
  '(@index @first @last, ../ and @root), {{#if}}/{{#unless}}/{{#with}} … {{else}} … {{/…}}, {{! comment }}. No scripts run, ' +
  'and the PDF is printed offline, so styles and images must be inline (data: URIs). Helpers: usd num pct mult date quarter ' +
  'upper | add sub mul div abs round | eq ne gt gte lt lte and or not near | check (cond "message" → returned as a warning) | ' +
  'count sum where join groupSum parts sortBy get | donut swatch. CSS @page rules apply (named landscape pages work).'

export const DOCUMENT_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'document_template_get',
    description:
      "The fund's saved document templates (LP letters and the like). With no name, lists them. With a name, returns the " +
      "template's instructions, its HTML, its sample data, and the data of the last document generated from it — start the " +
      'next quarter from that data, changing only what the new quarter changes. ' + TEMPLATE_LANGUAGE,
    scope: 'read',
    ...LETTERS,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Template name (case-insensitive). Omit to list every template.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'document_template_save',
    description:
      "Create or replace one of the fund's document templates, by name. Stored in the fund's database, not in code. The " +
      'template is checked before it is saved, and test-filled from sample_data when given. ' + TEMPLATE_LANGUAGE,
    scope: 'write',
    ...LETTERS,
    inputSchema: {
      type: 'object',
      required: ['name', 'html'],
      properties: {
        name: { type: 'string', description: 'Template name, e.g. "Northwind Holdings Fund II quarterly letter". Saving under an existing name replaces it.' },
        html: { type: 'string', description: 'The template: a complete HTML document in the template language.' },
        instructions: { type: 'string', description: 'How to fill it: where each data field comes from, and what changes each quarter. Returned by document_template_get.' },
        sample_data: { type: 'object', description: 'An example data object (e.g. the last real quarter), used to test the template and as the shape to follow.' },
        vehicle: { type: 'string', description: 'Optional: the vehicle the template is for.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'document_generate',
    description:
      'Generate a document (PDF) from a saved template and a data object. Returns a download link valid for an hour, and any ' +
      "template checks that failed (e.g. totals that don't tie) — report those to the user. The filled document is kept, so " +
      'the link prints exactly what was generated and the next one can start from this data. Use document_template_get first ' +
      'to see what data the template expects.',
    scope: 'write',
    ...LETTERS,
    inputSchema: {
      type: 'object',
      required: ['template', 'data'],
      properties: {
        template: { type: 'string', description: 'Template name.' },
        data: { type: 'object', description: 'The values to fill it with, in the shape the template expects.' },
        title: { type: 'string', description: 'Document title, used for the file name, e.g. "Northwind Holdings Fund II LP Letter Q1 2026".' },
      },
      additionalProperties: false,
    },
  },
]
