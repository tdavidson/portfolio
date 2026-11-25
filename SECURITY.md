# Security policy

Portfolio holds fund books, LP records and investor contact details, so security reports get
priority over everything else.

## Reporting a vulnerability

Please report privately. Do not open a public issue, discussion or pull request for a vulnerability.

- **Preferred:** GitHub's private reporting. Open the repository's **Security** tab and choose
  **Report a vulnerability**. Only the maintainer sees the report.
- **Or:** write through [hemrock.com/contact](https://www.hemrock.com/contact) with "Security" in
  the subject, and you'll get a private channel to send details.

Include what you found, how to reproduce it (steps, a request, or a short proof of concept), which
version or commit you tested, and what an attacker could reach. Never include real fund, LP or
investor data in a report; invented values with the same shape are enough.

## What to expect

- An acknowledgement within 3 business days.
- An assessment and a plan within 10 business days.
- A fix released as soon as it is ready, credited to you in the CHANGELOG unless you'd rather stay
  anonymous.

Please give us a reasonable chance to release a fix before you disclose anything publicly.

## Scope

In scope: this repository's code, including the web app, the API, the MCP server, the LP portal,
the database migrations and their row-level security, and the scripts in `scripts/`.

Out of scope: a self-hosted deployment's own configuration (its Supabase project, hosting account,
DNS or email provider), denial of service by volume, and reports from automated scanners without a
demonstrated impact.

## Supported versions

Fixes go into the latest release. Self-hosted installs should stay on the latest release; the app's
**Updates** page says when a new one is out.
