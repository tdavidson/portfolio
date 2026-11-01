# LP requests

LPs reach the fund through its LP portal on the web or by connecting an assistant to the fund's
investor connector. They are not members, and the areas don't apply to them. What they may do is
narrow by design.

## Who

- An **LP account** is linked to one or more of the fund's investors. The primary account for an
  investor is the investor's own.
- An **authorized user** is someone the investor has given access to: an advisor, an accountant, a
  family office. Their access is read-only.

## Seeing

An LP account and its authorized users see what the fund has shared with that investor (statements,
notices, letters, documents, capital account) and nothing about any other investor. The same
holds on the portal and the connector.

## Asking

An LP can't change the fund's records. The primary account MAY ask for a change, and the fund
decides.

- **A record change**: the facts on the investor's record that a subscription document is filled
  from (entity type, formation jurisdiction, address, notice email, signatories) and the investor's
  contact details. Not the fund's own notes on the investor.
- **An authorized user**: read-only access for someone acting for the investor.

An implementation:

- MUST change nothing when a request is made, and MUST validate it then, so a reviewer never sees a
  request that would fail for its shape;
- MUST let only the primary account ask, not an authorized user;
- MUST let the LP see their requests and withdraw one while it's pending;
- MUST apply an approved request through the same operation staff use to make the change directly,
  made as the approver, so every rule on that operation holds;
- MUST require write on `lp_capital` and the investor in scope to approve a record change, and an
  admin to approve an authorized user (giving someone portal access is admin-only when staff do it
  directly, too);
- SHOULD tell the fund when a request arrives, and record every decision in its audit trail.

Vectors for LP requests are planned for 0.2.
