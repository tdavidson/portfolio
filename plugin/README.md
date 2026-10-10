# Portfolio

See your fund's dashboards inside Claude or ChatGPT, and ask questions about what you are
looking at: the portfolio, a company and its KPIs, the financial statements, and LP capital.

This package is built by your fund's own Portfolio deployment. Its connector points at that
deployment and nowhere else.

## Use it

Connect the connector that comes with this plugin, sign in with your Portfolio account, and
approve the connection. Then ask in plain words:

- "Show me the portfolio."
- "Open the dashboard for Meridian Robotics."
- "Pull up the balance sheet for Fund I, last quarter."
- "Who has funded their capital calls?"
- "Save this as Q3 LP review."
- "Open my Q3 LP review."

A dashboard opens in the conversation. Click a company to drill in, change the period, or
expand it to full screen. Ask a follow-up and the assistant answers from the same figures.

A saved dashboard keeps the view and its filters, never the numbers, so it always opens on
current data. Saved dashboards live in your Portfolio deployment, which is why they are there
in any new conversation and in either assistant.

## What you can see

You see what your Portfolio account can see, and nothing more. The assistant acts as you: if
your access does not include fund accounting or LP capital, those dashboards are refused for
you here exactly as they are in the app. An admin can switch assistant access off for the whole
fund at any time in Settings.

## Data

When you ask for a dashboard or a figure, the assistant requests it from your fund's Portfolio
deployment over an encrypted connection, signed in as you. The figures are sent to the
assistant you are using (Claude or ChatGPT) so it can show and discuss them, under that
provider's terms for your account. This plugin itself stores nothing and contains no
credentials. It does not send your fund's data anywhere else.

## Skills

- **fund-dashboards**: showing, opening and saving the four dashboards.
- **fund-analysis**: answering questions from the fund's records with the right tool and the
  fund's own definitions.
