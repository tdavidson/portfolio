# Parties and entities

## Roles

Every party inside the fund has one role.

- **admin**: the fund's own principals. Write in every area that is switched on, every entity,
  and the only role that may make an admin-only change.
- **member**: everyone else who works on the fund, staff and outside firms alike. What a member
  may do is their grants, area by area, and their entity scope.
- **observer**: read-only, everywhere switched on. A board observer, a prospective LP's diligence
  team, a demo. An observer changes nothing and files nothing.

LPs are not members. They sign in to the fund's LP portal or connect an assistant to it, and see
only what is theirs; see [04-lp-requests.md](04-lp-requests.md).

## Outside firms are members

A fund administrator, tax preparer, auditor or compliance vendor is a member whose grants say what
their firm does. Fund Access does not add a role per firm type, because firms vary: one fund's
administrator posts entries, another's only proposes them. Instead an implementation SHOULD offer
presets that set a member's grants in one step, and MUST let staff change any grant afterwards.

| Preset | Grants (areas not listed are none) |
| --- | --- |
| Fund administrator | accounting write, lp_capital write, gp_economics write, lp_relations write, tax write, portfolio read, compliance read |
| Tax preparer | accounting propose, tax write, portfolio read, management_company read, lp_capital read, gp_economics read, compliance read |
| Auditor | accounting propose, portfolio read, management_company read, lp_capital read, gp_economics read, lp_relations read, compliance read, tax read |
| Compliance vendor | compliance write, portfolio read, accounting read, lp_capital read, lp_relations read |

These are the presets Portfolio ships. They are guidance, not conformance: a vector never names a
preset, only grants.

## Engagements

An **engagement** groups the members from one outside firm: its kind (fund administration, tax,
audit, compliance, other) and an optional last day. An implementation that offers engagements:

- MUST end every member's access on the engagement's last day, and MUST let staff end it at once;
- MUST NOT put an admin in an engagement, since an admin's access can't be scoped or ended this way;
- SHOULD keep a log of what the engagement's members did, kept for everyone ever assigned, after
  they leave;
- SHOULD record the engagement on anything its members file ([05-records.md](05-records.md)), so
  the fund knows which firm concluded what after the firm is gone.

Engagements don't change a decision. They change who is a member and until when.

## Entities

An **entity** is one of the fund's vehicles: a fund, an SPV, a parallel fund, the management
company. Entity scope is the second axis, independent of areas.

- An admin sees every entity, including ones created later.
- A member or observer sees `all` (every entity, including ones created later) or the entities
  granted to them. An entity outside a party's scope MUST behave as if it doesn't exist: a call on
  it is refused, and a list doesn't include it.

## Entity caps

Each entity granted to a member MAY carry a **cap**: `read` or `propose`. The cap lowers the
member's area level in that entity and never raises it, so a fund administrator can keep Fund I's
books, propose in Fund II and only read Fund III with one set of area grants.

- The level in an entity is the lower of the area level and the cap.
- A `propose` result on an area without proposals is `read`.
- A party who sees `all`, and every admin, has no caps.

`entityLevel` in `engine/decide.ts` is this as code.
