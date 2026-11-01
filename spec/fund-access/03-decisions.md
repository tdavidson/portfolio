# Decisions

A **call** is one request: an action (`read`, `write` or `file_record`), an area, optionally an
entity, and the credential it came through. The decision is one of five outcomes.

| Outcome | Meaning |
| --- | --- |
| `allow` | It happens now. |
| `propose` | A proposal is saved, marked as the party's, for someone with write to accept or reject. Nothing else changes. |
| `stage` | The change waits for the party (or anyone with write) to approve it. Nothing has changed yet. |
| `stage_for_admin` | The change waits for an admin to approve it. |
| `refuse` | Nothing happens, with a reason. |

## Credentials

- **person**: someone signed in, acting directly. A person always has read and write scope.
- **assistant**: an assistant acting for a person, typically over MCP with OAuth. Its scopes are
  what the person granted when they connected it.
- **script**: an API key. Its scopes are what it was issued with. A script has no one to ask, so
  nothing it does can be staged.

A credential never exceeds its party. An admin's read-only key is read-only.

## Call flags

A write MAY carry three flags, set by the implementation for that operation, not by the caller.

- **proposable**: a party at `propose` makes a proposal instead. Posting a journal entry is
  proposable; closing a period is not.
- **adminOnly**: only an admin may make it. Removing a member, changing waterfall terms, giving
  someone portal access.
- **direct**: it changes nothing anyone relies on (an upload URL, a preview, a draft), so it is not
  staged even from an assistant.

## The decision, in order

The first step that settles the call settles it.

1. **Credential scope.** A write or a record filing through a credential without write scope:
   refuse (`credential_read_only`).
2. **Entity scope.** A call on an entity outside the party's scope: refuse
   (`entity_not_visible`).
3. **Level.** The party's level in the area ([01](01-areas-and-levels.md)), lowered by the entity's
   cap ([02](02-parties-and-entities.md)).
4. **Read.** Allow at `read` or above; otherwise refuse (`no_access`).
5. **File a record.** An observer: refuse (`observer`). No entity, from a party who doesn't see
   every entity: refuse (`fund_wide_record`). Otherwise allow at `read` or above, and refuse
   (`no_access`) below. A filing is never staged. See [05-records.md](05-records.md).
6. **Write.**
   1. An observer: refuse (`observer`).
   2. At `propose`: a proposable write is `propose`; any other is refused (`not_proposable`). A
      proposal is never staged, whatever the credential: staging it would have the approver run it
      as themselves and make the change outright, which is exactly what the proposer could not do.
   3. Below `write`: refuse (`no_access`).
   4. Admin-only, from a party who isn't an admin: from an assistant, `stage_for_admin` (the member
      has asked; an admin decides); from a person or a script, refuse (`admin_only`).
   5. From an assistant, unless the write is `direct`: `stage`.
   6. Otherwise: allow.

`decide` in `engine/decide.ts` is this list as code. The reason codes are for people and logs;
conformance is on the outcome ([07](07-conformance.md)).

## A call with no entity

A call with no entity is a call on the fund as a whole, and entity scope doesn't apply to it,
except for a record filing (step 5). An implementation MAY treat a call with no entity from a party
who sees exactly one entity as a call on that entity; vectors don't depend on either reading.

## Approving

Approving a staged change or accepting a proposal is itself a decision, made for the approver: the
approver MUST hold write in the change's area and entity, and an admin-only change MUST be approved
by an admin. The change is then made as the approver. An approval never inherits the original
party's level.

## Same party, same call, same outcome

The outcome depends on the party, the call and the credential kind. It MUST NOT depend on which
door the call came through. An implementation that has a web route and a tool for the same
operation MUST give the same outcome for both, and its assistant and API tool lists MUST show each
party the same tools.
