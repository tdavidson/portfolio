# Not in scope for 0.1

- **Vectors for LP requests, records visibility and engagements.** The behaviour is specified in
  pages 02, 04 and 05; vectors come in 0.2.
- **One person across several funds.** An outside firm's people work for many funds. In 0.1 each
  is a member of each fund separately, and the spec says nothing about how one connection spans
  them. Portfolio links a person's sign-ins on one deployment so one connection switches between
  their funds, acting in each as that fund's member; funds on different deployments are separate
  connections. A provider-side identity the spec can describe is later work.
- **Requests from the fund to a provider**, such as an audit's list of items the client prepares,
  or a tax preparer's questionnaire. Two-way requests are planned.
- **Field-level access.** Areas and entities are the units. Hiding one column of a table from one
  party is not modelled.
- **Approval chains.** One approval with write is enough. Two-person approval, or approval by a
  named role, is not modelled.
- **Time-limited grants on a single area.** An engagement ends all of a member's access on a date;
  ending one area's grant on a date is not modelled.
- **What a credential is.** OAuth, API keys and sessions are the implementation's. Fund Access
  only needs to know which of the three kinds a credential is and its scopes.
