# Areas and levels

## Areas

An area is a part of the fund's data that is granted as a unit. Fund Access defines twelve
standard areas, so that two implementations, and the outside firms working across them, mean the
same thing by "accounting" or "tax". An implementation MAY define more; vectors use only these.

| Area | What it holds |
| --- | --- |
| `portfolio` | Companies, their metrics, investments, the review queue |
| `relationships` | Notes and interactions with founders and co-investors |
| `dealflow` | The deal pipeline before diligence |
| `diligence` | Diligence on a deal: documents, checklists, memos |
| `accounting` | The fund's books: journal, periods, statements, bank |
| `management_company` | The management company's own books |
| `lp_capital` | Commitments, capital calls, distributions, partner capital accounts |
| `gp_economics` | Carry, the waterfall and its terms |
| `lp_relations` | LP documents, letters, the LP portal and outreach |
| `compliance` | Filings, the compliance calendar, regulatory records |
| `tax` | K-1s, tax adjustments, the tax package |
| `admin` | Members, access, settings. Admins only |

## Levels

A party holds one of four levels in an area, in this order:

- **none**: the area does not exist for them.
- **read**: they see it.
- **propose**: they see it, and a change they make becomes a proposal for someone with write to
  accept (see [03-decisions.md](03-decisions.md)). Only an area that has proposals honours it; on
  any other area a stored `propose` MUST be treated as `read`. In 0.1 only `accounting` has
  proposals.
- **write**: they change it.

## Relations between areas

Three relations change what a grant means. Each is stated so it can't be quietly assumed.

- **`tax` requires `accounting`.** Every figure in a tax package is a ledger figure. A party who
  can't read accounting MUST get `none` in tax, whatever their tax grant says.
- **`lp_capital` is implied by `accounting`.** The partner capital accounts are the ledger, so a
  party's level in lp_capital is at least their level in accounting. One hop only, and `propose`
  confers `read`, since lp_capital has no proposals.
- **`tax` defaults from `accounting`.** A member with no tax grant and no fund default for tax gets
  their accounting grant (or the fund's accounting default). This keeps a fund that has never set
  tax from locking its own accountants out.

## The fund's switch

Every area has a switch the fund sets: `everyone` (the default), `admins` or `off`.

- **off**: the area is closed to everyone, admins included. Nothing else in the decision can open
  it. An implementation MUST NOT hide an area from its menus while its API still serves it; "hidden"
  is a switch position that means off.
- **admins**: admins keep write; every member gets `none` whatever their grant; an observer keeps
  read.
- **everyone**: grants decide.

## Fund defaults

A fund MAY set a default level per area for members who hold no grant of their own there. A
member's own grant, when present, replaces the default rather than combining with it.

## The level in an area

For one party in one area, the level is decided in this order. The order is the policy.

1. Switch off: `none`.
2. The `admin` area: `write` for an admin, `none` for everyone else.
3. Admin: `write`.
4. Observer: `read`.
5. The area requires another the party can't read: `none`.
6. Switch `admins`: the stored level is `none`. Otherwise it is the party's grant, else the fund's
   default, else the area it defaults from (grant, then default), else `none`.
7. A stored `propose` on an area without proposals is `read`.
8. If another area implies this one, take the higher of the two (with `propose` from the implying
   area counted as `read` here).

`areaLevel` in `engine/decide.ts` is this list as code.
