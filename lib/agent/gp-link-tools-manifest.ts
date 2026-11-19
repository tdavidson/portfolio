// Pure metadata for the GP LINK tools: which GP or associate entity is the GP of a vehicle, and as
// which of that vehicle's partners it holds its interest. NO server imports (the Settings key UI
// lists these). Handlers live in gp-link-tools.ts.
//
// The close reads these links to accrue an associate's share of each vehicle it is GP of, so they
// belong to the SERVED vehicle's books and bind as ledger tools, gated like the route (accounting).
//
//   gp_links       → api/accounting/vehicle-gp-links (GET)
//   set_gp_link    → api/accounting/vehicle-gp-links (POST); staged for assistant credentials
//   remove_gp_link → api/accounting/vehicle-gp-links (DELETE); admin-only, as the route is

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

export const GP_LINK_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'gp_links',
    description:
      "A vehicle's GP links: each GP or associate entity that is GP of it, and as which of its partners that entity holds its " +
      'interest (carry and capital). A link with no partner contributes nothing at close. Also lists the entities that can be ' +
      "linked and the vehicle's partners to pick from.",
    scope: 'read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_gp_link',
    description:
      'Make a GP or associate entity the GP of this vehicle, or set or change the partner it appears as (remove_gp_link ' +
      'removes one). The close uses these links to accrue the associate\'s share of every vehicle it is GP of. The partner ' +
      'must already be a partner of this vehicle (add_partner first if not). Staged for approval from the assistant.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['gp_vehicle'],
      properties: {
        gp_vehicle: { type: 'string', description: 'The GP or associate entity (name or id).' },
        partner: { type: 'string', description: "Which of this vehicle's partners it appears as (name or id, from gp_links)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_gp_link',
    description:
      'Remove the link that makes a GP or associate entity the GP of this vehicle, so the close stops accruing its share. ' +
      'Admin-only, as on the entity settings screen. Staged for approval from the assistant.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['gp_vehicle'],
      properties: { gp_vehicle: { type: 'string', description: 'The GP or associate entity (name or id).' } },
      additionalProperties: false,
    },
  },
]
