# Portfolio, by Hemrock — Documentation and deployment

- Project overview at [README](./README.md)
- Detailed feature descriptions at [FEATURES](./FEATURES.md)
- Technical deployment details at [DOCS](./DOCS.md)
- Fund accounting, forecasting and the double-entry reference at [ACCOUNTING](./ACCOUNTING.md)

## Setup & Deployment

Designed as a single-tenant deployment per fund. You control your own data, your own API keys, your own domain, and your own infrastructure. [Taylor Davidson](https://www.hemrock.com) of Hemrock is available to manage the setup, onboard you and your portfolio data, and provide ongoing support, [contact him for details](https://www.hemrock.com/contact).

**In the app or headless.** The web app and chat are two views of the same fund. Everything below can be done in the web app, and most of it can instead be done from Claude, ChatGPT, Claude Code or a script over MCP and the REST API: setting the fund up, adding the team and their access, recording investments and capital, posting entries and closing periods, and reading any of it back. The preformatted PDFs and reports are the same either way. There are three ways through setup:

- **`npm run setup`** does Steps 2 to 7 from a terminal, using the Supabase and Vercel CLIs when you have them (it offers to install them) and printing the manual step for anything it can't do. See [The quick way](#the-quick-way-npm-run-setup).
- **Step by step**, below, in the Supabase and hosting dashboards and the web app.
- **Headless.** After Steps 1 to 5 (the code, the database, the encryption key, the deploy and auth), Steps 6, 7, 9 and 12 can be done from chat or a terminal instead, as [Setting up a fund with Claude, ChatGPT or a script](#setting-up-a-fund-with-claude-chatgpt-or-a-script) describes.

**An AI key is optional.** With no server key, your own Claude or ChatGPT does the AI work over MCP, and work that would run unattended waits until you ask. [AI without a server key](#ai-without-a-server-key) lists what works that way and what still needs a key. Inbound email (Step 8) and any AI key involve secrets or third-party accounts, so they stay in Settings, or for the AI key, in the setup or bootstrap script's environment.

### Required services

| Service | What it does | Free tier |
|---------|-------------|-----------|
| Hosting platform | Runs the Next.js app — choose **Netlify** or **Vercel** or other platfoms | Yes |
| [Supabase](https://supabase.com) | Database (PostgreSQL), authentication, file storage, row-level security | Yes — 500 MB database, 1 GB storage |
| Inbound email provider | Receives portfolio company emails — choose **Postmark** or **Mailgun** | Postmark: 100 emails/mo. Mailgun: 1,000/mo |
| AI provider — optional | AI for the web app's AI buttons, email processing and background jobs. Without one, your own assistant does the AI work over MCP: see [AI without a server key](#ai-without-a-server-key) | See below |
| ↳ [Anthropic](https://console.anthropic.com) | Claude API (default model: `claude-sonnet-4-5`) | Pay-as-you-go |
| ↳ [OpenAI](https://platform.openai.com) | OpenAI API (default model: `gpt-4o`) | Pay-as-you-go |
| ↳ [OpenRouter](https://openrouter.ai) | Unified API for many model providers | Pay-as-you-go |

### Optional services

| Service | What it does | When you need it |
|---------|-------------|-----------------|
| Outbound email provider | Sends quarterly reporting requests and system notifications | If you want to email portfolio companies from the app. Choose **Resend**, **Postmark**, **Mailgun**, or **Gmail**. |
| [Google Cloud](https://console.cloud.google.com) (OAuth) | Google Drive archiving + Gmail sending | If you want to save emails/attachments to Drive or send via Gmail |

### The quick way: `npm run setup`

After cloning and `npm install`, `npm run setup` walks through Steps 2 to 7 in your terminal and does each one itself where it can:

- **Tools.** If the Supabase CLI or the Vercel CLI is missing, it asks whether to install it (Homebrew or Scoop for Supabase, falling back to `npx`; `npm i -g vercel` for Vercel) and signs you in. Say no and that part becomes printed steps and pasted values.
- **Database.** With the Supabase CLI it creates a project or uses one of yours, writes the URL and keys to `.env.local`, links it and runs `supabase db push`. Files under `supabase/pending-deploy/` are not applied.
- **Keys.** It generates `ENCRYPTION_KEY` and `CRON_SECRET` if they are not already set, and never replaces an existing encryption key.
- **Deploy.** With the Vercel CLI it links a project, sets the environment variables, deploys, and deploys again with `NEXT_PUBLIC_SITE_URL` set (it is baked in at build time). On Netlify or another host it lists the variables and asks for your URL.
- **Sign-in settings.** Given a Supabase access token, it sets the site URL, redirect URLs, email confirmations and the signup hook (Step 5); otherwise it prints them.
- **Your fund and AI.** It runs the bootstrap script (Steps 6 and 7) and asks how AI should work here: your own assistant with no server key, or a server key from the environment. See [AI without a server key](#ai-without-a-server-key).

Every question has a flag, so Claude Code or CI can run it without prompts, for example `npm run setup -- --email you@firm.com --fund "Your Fund" --ai assistant --supabase cli --vercel cli --install-clis yes --yes`. The header of `scripts/setup.ts` lists them all. It is safe to re-run: values already in `.env.local` are kept.

### Step-by-step setup guide

Follow these steps in order. Each step builds on the previous one.

### Step 1: Download or clone the repository

Download the source code from GitHub, or clone it to your computer. To keep a copy in your own GitHub account, fork the repository first and clone your fork instead:

```bash
git clone https://github.com/tdavidson/portfolio.git
cd portfolio
npm install
```

### Step 2: Create the Supabase project

Next setup your database.

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **Project Settings > API** and copy these three values (you'll need them in Step 4):
   - Project URL (`NEXT_PUBLIC_SUPABASE_URL`)
   - Anon public key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) or publishable key
   - Service role key (`SUPABASE_SERVICE_ROLE_KEY`) or secret key — keep this secret
3. Run the SQL migrations to create the database schema. Either:
   - Use the Supabase CLI: `supabase db push`
   - Or paste each file in `supabase/migrations/` into the SQL Editor in the Supabase dashboard, in filename order

   Pick one and keep to it. The CLI records what it applied in `supabase_migrations.schema_migrations`; files pasted into the SQL Editor are not recorded there, so a later `supabase db push` would try to run all of them again. Files under `supabase/pending-deploy/` are not migrations yet: each waits for the release named in its header.
4. In **Authentication > Providers**, confirm **Email** is enabled (it is by default)

Don't configure the auth URLs yet — you need your deployed app URL first.

The app is not prebuilt to use other database providers, but it could be edited to use other database providers.

### Step 3: Generate an encryption key

All secrets (API keys, OAuth tokens) are encrypted at rest using AES-256-GCM. Generate a 32-byte hex key:

```bash
openssl rand -hex 32
```

Save this value in your .env.local — it's your `ENCRYPTION_KEY`. If you lose it, all encrypted credentials in the database become unrecoverable.

### Step 4: Deploy the app

Next is to deploy the app to your chosen hosting provider. Netlify and Vercel are prebuilt, but you are not tied to those providers, feel free to deploy to your desired host.

**Option A: Netlify**

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/tdavidson/portfolio)

**Option B: Vercel**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftdavidson%2Fportfolio&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,ENCRYPTION_KEY,NEXT_PUBLIC_APP_URL&envDescription=Required%20environment%20variables%20for%20Portfolio&project-name=portfolio)

After deploying, add these environment variables in your hosting platform's settings:

```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=         # From Step 2
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # From Step 2
SUPABASE_SERVICE_ROLE_KEY=        # From Step 2
ENCRYPTION_KEY=                   # From Step 3
NEXT_PUBLIC_SITE_URL=             # Your deployed URL (e.g. https://reporting.yourfund.com)
NEXT_PUBLIC_APP_URL=              # The same value; the older name, still honoured
```

Trigger a redeploy after adding the variables. `NEXT_PUBLIC_*` variables are baked into the build, so they require a rebuild to take effect.

If you're using a custom domain, configure it in your hosting platform's domain settings and update `NEXT_PUBLIC_SITE_URL` (and `NEXT_PUBLIC_APP_URL`) to match. Optionally set `NEXT_PUBLIC_TERMS_URL` and `NEXT_PUBLIC_PRIVACY_URL` to link your own legal pages from the footer and sign-in pages; unset, no link renders.

### Step 5: Configure Supabase authentication

Now that you have your deployed URL, go back to the Supabase dashboard:

1. **Authentication > URL Configuration**:
   - Set **Site URL** to your deployed URL (e.g. `https://reporting.yourfund.com` or your Netlify or Vercel deployment URLs)
   - Add `https://reporting.yourfund.com/**` to **Redirect URLs** (the `/**` wildcard is important)
2. **Authentication > Email Templates** (optional): Supabase sends auth emails (confirmations, password resets, magic links) using a built-in email service. Copy the templates from `supabase/templates/` into the dashboard if you want them branded. For production, configure a custom SMTP provider in **Project Settings > Auth > SMTP Settings** so emails come from your domain instead of Supabase's default. LP portal invites do not use these templates once an outbound email provider is configured in the app (see the LP onboarding section); a fund with no outbound provider falls back to Supabase's **Invite user** template, which is one template for the whole project and must then link to `/portal/welcome` as `supabase/templates/invite.html` does.
3. **Authentication > Providers > Email**: leave **Confirm email** on. LP portal activation binds a login to an invited account by email address, and that is only safe once the address has been confirmed (see `app/api/portal/activate/route.ts`).
4. **Authentication > Hooks**: Enable the **Before User Created** hook to enforce the signup whitelist at the database level. Select **Postgres Function** and choose `hook_before_user_created`. This prevents direct signups that bypass the API whitelist check.

### Step 6: Allow your first user to sign up

Signups are restricted by an email whitelist. Before anyone can create an account, add their email to the `allowed_signups` table:

1. In the Supabase dashboard, go to **Table Editor > allowed_signups**
2. Insert a row with `email_pattern` set to your email address (e.g. `you@yourfund.com`)
   - To allow everyone at a domain: `*@yourfund.com`
3. Now go to your deployed app at `/auth/signup` and create your account
4. Check your email for a confirmation link and click it

By default the first signup is the admin, with access to the fund-level and technical settings, but the admin can be changed after creation if needed.

> **Headless:** `npm run bootstrap -- --email you@yourfund.com --fund "Your Fund"`, run where your `.env.local` holds the Supabase keys and `ENCRYPTION_KEY`, does this step and Step 7 for you: it adds the address to `allowed_signups`, creates a confirmed account and the fund, turns Agent access on and prints an API key. Or add the address to `allowed_signups` and connect Claude or ChatGPT; with no fund yet, the consent screen asks you to name one. See [Setting up a fund with Claude, ChatGPT or a script](#setting-up-a-fund-with-claude-chatgpt-or-a-script).

### Step 7: Complete the onboarding wizard

After confirming your email and signing in, the app walks you through a short wizard. Only the fund name is required; everything else can be skipped and finished later in Settings.

1. **Your fund** — the fund name (it appears in the app header) and how AI works here. **Add a key** stores an AI provider key: **Claude** (Anthropic, from [console.anthropic.com](https://console.anthropic.com)), **OpenAI** (from [platform.openai.com](https://platform.openai.com)) or **OpenRouter** (from [openrouter.ai](https://openrouter.ai)). **Use my own assistant** runs with no server key: Claude or ChatGPT, connected over MCP, does the AI work, and the step lists what works that way and what needs a key ([AI without a server key](#ai-without-a-server-key)). *Skip — decide later* leaves it open on the getting-started checklist. You can configure several providers and switch between them. Keys are encrypted and stored in your database, not in environment variables.
2. **Products** — what you will run here (portfolio tracking, fund operations, LP reporting, and so on), and the first fund entity. Each product can be switched on or off later from its own section in Settings.
3. **Inbound email** — only when portfolio tracking is on; skippable. See Step 8.
4. **Senders** — only when portfolio tracking is on; skippable. See Step 9.
5. **Google Drive** — optional archiving; skippable. See *Optional: Google Drive* below.

Then continue with [Setting up a new fund](#setting-up-a-new-fund) for the entities, partners, investments and books.

> **Headless:** the `setup_fund` tool does steps 1, 2 and 4 in one call: products, entities, senders, and with `aiMode: "assistant"` the choice to run with no server key. An AI key goes in Settings or the bootstrap script's environment, and inbound email and Google Drive in Settings.

### Step 8: Set up inbound email

This is how portfolio company reports get into the system. Choose one:

**Postmark:**
1. Create a [Postmark](https://postmarkapp.com) account and server
2. In the Postmark dashboard, go to **Inbound** and note your inbound address (e.g. `abc123@inbound.postmarkapp.com`)
3. Set the inbound webhook URL to: `https://your-app.com/api/inbound-email?token=YOUR_TOKEN`
   - `YOUR_TOKEN` is the webhook token shown in the onboarding wizard (also available in Settings)
4. Enter the Postmark inbound address in the onboarding wizard or Settings page

**Mailgun:**
1. Create a [Mailgun](https://www.mailgun.com) account and add a domain for receiving
2. Set up an inbound route to forward to: `https://your-app.com/api/inbound-email/mailgun`
3. In the onboarding wizard or Settings → Inbound email, select Mailgun as your inbound provider and enter your **Mailgun inbound domain** (e.g. `mg.yourdomain.com`) and, optionally, the **webhook signing key** (Mailgun dashboard → Sending → Webhooks), which is used to verify that inbound requests really came from Mailgun

You can also edit the app to use other inbound email parsing services.

### Step 9: Add authorized senders

In **Settings > Authorized Senders**, add the email addresses that your portfolio companies send reports from. Only emails from these addresses will be processed — everything else is silently dropped.

### Step 10: Add companies and metrics

1. Go to **Portfolio** and add your portfolio companies
2. For each company, configure the metrics you want to track (revenue, burn rate, headcount, etc.)
3. Optionally use **Import** to bulk-create companies and metrics from a spreadsheet

### Step 11: Test it

Forward a portfolio company report email to your inbound address. Within a minute you should see:
- The email appear in **Inbound**
- Metrics extracted and visible on the company's profile
- Any low-confidence extractions flagged in **Review**

### Step 12: Invite your colleagues

You can send your colleagues at your fund an email directing them to the signup link. They will not go through the onboarding wizard, and instead get a screen to request access to the fund you created. In your admin login in the settings, you will be able to approve them, and if you have configured the outbound email in Settings, they will get an email noting they have been approved. 

> **Headless:** list colleagues in a `setup_fund` plan instead, each with their role, access preset, entities and an optional end date. They are added to the signup allow-list and sent an invitation email, and need no approval step. Any domain works.

> Many of the inputs on Settings are only for the admin. All setting only available to admins are noted with a lock icon and color.

> By default the app assumes all colleagues use the same email domain. If this is not the case, contact Taylor and we can change this restriction.

### Setting up a new fund

Once the wizard is done, this is the minimum path from an empty deployment to a fund whose capital accounts, statements and forecast all work. The **Getting started** page (`/getting-started`, also linked from Start) tracks the same steps against your own data and links each one; on a new fund, Start suggests setup questions for the Analyst instead of portfolio ones.

1. **Turn on the products you need** — each product has its own section in Settings with a switch to turn it on (*Fund Operations* for the entities, books and LP capital; *LP reporting* for the portal). The wizard's Products step sets the same switches.
2. **Add the entity** — the fund, SPV or vehicle, from **Entities** (*Add vehicle*) or Start. Its chart of accounts is created with it. Skip this if the wizard already created it.
3. **Add the LPs and their commitments** — one at a time under the entity's **Admin** page (*Add LP*), or paste a statement into **LPs → Capital accounts** (download [`lp-import.csv`](public/templates/lp-import.csv) from the import box: Investor, Entity, Vehicle, Commitment, Called, Distributions, NAV). Partners imported this way are added to the entity's accounting with their commitment, so the capital accounts, opening balances and allocation see them.
4. **Load the investments** — add them on **Investments**, or paste a schedule into **Import → Paste Investment Data** (template: [`investments-import.csv`](public/templates/investments-import.csv) — Company, Date, Transaction type, Round, Cost, Shares, Share price, Post-money, Proceeds, Vehicle, Security type). Then put them on the ledger from the entity's status page.
5. **Open the books** — whichever matches where the fund is coming from:
   - **Starting fresh:** record capital calls and distributions as they happen on the entity's **Capital accounts** page. To record a call that has already gone out, paste its register (template: [`capital-call-register.csv`](public/templates/capital-call-register.csv) — Partner, Called, Paid, Paid on).
   - **Moving from a spreadsheet or administrator:** enter each partner's capital as of a cutover date on **Opening balances**.
   - **Moving from QuickBooks or a bank feed:** **Migrate from QuickBooks** (the entity's **Migrate** page) imports the journal; **Bank** imports the transaction history.
6. **Close the first period** — **Periods**: review, reconcile the bank, accrue carry and lock the month.
7. **Make the first forecast** — **Forecast** (turn it on under Settings → Feature visibility) builds a budget and rolling forecast on top of the posted books.

The templates are also served by the app at `/templates/<name>.csv` for signed-in users.

### Setting up a fund with Claude, ChatGPT or a script

You can set up a fund without clicking through the web app. The web app stays available as a view
of the data, but every setup step below can be done from chat (MCP) or from a script (the agent API).

#### 1. Get in

Pick one.

**From Claude or ChatGPT.** Add the connector `https://<your-domain>/api/mcp`. When it sends you to
sign in, use your email (the address must be on the signup allow-list; the first time, add it with
the bootstrap script below or in the `allowed_signups` table). If your account has no fund yet, the
connect screen asks you to name one. Allow, and the fund exists with you as its admin and agent
access on.

**From a terminal, with no web sign-in at all.** On the machine with your `.env.local`:

```sh
npm run bootstrap -- --email you@firm.com --fund "Hemrock Ventures" \
  --products portfolio_reporting,fund_operations,lp_reporting
```

This adds you to the signup allow-list, creates your account and the fund, turns agent access on,
and prints an API key once. To store an AI provider key, put `ANTHROPIC_API_KEY` (or
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`) in the environment first; keys are never taken on the
command line or in a chat. To run with no key, pass `--ai assistant`: it records the choice and
prints what your assistant can do without one. Re-running it reuses the account and fund and mints
a new key. `npm run setup` runs this script for you at its last step, after the database and deploy.

#### 2. Run the setup prompt

In Claude or ChatGPT, pick **Set up this fund** from the connector's prompt menu, or paste this:

```text
Help me set up this fund. First call setup_status and tell me in a few lines where things stand.

Then ask me, one short question at a time, only for what is missing:
1. What we will run here: portfolio tracking, fund books, LP capital and the investor portal, deal flow and diligence, management company books.
2. Our entities: each fund, SPV or management company, with its vintage year.
3. The team: each person's email; whether they are an admin (admins approve deletes, capital calls, distributions, anything sent to LPs, and finalizing K-1s) or a member; which preset fits each member (CFO, fund administrator, tax preparer, auditor, investment team, investor relations); which entities they should see; and an end date for anyone here for one engagement, like an auditor or tax preparer.
4. Who emails us company updates, so those addresses can be authorized.
5. How AI should work here. If there is no server AI key, tell me in a few lines what you can do for me in chat without one and what needs a key (setup_status lists both), and ask whether to run without a key.

Then show me the whole plan as a short list. Once I confirm, apply it with one setup_fund call. Tell me what was created and any warnings, call setup_status again, and walk me through the next open steps: partners and commitments (add_partner), investments (record_investment), opening balances (post_ledger_text) and the first close (close_period).

Never ask me for API keys or passwords. If a step needs one, tell me where to add it in Settings.
```

The assistant reads `setup_status`, asks only for what is missing, shows you the plan and applies
it with one `setup_fund` call. Because a connected assistant's changes wait for approval, you
approve the whole plan once, in the chat or in the app's pending-actions queue.

#### 3. Or do it from a script

The same two tools are on the agent API. An admin's API key applies changes directly.

```sh
KEY=lk_...            # from the bootstrap script, or Settings → API and MCP
URL=https://<your-domain>

# Where setup stands
curl -s $URL/api/agent -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"tool":"setup_status","input":{}}'

# Apply a plan. Safe to re-run: entities match by name, people and senders by email.
curl -s $URL/api/agent -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: setup-1' -d '{
  "tool": "setup_fund",
  "input": {
    "products": ["portfolio_reporting", "fund_operations", "lp_reporting"],
    "entities": [{"name": "Fund I", "kind": "fund", "vintageYear": 2024}],
    "team": [
      {"email": "cfo@firm.com", "preset": "cfo"},
      {"email": "partner@firm.com", "role": "admin"},
      {"email": "audit@auditors.com", "preset": "auditor", "accessEndsOn": "2027-04-30"}
    ],
    "authorizedSenders": [{"email": "founder@portfolio-co.com", "label": "Portfolio Co"}],
    "finish": true
  }
}'
```

#### What setup_fund does

- **Products** decide which areas the fund has. While the fund is new, the list is the full choice;
  once it is set up, products are only added, never switched off (do that in Settings).
- **Entities** are created with a chart of accounts suited to their kind.
- **Team members** are added to the signup allow-list, invited by email if they have no account,
  and given their role, preset, entities and end date. A preset that includes an area the fund
  keeps "Admins only" opens that area to members, with its default for everyone else set to none,
  so only the people granted it gain anything. Admins approve deletes, capital calls, distributions,
  anything sent to LPs and finalizing K-1s, whatever the presets grant.
- **Authorized senders** may email company updates in.
- **`aiMode: "assistant"`** records that the fund runs with no server AI key, so the checklist stops asking for one. See [AI without a server key](#ai-without-a-server-key).

AI provider keys and inbound email (Postmark or Mailgun) involve secrets or third-party accounts,
so they never go through a chat. An AI key is optional:
see [AI without a server key](#ai-without-a-server-key).

**Keys in the environment, so you never open Settings.** Every key a fund can save in Settings can
instead be set as an environment variable on the deployment: in `.env` for a self-hosted install, or
in your host's environment settings (on Vercel, Project → Settings → Environment Variables). The
variables are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`,
`POSTMARK_SERVER_TOKEN`, `MAILGUN_API_KEY`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` (all listed in `.env.example`). A key saved in Settings wins, and the environment
fills in when Settings has none. The variables apply to every fund on the deployment and take effect
after a redeploy.

From chat, `environment_status` tells an admin which credentials are set and where (Settings, the
environment, or missing), with the variable name for each, and never a value. `update_fund_connections`
sets the non-secret half: the AI provider and model, the outbound and inbound email providers, the sender
name and address, the Postmark inbound address, the Mailgun domains and the Google client id. It refuses
anything that looks like a key. So a fund can be connected end to end by adding variables to `.env` and
asking the assistant to do the rest.

### Verify your setup

A built-in setup checklist page helps you confirm your deployment is correctly configured. To enable it, add this environment variable:

```bash
ENABLE_SETUP_PAGE=true
```

Then visit `/setup`. The page itself loads without a session, but its results come from `/api/setup`, which requires you to be **signed in** once the Supabase variables are set — sign in first, or the checks will not load. (Before Supabase is configured it answers anonymously, with only which environment variables are present.) The page checks infrastructure (env vars, database connectivity, core tables), authentication (at least one user), fund configuration, AI provider keys, email setup, file storage, and authorized senders. Each check shows a green, red, or gray icon indicating whether it passed, failed (required), or is missing (optional). Help links point you to the relevant settings or docs.

Once everything looks good, set `ENABLE_SETUP_PAGE=false` or remove the variable entirely to disable the page. When disabled, `/setup` behaves like any other protected route and redirects to `/auth`.

### Optional: Outbound email

To send quarterly reporting requests or system notifications, configure an outbound email provider in **Settings > Outbound Email**:

- **Resend** — enter your API key
- **Postmark** — enter your server token (can reuse the same Postmark account as inbound)
- **Mailgun** — enter your API key and sending domain
- **Gmail** — connect via Google OAuth (requires Google Cloud setup below)

You can set different providers for system emails and portfolio asks.

### Optional: Google Drive

To automatically archive processed emails and attachments:

**Google Drive:**
1. Create a project in the [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Google Drive API** and **Gmail API**
3. Configure an **OAuth consent screen** (External is fine for personal use)
4. Create **OAuth 2.0 credentials** (Web application type)
5. Add `https://your-app.com/api/auth/google/callback` as an authorized redirect URI
6. In the app, go to **Settings**, enter your Google Client ID and Client Secret, connect Google, and use the folder picker to select a Drive folder for archiving

### Fund accounting

Every entity keeps double-entry books from the day it is created — a fund, an SPV, a direct deal, a GP/associate entity, an individual, a management company. There is nothing to turn on to start them: recording an investment, a mark, an exit, a conversion or a capital call posts its entry, so the books are complete whether or not anyone opens the accounting pages. The **Accounting** feature (Settings → Feature visibility, or **Turn on Fund Operations**) decides whether those pages are shown, like Investments and LP capital tracking.

Entities are added under **Entities** (one *Add vehicle* button for every kind). For each one you want to look after:

1. **The chart of accounts is already there** — the fund chart for a fund, SPV or direct vehicle; the GP-entity chart (investment in fund, members' capital, carried interest income) for an *associate*; the management-company chart for a management company. Edit it under the entity's **Admin → Chart of accounts**.
2. **Bring in what came before.** Investment history already in the tracker: the entity's status page says how many items have not reached the ledger — choose *Put them on the ledger* (or book every entity at once from the entity index). It adopts entries already there and posts the missing ones on their own dates, and can be run again safely. For the rest: **Migrate from QuickBooks** on the status page, import the **bank** history, or take over at a cutover date on **Opening balances** with each LP's capital from their latest statement.
3. **Set the allocation terms** (Admin → Allocation terms): the allocation basis, each partner's commitment, who bears which category, and the carry terms (none, a straight split, or a European waterfall with a preferred return and catch-up). Carry accrues at each close only if terms are set.

Then work the entity: import a bank feed under **Bank** (a row that matches an entry already posted is linked to it rather than booked twice), post entries in the **Journal** — each income or expense entry is allocated to the partners as it posts — and **Close** each month to review, reconcile the bank, true up carry and lock it.

Worth knowing:

- **Reported balances sit beside the books.** An administrator's statement can be pasted as dated positions under **LPs → Capital accounts** and reconciled against the ledger; it never writes a journal entry.
- **Associates and GP entities.** If a GP/associate entity invests in one of your funds, set both halves of its link: which fund it is *GP of*, and which partner on that fund's books it *invests as*. Without both, its members won't appear in the LP report.
- **Forecasting** (Settings → Feature visibility → **Forecast**) adds budgets, rolling forecasts and variance per entity on top of the posted books, without ever writing to them. See FEATURES → Forecast and ACCOUNTING → Forecasts and budgets.

### Optional: Two-factor authentication

Admins and team members can enable TOTP-based two-factor authentication from the Settings page. Once enabled, MFA is enforced on every login. Use any authenticator app (1Password, Authy, Google Authenticator, etc.).

### Optional: Invite team members

In **Settings > Team**, your team members can sign up (if their email matches the whitelist or your fund's email domain) and request to join. Admins approve requests, assign admin or member roles, and choose **which entities** the new member can see — All entities (including ones added later) or specific funds, SPVs and entities; a member must be given at least one, and starts with none otherwise. The **Access** grid under Team sets each member's entities and their domain grants (none / read / read & write for portfolio, accounting, LP capital, GP economics, and so on). Admins always see everything. See FEATURES → Access for what an entity grant hides.

- **Presets.** *Apply a preset* in the Access grid sets every area for a CFO, fund administrator, tax preparer, auditor, investment team member or investor relations in one step (`lib/access/presets.ts`). Cells can still be changed afterwards.
- **Access ends.** A date after which a member can no longer reach the fund, for an auditor or tax preparer here for one engagement. Access stops resolving at that moment; the hourly `/api/cron/access-expiry` job (in `vercel.json`) then removes the membership. On a host without Vercel Cron, schedule that path yourself with `Authorization: Bearer $CRON_SECRET`. Admins never expire.
- **Tax** is its own area, so a tax preparer can work in Tax (adjustments, the tax-year close, K-1s) without write access to the books. It needs read access to accounting.
- **Admin-only changes.** Deleting records, undoing posted entries and reopening periods, capital calls and distributions, anything sent to LPs, finalizing or delivering K-1s and the fund's structure need an admin, in the app, over the API and over MCP alike (`lib/access/admin-only.ts`). A member can propose one from chat for an admin to approve.

All of this can also be set from chat or a script, with `setup_fund`.

### Onboarding LPs to the portal

The LP portal is off until an admin turns on **LPs → LP portal** in Settings → Feature visibility, and an LP can only get in by invitation. The whole flow, from the fund's side:

**Prerequisites.** Email confirmation from Step 5, and an outbound email provider (Settings → Email). Invites are sent from your own address with the platform's LP email template, and the login is created behind the scenes, so nothing about Supabase's project-wide auth emails changes for the LP portal. Without an outbound provider the platform falls back to Supabase's own invite email, which is rate-limited to a few sends an hour and cannot re-invite an address it already knows — enough to try the portal, not to onboard a fund.

**1. Invite.** On **LP Portal → Access**, invite one LP (pick the investor, enter the email) or paste a sheet with investor name, email, and optionally authorized-user emails. Investors are matched by name and created when new; the preview shows exactly what will be sent before anything goes out. Each invite is one email with a link that does not expire. The result says whether the email actually went out; a send that failed is listed with the reason. Inviting an investor with no LP entity yet creates one, named after the investor, so the checklist has somewhere to hang from the first day; the LP can **rename** it from their checklist to the legal name on the subscription document (the fund is told, and a name already taken in the fund is refused).

**2. The LP activates.** The link opens `/portal/welcome`, where the LP confirms their email, receives a six-digit code, enters it, and chooses a password. From then on they sign in at `/auth` like anyone else and are routed to the portal. An LP who lost the email can ask for a new code from the welcome page; you can also **Resend** from the accounts list.

**3. The accounts list** on the same page shows every account linked to your investors: invited, active or disabled, when they last signed in, and whether the last invite was delivered. **Disable** an LP who has left — they and their authorized users lose the portal at their next request and stop receiving LP emails; **Re-enable** puts an activated account back, or a never-activated one back to invited. Removing the link detaches the account from that investor without touching the account itself.

**Authorized users** — an LP's advisor or accountant — are invited the same way, against a specific investor, and get read-only access to that investor's data. The LP sees and can revoke them from their own portal Settings; the fund can from Access. They are Cc'd on every email to their LP. They can also upload onboarding documents for the LP they act for — an accountant sending the W-9, counsel sending the executed signature page — and the fund sees who did: the file list, the entity's History and the notification email all name the uploader and say when it was an authorized user rather than the LP.

**4. Onboarding documents.** Signing happens outside the platform. What the platform keeps is the record: on **LP Portal → Onboarding**, tick the documents your fund requires of every LP entity (subscription agreement, LPA signature page, W-9 / W-8, identity and entity KYC, beneficial ownership, accreditation, wire instructions, side letter, electronic K-1 delivery consent). Every entity then shows where it stands on each: outstanding, awaiting review, verified, sent back, or waived. An entity that should not be on the checklist at all — the GP entity, a carry vehicle, a partner whose paperwork lives elsewhere — is **excluded** from its Profile panel; the GP is excluded by default, and an excluded entity gets no request, no reminder, and no row, listed at the foot of the section instead. LPs upload executed copies from the **Onboarding** tab of their portal (PDF, image or Word, 25 MB max); each upload lands in your LP inbox and here as *awaiting review*. Review it, then **Verify** (optionally with an expiry date — a W-8 lapses after three calendar years, and an expired item counts as outstanding again), **Send back** with a note the LP sees, or **Waive** it for that entity. You can also upload on an LP's behalf, which marks the item verified. An LP can **remove** their own upload until you have looked at it; once reviewed it stays. **Request outstanding** emails each LP a list of what their entities still owe, with a link to upload, after a preview of every address.

Two items are not "look at the file and verify". **Wire instructions** are paid against, so verifying them requires a callback: the verify dialog asks who you spoke to, the number you called and the date, and refuses without them; the callback is written into the item's note and its History. Call a number you already hold for the investor, never one printed on the file. The batch sorter files wire instructions as *awaiting review*, not verified, for the same reason; and when an LP replaces wire instructions you had verified, the item drops back to awaiting review and the fund's admins get a separate email and inbox message saying so — the shape of every wire-fraud attempt is a changed bank account, so it is never a routine "new upload". **Electronic K-1 delivery consent** has nothing to upload: the LP reads the disclosure on their checklist and consents there, which records the consent (disclosure text verbatim, when, from where) on the vehicle's Tax page and marks the item verified in one step. Only the investor's own account can consent — an authorized user sees the disclosure and a note that it is not theirs to give. A consent you hold on paper is recorded on the Tax page and the item verified by hand with a note.

**Sorting a batch.** Back from a closing with a folder of countersigned subscription agreements, W-9s and KYC scans? Drop them all on **Sort a batch** in the Onboarding section. Each file is read on your own server — PDF text, Word text, or OCR for a photo or scan — and the platform proposes what it is and whose it is: the kind from the document's own title and phrasing, the entity by fuzzy-matching the subscriber name against your entities and investors, plus the facts it found (signature date, stated commitment, and for a tax form the form type and the last four digits of the TIN). A stated commitment that disagrees with the one on file is flagged. Nothing is sent to a model provider and the text is not kept; a low-confidence guess is left blank rather than filed, and a photo the OCR cannot read is marked for sorting by hand. You confirm each row — correcting the entity or kind where needed — and the confirmed files are recorded as verified items; discarded uploads are deleted. A large batch is read a few files at a time so nothing times out; the whole folder still lands on one review table. A tax form's facts are recorded in the same step (see below).

A document uploaded this way is scoped to that investor alone: it shows in their portal's Onboarding and Documents tabs and nobody else's. It is not text-indexed for the portal Analyst, on purpose. Tax forms are the one item with facts to record beyond the file, and they are recorded where the form is verified. Verifying a W-9 or W-8 — from the batch sorter or from the checklist — opens the form's facts prefilled from the upload: which form, the legal name as it appears on it, TIN type and last four digits, country and treaty claim for a W-8, the signed date and the expiry the rule proposes (three calendar years for a W-8). Confirm, and the partner's tax form is on file, linked to the document, which is what gates K-1 issuance. The vehicle's **Tax** page stays the system of record — it shows each partner's standing and is where a form is amended — but nothing has to be retyped there. Recording needs tax-reporting access: a reviewer without it still verifies the document, and the response says the facts were not recorded. The full taxpayer identification number is never stored outside the signed form; a body carrying one is refused.

**5. Closings.** On a vehicle's **Allocation terms** page, under **Closings**, name each close and date it (First Close, Second Close, Final Close), then admit partners at it — from the closing's own row, or by choosing *Admitted at* when you add a partner. Admission is a record, not a commitment: it changes no amounts. What it does is give the onboarding checklist a deadline. The Onboarding section lists every upcoming closing with how many of its entities are not yet complete, sorts entities by their close, and the LP sees *Needed before Second Close on Oct 15* on their checklist; the request email says the same. An entity in more than one vehicle is due by its earliest close. The closing date is also the fact a management-fee commencement date or a late-closer equalisation would read — neither is built yet, and both should read this rather than a date typed on a commitment event.

**6. The investor record.** Expand an entity in the Onboarding section and open **Profile** to record what a subscription document is filled from: entity type, formation jurisdiction, address, notice email, who signs (name, title, email), and notes for counsel; and on the investor, the relationship contact. The panel says what is still missing. The contact email is also where a **Request outstanding** email goes when the investor has no portal account yet, so nobody is unreachable just because they have not activated.

**What happens around an upload.** Every LP upload is scanned before it is recorded (the same check every other inbound file gets; a hit is deleted and refused with the reason), emailed to the fund's admins, logged in the LP activity log beside their views and downloads, and added to the item's set of files — a KYC packet's several documents sit together rather than replacing one another. Sending an item back emails the LP with your note and a link to their checklist. An entity's **notice email** from its Profile is Cc'd on every email to that investor, onboarding or otherwise. The LP's portal landing page carries a banner with how many items are still needed and by when, so the checklist is not only behind a tab. Uploads that were started and never recorded — a batch sort abandoned mid-review, a browser closed before the file was filed — are swept out of storage by the daily cron once a day old. Every verification, send-back, waiver and reset is in the entity's **History**, with who did it and when. The daily ops digest (Settings → Reminders) carries onboarding too: a closing two weeks, one week and three days out with entities still incomplete, an upload that has waited three days for review, and a verified document ninety and thirty days from expiry.

**What the platform still does not do.** It does not run KYC or AML screening against a provider, does not generate or send subscription documents for signature, and does not compute late-closer equalisation. Those are the next things to add if you need them.

### Install as an app (PWA)

The web app is installable, so partners can keep it on a phone or tablet home screen and open it without browser chrome. Nothing needs configuring — it works on any deployment over HTTPS.

- **iOS/iPadOS (Safari):** Share → **Add to Home Screen**. Safari does not offer an install prompt; this is the only route, and it must be Safari rather than Chrome or Firefox on iOS.
- **Android (Chrome):** an **Install app** prompt appears in the menu or the address bar.
- **Desktop (Chrome/Edge):** an install icon appears at the right of the address bar.

The installed app is branded per fund: the name under the icon is your fund's name, and the mark takes the accent colour from **Settings > Appearance**. Home-screen labels are clipped near twelve characters on both platforms, so a longer fund name is shortened by whole words — "Evergreen Capital Partners" installs as "Evergreen".

The icon is rendered on demand at every size a platform asks for — 152, 167 and 180 for iOS, 192 and 512 for Android, 384 for the Android splash, and 1024 for a desktop dock — so nothing is ever resized to fit. iOS is given one `apple-touch-icon` link per size rather than a single one to scale.

**Navigating on a phone.** Below the tablet breakpoint the sidebar is replaced by a tab bar that floats above the bottom of the screen: the four sections you can see, plus **More**. The four are chosen from the same access rules as the sidebar, so the bar never offers a page your account cannot open, and it fills itself from whatever you do have if some features are off. A dot on **More** means something is waiting behind it — a review queue, a settings item, an available update.

**More** opens a sheet from the bottom of the screen — the edge the button is on — with the sections the bar has no room for, laid out two to a row rather than as a long list, and below them the sub-pages of wherever you currently are: Capital accounts and the ledger while you are in Funds, Investments and Notes while you are in Portfolio. That second part is what the bar itself cannot do. Appearance (system / light / dark) sits at the foot of it.

**What works offline: not much, deliberately.** This app reads live fund data, so a cached balance is a wrong balance. The service worker (`public/sw.js`) stores only the app's static JavaScript and CSS — which are content-hashed, so they cannot go stale — plus a single offline notice page. It never caches a page or an API response. That last point is a privacy decision as much as a correctness one: a cached response would outlive the session that was allowed to see it, on a device that may be shared.

So an installed app opened with no connection shows the offline page, not a stale dashboard. It starts faster on a warm cache, and that is the extent of the benefit.

**Turning it off.** Set `NEXT_PUBLIC_DISABLE_SW=true` and redeploy. This does not merely stop registering the worker — it unregisters any worker already installed, so it is a complete way out without asking users to clear site data. (It is a `NEXT_PUBLIC_*` variable, so it needs a rebuild to take effect.) The install itself is driven by the manifest and cannot be switched off from here; it also does no harm without a worker.

**The LP portal installs separately.** A deployment offers two installable apps, and which one you get depends on the page you install from. Anywhere in the manager app installs "*Your Fund*" and launches at the dashboard. Anywhere under `/portal` installs "*Your Fund* Investor Portal" and launches at the LP overview — so an LP who adds it to their home screen lands on their own statements, not on a manager page they would be redirected off. Send LPs to a `/portal` page (the welcome link works before they have an account) if you want them to install it.

The portal app is scoped to `/portal`: a link out of it opens in the browser rather than inside the installed app, so it can't wander onto the manager surface in a window with no address bar.

The two are told apart on a home screen by the icon: the manager app is the mark on a light tile, the portal is the same mark inverted — knocked out of a filled tile in the fund's colour. One mark between them, because these are two doors into one product rather than two products. A dark tile against a light one is what survives being shrunk to 60px and cropped to a circle; two different drawings would not. The fill is taken from the brand ramp's 700 stop rather than the accent itself, so the knockout stays legible whichever accent a fund picks — several accents are far too light to carry white directly.

**Known gaps.** For a named fund both apps carry the same home-screen *label* (the fund's name); only the icon distinguishes them. The full names differ and install prompts show those. Web push notifications are not wired up on any platform.

### Connecting Claude, ChatGPT and other agents

The deployment is an MCP server and a REST API. Everything an agent does runs against your database, as the person who connected it, under their access. [PARITY.md](./PARITY.md) lists what the web app can do that the tools cannot yet, and why.

**1. Turn on Agent access.** An admin switches on **Settings → Agent access** (off by default). Switching it off later stops every key and every connected assistant at once.

**2. Connect.** Each member then finds their connection details under **Settings → API and MCP**:

| Assistant | How |
|-----------|-----|
| **Claude** (claude.ai, Desktop) | Download **Plugin for Claude**, then in Claude: **Customize → Plugins → Add → Upload plugin**, choose the file, open the plugin's **Connectors** tab and connect — you sign in to your fund and approve. Or add the MCP URL as a custom connector (no skills). |
| **ChatGPT** | **Plugins → + → Add custom MCP server**, paste the MCP URL, create it as a plugin, and sign in when asked. For the skills in the ChatGPT desktop app or Codex, install **Plugin for ChatGPT** as below. |
| **Claude Code** | `claude mcp add --transport http fund https://<your-domain>/api/mcp --header "Authorization: Bearer <API key>"` with a key from Settings → API and MCP, or omit the header and sign in through OAuth when prompted. |
| **Your own agent** | MCP at `https://<your-domain>/api/mcp`, or REST at `/api/agent` (`GET` lists tools, `POST {tool, input}` runs one) with `Authorization: Bearer <API key>`. |

The MCP URL is `https://<your-domain>/api/mcp` (`/api/accounting/mcp` still answers). Claude and ChatGPT sign in with **OAuth 2.1** — dynamic client registration, PKCE, discovery at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` — on your fund's branded consent screen, where the member chooses read, or read and change. Access tokens last an hour and refresh for 30 days. **API keys** (`lk_…`) are per member, read or read & write, and revocable in Settings; a key's scope is a ceiling, and every write is still checked against the member's grant for that area.

**No fund yet?** Someone whose account belongs to no fund can still connect: the consent screen asks them to name one, and Allow creates it with them as its admin and Agent access on (Deny creates nothing; investor portal accounts are refused). That is how a fund is set up entirely from chat; see [Setting up a fund with Claude, ChatGPT or a script](#setting-up-a-fund-with-claude-chatgpt-or-a-script). Admins also get `setup_status` and `setup_fund`, and a **Set up this fund** prompt, for adding products, entities, team members and senders later.

**Getting started once connected.** Ask "What can you do?" — the assistant opens the member's **home dashboard** (`show_home`): what they can open, their saved dashboards, and questions to click. The endpoint also serves **MCP prompts** (`prompts/list`, `prompts/get`) — Set up this fund (admins), Get started, Portfolio review, Company check-in, Process my inbox, Quarter-end review, LP capital status, Draft a forecast, Budget variance — filtered to the member's access; hosts list them in their prompt menu. Settings → API and MCP shows the same *Try asking* list. The catalog behind all three is `lib/agent/getting-started.ts`.

**A tool added since the conversation started.** Claude and ChatGPT fetch the tool list once per conversation and keep it, and the server cannot tell them it changed (it runs stateless, so there is no notification stream). A tool added by a deploy is therefore missing from conversations already open. Two tools that never change cover the gap. `search_tools` searches the current list by keyword (or lists it, or describes named tools in full), filtered to the member's access exactly as the list itself is, and says for each tool whether it reads or writes and whether a write from this connection waits for approval. `call_tool { name, arguments }` then runs any tool on that list through the same checks as calling it directly: the credential's read-only ceiling, the member's grants, admin-only rules, approval for chat writes, the rate limit, the audit trail and `_meta.idempotencyKey`. The server's instructions tell the assistant to use them when a tool it expects is missing. The list's version (`toolListVersion`, a hash of what this member is served) is returned by `initialize`, `tools/list` and `search_tools`, so a client can tell its copy is stale. Both are MCP-only; `/api/agent` lists its tools fresh on every `GET` and runs any of them by name, so it refuses them with that explanation (`lib/mcp-apps/gateway.ts`).

**Documents.** The document tools return a signed link to `/api/agent/reports/<token>` rather than the file: `lp_statement_pdf`, `lp_report_card_pdf`, `fund_performance_pdf`, `financial_statements_pdf`, `schedule_k_pdf` (one partner's K-1 from the vehicle's latest package for a year), `lp_snapshot_pdf` (the investor report for a stored snapshot) and `tax_package_zip`. The token names the member, the fund and the document, is signed with a key derived from `ENCRYPTION_KEY` (rotating it voids every link), and expires after an hour. Opening it re-checks the member's live access the way the document's web route does (accounting for performance, statements and the tax package; tax, the Tax reporting switch and GP economics for a K-1; LP capital, the LP portal switch and every entity for a snapshot report) and then builds the document with the same code (`lib/reports/documents.ts`). Nothing is stored.

**Changes wait for approval.** A change Claude or ChatGPT makes (an OAuth connection) is staged, not applied: the tool returns `{ staged: true, pendingActionId, summary, approveUrl }` and nothing changes until a person approves it under **Approvals** in the app. The person can approve it there or in the chat itself: the assistant shows the change and asks, and calls `approve_action` only on their explicit yes, so a fund can run from chat without opening the app. A script's key cannot approve what it staged: `approve_action` (and `/api/v1`) refuse that, and the assistant gives the person the link instead. `reject_action` withdraws a change. `list_pending_actions` lists what is waiting, including changes other people staged, so an admin can still clear a member's admin-only request from their own chat. Scripts approve through `/api/v1/pending-actions/<id>/approve` and `/reject`. Approving re-checks the approver's own write access to that change. Calls that only make drafts or previews run at once (an upload URL, `portfolio_import_preview`, a draft entry, an allocation with `post: false`, importing or categorizing bank lines, and answering the memo agent's questions with `diligence_stage_next` and `diligence_stage_submit`, which write only into the open memo draft), since a draft still has to be posted or finalized. An API key (`lk_…`) is a script someone wrote on purpose, so its writes apply directly. Admin-only changes (deletes, undoing posted entries, capital calls and distributions, anything sent to LPs, finalizing K-1s and memos, and the fund's structure; the list is `lib/access/admin-only.ts`) can only be approved by an admin, and a member's API key is refused them outright. When a member stages one, the fund's admins get an email (through the fund's outbound email provider, if one is set up) saying what is waiting and from whom. Waiting changes are also flagged at the top of the Portfolio dashboard and the Start page.

**Runs: one approval for a whole fix.** `stage_run` stages several changes as one pending action: a `title`, a `rationale`, the ordered `steps` (`{ tool, input }`, each a write tool the member could call directly; read tools, the approval tools and nested runs are refused) and optional `expected` checks: `account_balance` (an account code's balance on its normal side equals a figure), `type_total` (all accounts of a type) or `trial_balance` (debits equal credits), each for a vehicle and, optionally, as of a date. Every step is checked when the run is staged: its input against the tool's schema, the member's grant for that call, and its entity. Approving runs the steps in order with the approver's access, through each tool's own handler; a `post_drafts` step with no `ids` follows its cursor to the end. The run stops at the first step that fails (or that is held for review) and records where; steps before it stay applied, because each tool commits as it goes. Then the checks are read from the posted ledger and reported as passed or failed. Approvals shows a run's steps and checks before approval and, under *Recent runs*, what each step did, the checks' results and **Undo**. Undo voids the journal entries the run created (`post_entry`, a posted `allocation`) and deletes the investment transactions it recorded (`record_investment`), last step first; it leaves alone an entry in a closed period, one that investment transactions own and half of an investment reversal pair, and voiding a posted entry needs an admin. Other steps (edits, deletes, posting existing drafts, settings) cannot be undone from the app and are listed as such. From chat, `list_runs` shows the same recent runs and `undo_run` undoes one, under the same rules (the credential that staged a run cannot undo it).

**Every change is recorded with its source.** Each change made through MCP or the API is written to the audit trail (the entity's Admin page, and its CSV) with the person, the credential, and the source it came through: `web`, `api` or `mcp`. Changes made in the app are recorded as `web`, and activity-log entries carry the same source as `changeSource`. The audit trail on the Fund status page and the Recent Activity feed under Usage can be filtered by source, and `/api/accounting/audit-log` takes `?source=web|api|mcp` (the CSV too). A write may carry an idempotency key, `_meta.idempotencyKey` on an MCP `tools/call` or an `Idempotency-Key` header on `/api/agent`, and a retry under the same key returns the first result instead of writing twice. A chat assistant's change that waits for approval needs no key: one sent without a key is matched on its tool and input for 24 hours, so the same change asked again, from the same chat or another, returns the first pending action (and says whether it is still waiting or already applied) instead of staging a second. To make an identical change a second time on purpose, send a new key. Calls that only make drafts or previews are not matched this way.

**Putting data in from chat.** Four tools cover the everyday inputs. From Claude or ChatGPT each one is staged for approval like any other change:
- `submit_company_update` takes a portfolio company's update as text, or as up to five files (PDF, Word, Excel, PowerPoint, CSV, text or images): uploaded first with `company_update_upload_url` (up to 25 MB each), or under 3 MB inline. It runs the same pipeline as an emailed update. The update is matched to the company (or to the one named), kept on the company's Updates and its KPIs recorded. Anything uncertain, such as a low-confidence figure, an ambiguous period or an unknown company, goes to the review queue. The submission also shows on the Emails page, where it can be reprocessed or rerouted. Most updates finish within the call. One that takes longer than about 45 seconds comes back with a job, and keeps processing; `company_update_status` reads the result once it's done.
- `record_metric_value` sets one KPI for a period ("MRR for Q3 2026"), replacing any value already there.
- `create_company` adds a company, seeded with the fund's default metrics. A member must name one of their entities.
- `add_company_note` adds an internal note as the person connected, with @mentions notifying team members as they do in the app.

They call the same code as the app's own pages, under the same access checks.

**Reading the books from chat comes in pages.** `list_journal` and `list_bank_transactions` return `{ rows, total, hasMore, nextCursor }`, newest first; while `hasMore` is true the list is incomplete, and passing `cursor: nextCursor` returns the next page. Both take `start` and `end` dates; the bank list also takes a `status`. `export_ledger_text` exports every non-void entry, optionally between `start` and `end` (or `asOf`). A ledger too large for one reply comes back with `truncated: true`, the counts and a `cursor` to continue from. No tool drops rows without saying so.

**Correcting an investment from chat.** `record_investment` adds a transaction; `update_investment` and `delete_investment` correct one, by the id `list_investments` returns. An update changes only the fields passed, for example turning a mark into an FX revaluation (`valuation_change_source: "fx"` with the rates and the position's own-currency value). Both run the company page's edit and delete (`lib/portfolio/transaction-edit.ts`): the journal entry is retracted first and re-derived from the new values, and the same refusals apply (a closed period, a row the fund register owns, a SAFE or note a conversion depends on).

**Deals and diligence from chat.** Deal flow and the deal room can be worked end to end from Claude, ChatGPT or `/api/agent`. Each write is staged for approval from a chat, like any other change:
- Inbound deals: `deals_create_inbound` (a pitch heard outside the inbox, with the deck if there is one, uploaded with `deals_deck_upload_url`; it is scored against the thesis like an emailed pitch, or saved unanalysed when the fund has no AI key), `deals_update_inbound` (status, entity, assignee, and the analysis or web research your assistant wrote), `deals_research_inbound` (queue web research) and `deals_promote_to_diligence` (open a deal room linked to the deal).
- The deal room: `diligence_create_deal` and `diligence_update_deal`, `diligence_add_checklist_item` and `diligence_update_checklist_item` (status, notes, a fact the partner learned), `diligence_add_note`, `diligence_add_documents` (files uploaded with `diligence_document_upload_url`, up to 100 MB each, or up to five of 3 MB inline), `diligence_resolve_attention`, `diligence_document_text` (a data-room document's text, for answering questions yourself), `diligence_run_agent` (analyze the data room, research, draft or score, within the fund's cost caps; with no AI key, your assistant runs the stage with `diligence_stage_next`, `diligence_stage_read` and `diligence_stage_submit`), `diligence_write_memo` (rewrite a paragraph, or write in a section such as the recommendation) and `diligence_finalize_memo`.

A member can only act on deals on their own entities, and must put a new deal on one of them. Finalizing a memo is admin-only, so a member's request waits for an admin. The tools and the Deals and Diligence pages call the same functions (`lib/deals/service.ts`, `lib/diligence/service.ts`, `lib/memo-agent/enqueue.ts`). `diligence_deal_detail` reports the memo agent's latest job (running, finished or failed, with its error), so a chat can follow what `diligence_run_agent` started.

**The LP register from chat.** `lp_create_investor`, `lp_update_investor` (rename, or the investor it rolls up to), `lp_create_entity` and `lp_update_entity` (rename, or move to another investor) need an admin, as the Investors page does. `lp_update_profile` (an entity's subscription facts and the investor's contact) and `lp_correct_commitment` (a recorded event's date, amount or memo; an amount change needs a reason) need write on LP capital. `lp_record_commitment` (an increase, decrease or transfer after admission) is admin-only, like adding a commitment in the app; a new partner is `add_partner`. `lp_commitments` lists the history with the ids the corrections take. Each is limited to the member's own LPs and calls the function the web routes call (`lib/lps/records.ts`); commitment changes go to the audit trail with their reason.

**LP onboarding and outreach from chat.** An admin can run the LP Portal page from a conversation. `lp_portal_accounts` lists who can sign in (status, last sign-in, last invite and whether it failed) and whether the portal and the investor connector are on. `lp_portal_invite` invites one LP; `lp_portal_invite_bulk` invites many. Its default mode, `missing`, finds every LP investor in the fund, or in the `vehicles` named, that has a contact email on file (or a single notice email across its entities) and no portal account yet, and lists the ones it skips for want of an address (add one with `lp_update_profile`). Its `rows` mode takes the same sheet as the page's bulk import. `lp_portal_account_status` disables or re-enables an account, `lp_portal_resend_invite` resends an invite, `lp_portal_unlink` removes an account's link to an investor, and `lp_authorized_users`, `lp_authorized_user_add` and `lp_authorized_user_remove` manage advisors' delegated access. `lp_announce` emails a message to chosen LPs or all of them, and `lp_send_item` emails a snapshot, letter or uploaded document to the LPs it is shared with (`lp_send_item_recipients` says who that is), as a portal link, an attachment or both, as the page does: a snapshot attaches each recipient's own statement PDF, covering only their investors, and a letter its PDF. The chat's function does not ship headless Chromium, so it signs a short-lived report link for the admin and downloads each PDF from `/api/agent/reports/<token>`, which does, after re-checking the admin's access (`lib/agent/remote-pdf.ts`). The preview names the attachment. A recipient whose PDF cannot be rendered is not emailed at all, never sent it without the attachment, and the result says why. `lp_portal_settings` turns the LP portal and the investor connector on or off. Nothing goes out unseen: every tool that emails has a preview (`preview: true`, or `commit: false` for the bulk invite, its default) that returns the exact To and Cc addresses and the rendered email, changes nothing, and runs at once; the tool descriptions tell the assistant to show it and get an explicit yes before the real call. Every one of these is admin-only, as on the page (`lib/access/admin-only.ts`): from a chat the real call is staged and an admin approves it in the app or, on their yes, in the chat; a member's key is refused. They call the functions the page's routes call (`lib/lps/portal-access.ts`, `lib/lps/outreach.ts`). **Proposed capital calls** are there too: `lp_proposed_calls` lists them or re-checks one, `lp_proposed_call_propose`, `lp_proposed_call_revise` and `lp_proposed_call_discard` are admin-only, as is `lp_proposed_call_approve`, which issues the call; members with LP capital access can view proposals but not change them, in the app or in chat. Approving from chat does what the app's Approve button does: it issues the call and then publishes each LP's notice to their portal (no email), returning how many were published and reused and any errors. If publishing fails after the call is issued, the result says so and gives the `capitalCallId`; the call stands, and approving the same proposal again retries the notices without issuing it twice. **Publishing an issued call's notices** goes `preview_call_notices` (each partner's figures and a DRAFT PDF link), then `publish_call_notices` with the preview's token, which stages the request. An admin approves it from their chat with `approve_action`, only on their explicit yes, or in the app, where Approvals asks a second time; it returns the published, reused and error counts. Publishing refuses if anything changed since the preview or a blocker remains, and a script's key cannot approve it. Notices are rendered PDFs, so both run on `/api/agent/call-notices/publish`, a route that ships headless Chromium. It takes a signed five-minute token naming the fund, the admin and exactly what to publish (`lib/agent/notice-publish-link.ts`), and checks again that they are still an admin with the access the publish needs. If the deployment sits behind Vercel Deployment Protection (previews, usually), enable *Protection Bypass for Automation*, so these calls from the app to its own routes get through: Vercel then sets `VERCEL_AUTOMATION_BYPASS_SECRET` and the app sends it.

**Deletes, merges and undoing the books (off unless the deployment turns them on).** The admin-only changes that remove or undo records are on the headless surface only when the deployment sets `AGENT_DESTRUCTIVE_ACTIONS=true` in its environment (see `.env.example`). Without it they are not in `tools/list`, `search_tools` or `GET /api/agent`, and any call to one, directly, through `call_tool`, as a `stage_run` step, or approving one staged before the flag was turned off, is refused with a message naming the flag. With it, there are twelve: `delete_company`, `lp_delete_investor`, `lp_delete_entity`, `lp_delete_commitment` (both legs of a transfer, with a reason), `lp_merge_investors`, `diligence_delete_deal` (the deal room and everything in it), `remove_member`, `delete_lp_positions` (one dated set of a tracking vehicle), `unpost_entry`, `reverse_entry` (a dated contra-entry) and `void_entry` (a posted entry only: a draft, alone or in a run, is refused with a pointer to `discard_drafts`), each with a reason, and `merge_vehicles`. Reopening a closed period (`reopen_period`, with a reason) is not one of them: it is always offered, admin-only, and staged for an admin from chat, with the periods it would reopen in the preview, since closing again re-allocates. Every call is staged, from any credential, an admin's own API key included, and only an admin can approve it: in the app under **Approvals**, or from an admin's own chat with `approve_action` on their explicit yes. A key still cannot approve what it staged, and a member's API key is refused them outright (a member's chat can propose one; the admins are emailed). The staged preview says what the change would remove, read when it was staged: an investor's entities and whether any has ledger activity, what a deal room holds, the journal entries a vehicle merge would delete with the source vehicle, and so on; it pins the ids it resolved, so the approval acts on the record that was previewed. Each tool calls the function its web route calls (`lib/companies/delete.ts`, `lib/lps/records.ts`, `lib/diligence/service.ts`, `lib/access/remove-member.ts`, `lib/accounting/positions-delete.ts`, `lib/accounting/journal-state.ts`, `lib/vehicles-merge.ts`), so the same refusals apply on approval (a company with investment transactions, a partner with ledger activity, an entry in a closed period, an admin member). The web routes behind them are admin-only at the API boundary too (`lib/access/admin-only.ts`), including deleting a deal room, removing a member and merging entities (a `PATCH /api/vehicles` with `mergeIntoId`), so the web, the API and MCP agree. The flag and the rules live in `lib/agent/destructive.ts`. **Deleting all fund data is deliberately not offered**, flag or not: it is irreversible and stays a typed confirmation in Settings. LP closings and the LP-snapshot cutover also stay in the app.

**LP letters from chat.** `lp_letters` and `lp_letter` list and read the quarterly letters, and `lp_letter_pdf` returns a one-hour link to a letter's PDF. The assistant can write the letter itself: `lp_create_letter` starts a draft for an entity and quarter, `lp_letter_data` returns the figures the fund's own generator works from, and `lp_write_letter` takes company sections (or a replacement full draft) and rebuilds the portfolio table and the draft around them, as generating does. A section for a company the entity doesn't hold is refused. `lp_share_letter` sets which investors see it in their portal and is admin-only, like the Share button. All of them need LP relations with the **LP letters** switch on, see only the member's own entities' letters, and call the functions the LP Letters pages call (`lib/lp-letters/service.ts`). Investors with the investor connector can get a shared letter's PDF too (`letter_pdf`).

**Letters drafted from the fund's records.** `lp_draft_letter` drafts an entity's quarterly letter from the fund's own data and saves it as a new, unshared draft for review. `lp_letter_brief` is what it is written from. That covers the companies' stored updates for the quarter (an update counts when its period is the quarter, or, with no period, when it arrived during the quarter or within 60 days after), their KPI values and the entity's notes, and figures from the books each labeled gross, net, cost or cash. It adds the write-offs, down rounds and markdowns the transactions show, a computed *Missing information* list, and the instructions. The instructions are the fund's letter template (`template`, by name; default: the fund's default template, else the built-in style guide), any per-letter `guidance`, and the rules every letter keeps: nothing not in the sources, every performance figure labeled gross or net, bad news in plain terms such as "write-off" and "down round", and a closing *Missing information* section. No investor data is read; investor names in update text become `[investor]`. With no `text`, the fund's AI provider writes the draft; with `text`, the assistant's own letter is saved. Either way, and whenever `lp_write_letter` takes a `full_draft`, the result carries review flags for a person to check: numbers not in the sources, unlabeled MOIC/TVPI/DPI/RVPI/IRR, unstated write-offs or down rounds, a missing *Missing information* section, and investor names. Company figures are gross (before fees, expenses and carry); fund TVPI, DPI, RVPI and IRR are net of estimated carry, as on the fund performance page.

**Letter figures are as of the quarter end.** Every letter (generated, previewed or drafted) counts transactions and fund cash flows up to the quarter's last day, or today while the quarter is running, and net IRR runs to that date. A company invested in or exited after it appears as it stood then. A written-off status is the company's current one.

**Final before shared.** A letter is a draft until someone marks it final (*Mark final* on the letter page, or `lp_write_letter` with `mark_final`). Only a final letter can be shared into the LP portal; sharing a draft is refused with the reason, and removing a share always works. Regenerating a letter puts it back to draft.

**Files of any size, without passing them through the chat.** A file sent inside a tool call travels through the model's context, so those inputs stop at a few megabytes. Instead, an upload tool returns a signed Supabase Storage upload URL at a path the server chose (in the deal's, company's, email's or fund's own folder), valid for two hours and one upload, with the exact `PUT` to make, its headers and the size limit. The assistant's own environment (Claude Code, or Claude desktop with access to the person's folder) uploads the file straight to storage with `curl -X PUT -H "Content-Type: <type>" -H "x-upsert: false" --data-binary @"<path>" "<url>"`, and a second tool registers it, so the app takes it in exactly as a browser upload: the same scan, text extraction, classification and row. The assistant is told never to ask for the file in chat, but for its path in a folder (a data-room folder, say). The pairs, each gated like the page's own routes:

| Upload URL | Then | Limit |
|---|---|---|
| `diligence_document_upload_url` | `diligence_add_documents` with `uploaded_files` (scanned and classified; `diligence_run_agent` "analyze" reads it) | 100 MB |
| `company_document_upload_url` | `add_company_document` (virus-scanned, text extracted; over 10 MB a file with text is kept as text, as on the company page) | 20 MB |
| `deals_deck_upload_url` | `deals_create_inbound` with `uploaded_files` (the analyser reads the deck with the pitch) | 10 MB, 10 files |
| `company_update_upload_url` | `submit_company_update` with `uploaded_files` | 25 MB, 5 files |
| `email_attachment_upload_url` | `add_email_attachment`, on an inbound email or an inbound deal's source email | 25 MB |
| `lp_document_upload_url` | `lp_add_document`, which publishes it to the LP portal for every LP, named investors or an entity's investors. Both admin-only. | 50 MB |
| `entity_document_upload_url` | `add_entity_document` (an entity's governing documents) | 25 MB |

Minting a URL changes no record, so it runs at once even from a chat; the register call is the change, and it waits for approval like any other. A deck or update file is uploaded to a staging folder of the fund's and read back when the deal or update is created, then the staged copy is removed (`lib/uploads/signed-upload.ts`).

**The server's model, when the fund has a key.** Two tools ask the deployment's own AI provider to do work the assistant could otherwise do itself. `company_generate_summary` writes and saves a company's AI summary with the same inputs and prompt as the company page's **Summarise** button (`lib/companies/summary.ts`); it is staged from a chat like any change. `portfolio_import_preview` has the model read a pasted spreadsheet or CSV into companies, details and metric history, as the web **AI import** does (`lib/portfolio/ai-import.ts`), and returns that as a proposal matched to existing companies, writing nothing; the assistant shows it and applies it with `create_company`, `record_metric_value` and `record_investment`, in one `stage_run`. Each keeps the web buttons' rate limit (10 per person per 5 minutes). With no server key (in Settings or the environment) both refuse and name the tools to do it in chat instead (`company_save_summary`; the write tools).

**Questions across the data.** For a question no named tool answers, such as "which companies did we invest in during 2024 at a post-money under $20M", "KPIs for every SaaS company over the last four quarters" or "LPs more than 25% unfunded", the assistant can filter, group and total a dataset itself. Each area has one query tool:

| Tool | Datasets | Needs |
|---|---|---|
| `query_portfolio` | `positions`, `companies`, `transactions`, `kpis` | Portfolio (transactions: the Investments switch) |
| `query_lps` | `lp_positions`, `capital_call_lines` | LP capital |
| `query_deals` | `inbound_deals` | Deal flow |
| `query_diligence` | `diligence_deals` | Diligence |
| `query_ledger` | `journal_lines` | Accounting |

A query names a dataset and, optionally, columns, filters (`eq`, `gt`, `between`, `in`, `contains`, `is_null` and so on), a grouping (a date can be grouped by day, month, quarter or year, as `date:quarter`), totals (`count`, `count_distinct`, `sum`, `avg`, `min`, `max`, `median`), a sort and a limit (up to 500 rows). Each dataset's rows come from the named tool behind it (`portfolio_summary`, `list_investments`, `lp_live_report` and so on), so a query sees exactly what that tool would: the member's own entities, carried interest folded as on capital accounts, and the same figures. Nothing is written, and no SQL reaches the database (`lib/agent/query/`).

**Following long-running work.** Some things outlast a tool call. `diligence_run_agent`, `deals_research_inbound` and a slow `submit_company_update` return a `job` with an id (such as `diligence:3f…`), its state (queued, running, done or failed) and the status tool that reads it back: `diligence_job_status`, `deals_research_status` or `company_update_status`. The status tool shows the result when it's done (the research, the KPIs recorded) and the error when it failed, under the same access as the tool that started it. `diligence_job_status` also lists a deal's last five jobs. The assistant is told to say the work has started and check back when asked, rather than poll. A memo-agent job in a fund with no AI key is the exception: it waits for the assistant itself, and the job's `next` says to run it with `diligence_stage_next`.

**What it can reach.** The tool list is filtered to the areas the member can read and the entities they can see, and re-checked on every call. Requests are limited per fund to 300 reads or 60 writes a minute, in batches of up to 20 calls. The Analyst never writes directly — it stages changes for approval — and `/api/v1` (chat, streamed chat over Server-Sent Events, conversations, approving staged actions with an `Idempotency-Key`) takes only OAuth tokens issued for it.

### Data connectors

The headless path covers the other direction too. Beyond the built-in integrations (Affinity, Google Drive, inbound email), data comes in through **connectors**. A connector is a small program you keep in your own repository, usually a private one. It reads an outside system (a general ledger, a fund administrator) and calls this deployment's MCP server with an API key, just as a script would. No connector code lives in this repository, and adding one needs no change here.

[`examples/connector-template`](./examples/connector-template) is the starting point. Copy it into a private repository, add your connectors, and run `npm run sync -- <connector>` on a schedule. Its README covers the contract and how the QuickBooks and Carta connectors are built.

**Setting one up**

1. An admin turns on **Settings → Agent access**.
2. Create an API key for the connector (read & write) under **Settings → API and MCP**, or with `npm run bootstrap`. Give each connector its own key, so you can revoke one without the others.
3. The key's member needs write access to accounting for the entity the connector feeds. Admin rights are not needed: everything a connector imports is a draft.

**How it behaves**

- **Writes apply directly, as drafts.** A connector's writes come from a key, so they are not staged for approval the way an assistant's are. They are recorded in the audit trail with source `mcp`. Outside ledger entries still land as **drafts**, and a person reviews and posts them on the journal page.
- **Outside general ledgers** (QuickBooks, Carta fund admin) go through three steps: `journal_import_accounts`, then `save_journal_mapping`, then `import_journal`. This is the same mapping, review and draft import as **Accounting → QuickBooks**. Each source (`quickbooks`, `carta`) keeps its own account mapping and tags its entries with its own `source_type`.
- **Safe to repeat.** Each entry is keyed by a hash of its content, so re-sending an overlapping window matches what was already imported instead of duplicating it.
- **Review holds stop the run.** If the import's comparison with investment and LP records finds a difference, nothing is written until a person re-runs the import with the review token.

### Investors connecting their own assistant

Investors can connect Claude, ChatGPT or another assistant to their own portal and ask about their investment in plain language. It is a separate connector from the fund's, at `https://<your-domain>/api/portal/mcp`.

**Turning it on.** An admin switches on **Investor connector**, just under **LP portal** in Settings → Feature visibility. It is off by default for every fund, and needs the LP portal on as well. Switching either off cuts every connected assistant off on its next call. It is independent of **Agent access**, which is the fund's own connector.

**Connecting.** The investor finds the address under **Settings → Connect an assistant** in their portal and adds it as a custom connector in their assistant. The assistant then sends them to sign in with their portal account. The consent screen names the fund (an investor in more than one fund on this deployment picks one) and says what the assistant may do. The same card lists the assistants they have connected, with a **Disconnect** button for each.

**What it can do.** It covers the investor's own investment in the one fund they chose and nothing else, the same as their web portal:
- their position, as figures or as a dashboard drawn in the conversation (`show_my_position`, in the fund's colours), and their capital account statement (as a one-hour PDF link);
- letters and documents shared with them;
- capital calls and distributions;
- their messages with the fund;
- the status of their onboarding paperwork.

If they allowed it to act for them, it can also record that they have wired a capital call, and send the fund a message. Uploading onboarding documents stays on the web.

**The same checks and the same record.** The connector and the web portal call the same functions (`lib/portal/service.ts`), so an investor reaches the same data under the same checks either way. Every check is re-made on every call: the investor's account is still active and still invested in the fund, and both switches are still on. Views, downloads, wire acknowledgments and messages all go to the **LP activity** log, marked "Through Claude or ChatGPT" when they came through the connector.

**Kept apart from the fund's connector.** Investors are not fund members, so the connector has its own sign-in audience. An investor's token is refused at `/api/mcp` and `/api/v1`, and a fund member's token is refused at `/api/portal/mcp`. Each connection is bound to one fund when it is made. Requests are limited per investor account to 120 reads or 20 writes a minute.

### Dashboards in Claude and ChatGPT

Members can open the fund's dashboards inside a Claude or ChatGPT conversation, ask questions about what they are looking at, and save a dashboard to reopen later. There are five: the portfolio overview, a company with its KPIs, a vehicle's financial statements, LP capital, and a vehicle's capital calls.

**Charts.** `show_chart` draws figures the assistant already has as a bar chart (comparing categories) or a line chart (one measure over time), with the figures in a table in the full view. It reads no data itself, so it needs no grant: the figures come from tools the member's access already allowed. It takes up to 60 points, each a label and a finite number, and is not saveable, because there is no live query behind it.

It needs **Settings > Agent access** switched on by an admin, which is off by default. Everything below is then per member, under **Settings > API and MCP**.

**How it works.** The app's MCP endpoint (`/api/mcp`) serves the dashboards as [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), an extension both assistants implement: a `show_…` tool returns the figures, and the assistant draws them in a view the endpoint also serves. An assistant that cannot draw the view shows the same figures as text. Each dashboard is the figures of the read tools beside it, so a dashboard and an answer in prose cannot disagree.

**Access is the member's own.** The assistant acts as the person who connected it. A dashboard for an area their access does not include is refused there exactly as it is in the app, and fund performance on the portfolio overview, partners' capital in the statements and the carry line within it are left out for a member without those grants, and a member limited to some entities sees only those. Switching Agent access off stops every connection at once.

**Saved dashboards** are kept in this deployment's database (`saved_dashboards`), because neither assistant keeps a view beyond the conversation it appeared in. What is saved is the view and its filters, never the figures, so a saved dashboard always opens on current data, in either assistant. A member can share one with the fund; a colleague opening it sees their own figures, and a shared dashboard for an area or an entity a colleague cannot see is not listed for them at all. Saving and deleting need a connection approved for changes, which the sign-in offers only to a member who can change something in the fund. A member whose access is read-only throughout can open any dashboard, including shared ones, but cannot save their own.

**Connecting Claude.** Download **Plugin for Claude** from Settings. In Claude, go to **Customize > Plugins > Add > Upload plugin** and select the file, then open the plugin's **Connectors** tab, connect it and sign in. The plugin is the connector plus two skills that tell Claude when to open a dashboard and how to save one. The connector alone (add the MCP URL as a custom connector) also draws the dashboards; the skills make Claude better at choosing them.

**Connecting ChatGPT.** In **Plugins**, choose the plus button, then **Add custom MCP server**, paste the MCP URL from Settings, upload the icon from Settings → API and MCP under **Icon** (your fund's square app mark, `/api/pwa-icon?size=192`), and create it as a plugin. That is all the dashboards need.

**The connector's icon.** ChatGPT takes the icon you upload. The server also declares it in its `initialize` response (`serverInfo.icons`, MCP 2025-11-25) for hosts that read it; Claude currently shows a generic globe for every custom connector and ignores the field, so nothing is needed there until it does. To add the skills in the ChatGPT desktop app or Codex, download **Plugin for ChatGPT**, unzip it to `~/.agents/plugins/portfolio/`, list it in `~/.agents/plugins/marketplace.json`, and restart the app:

```json
{
  "name": "personal",
  "plugins": [
    {
      "name": "portfolio",
      "source": { "source": "local", "path": "./portfolio" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Use the `name` from the unzipped `plugin.json` in place of `portfolio`; it carries this deployment's host, so two funds' plugins do not collide.

**Why the app builds the plugin.** Both assistants require a plugin's connector address to be fixed inside the package, and this app runs at a different address for every fund. So each deployment builds its own package, with its own address in it, at `/api/plugin?target=claude` and `?target=chatgpt`. The package contains no key and no fund data. This is also why there is no listing in either assistant's public directory: a listing needs one address for everyone.

**Changing the view.** The view is plain TypeScript in `lib/mcp-apps/app/`, and the skills are Markdown in `plugin/`. Both are embedded into generated modules that the routes serve, so after editing either, run `npm run mcp:app` and commit the result; a unit test fails if the generated files are out of date. `npm run mcp:check` renders every dashboard inside the official MCP Apps host and checks the protocol exchange (add `-- --shots <dir>` for screenshots).

## Local Development

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
# Fill in your Supabase URL, keys, and encryption key
# (or run `npm run setup -- --vercel skip`, which writes them for you)

# Run Supabase migrations (if using Supabase CLI)
npx supabase db push

# Start the dev server
npm run dev
```

### Tunnel for webhook testing

To receive inbound email webhooks locally, use a tunnel:

```bash
# Using ngrok
ngrok http 3000

# Or using cloudflared
cloudflared tunnel --url http://localhost:3000
```

Then set the tunnel URL as your inbound webhook (e.g. `https://your-tunnel.ngrok.io/api/inbound-email?token=YOUR_TOKEN`).

### Demo mode

**[Try the demo](https://www.hemrock.com/demo)** — explore the platform with sample data, no signup required.

### AI Providers

The platform supports three AI providers, all optional (see [AI without a server key](#ai-without-a-server-key)). Configure one or more in Settings, then select the default provider used for email processing, metric extraction, summaries, and imports.

| Provider | Default Model | Key Required | Notes |
|----------|--------------|-------------|-------|
| **Anthropic** | `claude-sonnet-4-5` | API key from [console.anthropic.com](https://console.anthropic.com) | Best overall quality for analysis and extraction |
| **OpenAI** | `gpt-4o` | API key from [platform.openai.com](https://platform.openai.com) | Strong alternative with broad model selection |
| **OpenRouter** | Configurable | API key from [openrouter.ai](https://openrouter.ai) | Unified access to many model providers through one key |

Each provider has a model selector in Settings — after saving your API key, you can fetch the available models and choose which one to use. The **Analyst** panel also has a model dropdown that shows models from all configured providers, with an "Auto" option that uses the fund's default.

### AI without a server key

A server key is optional. Without one, your own assistant does the AI work: connect Claude, ChatGPT or Claude Code to `https://<your-domain>/api/mcp` (see [Connecting Claude, ChatGPT and other agents](#connecting-claude-chatgpt-and-other-agents)) and ask it. It reads the fund's data with the read tools, does the thinking with its own model, and writes the result back with the write tools, so the server needs no AI key at all. What it cannot replace is the web app's own AI buttons, which have no model of their own to borrow, and work that runs with nobody present, like parsing an email as it arrives.

Choose in the onboarding wizard (**Use my own assistant**), in Settings → AI providers, with `npm run bootstrap -- --ai assistant`, or from chat with `setup_fund { "aiMode": "assistant" }`. Adding a key later switches the fund to the server key; your assistant can still do any of this either way. `setup_status` returns the same list as `ai.worksWithoutKey`, `ai.waitsForYou` and `ai.needsKey`.

**Inbound email without a key.** Updates still arrive and are saved, but nothing reads them as they come in. Each waits on the Emails page as pending until you ask your assistant to **Process my inbox** (a prompt in the connector's menu): it lists them with `inbox_waiting`, reads each with `inbox_read`, records the figures with `record_metric_value` and files it under the company with `inbox_done`. A scanned PDF or image in an update waits the same way: `ocr_waiting` lists them, `ocr_page` shows your assistant each page as an image, and `ocr_save_text` saves what it read, which makes the file searchable like any other. A deal you add from chat (`deals_create_inbound`) is saved unanalysed, and `deals_inbound_detail` hands your assistant the pitch and the fund's thesis to write the analysis back with `deals_update_inbound`.

**The memo agent without a key.** A stage you start (`diligence_run_agent`, or the deal page) waits for your assistant instead of failing, and the deal page says so. Ask your assistant to run it: `diligence_stage_next` carries the deal's queued stages along and lists the requests each would have sent a model, `diligence_stage_read` shows one (its system prompt, its content in pages, and any scanned page as an image), and `diligence_stage_submit` takes the answers. The stage's own code then parses and stores them exactly as it does with a key, and the next stage it queues (synthesis after ingest, review and scoring after the draft) comes back from the same call. The fund's cost caps don't apply, since the spend is your assistant's. A data room is read a document at a time, so a large one takes many rounds.

| Feature | Without a server key | How, or why not |
|---|---|---|
| Questions about the fund (the Analyst) | Yes, from your assistant | Your assistant answers from the same data the Analyst reads, through the read tools. (`portfolio_summary`, `company_detail`, `lp_capital_summary`, `fund_performance`) |
| Drafting a forecast | Yes, from your assistant | Your assistant builds the plan from the forecast tools. (`forecast_create_plan`, `forecast_update_plan`, `forecast_series`) |
| Writing the quarterly LP letter | Yes, from your assistant | Your assistant reads the quarter's figures and writes the draft back. (`lp_create_letter`, `lp_letter_data`, `lp_write_letter`) |
| Learning a letter template from an example | Yes, from your assistant | Your assistant reads the example and saves the template. (`document_template_get`, `document_template_save`) |
| Reading a company update you share in chat | Yes, from your assistant | Your assistant reads the letter, deck or KPI sheet and records each figure. (`company_detail`, `record_metric_value`) |
| Importing companies, investments and LPs from a paste or spreadsheet | Yes, from your assistant | Your assistant parses the rows and records each one. With a server key, portfolio_import_preview has the app's model read them into a proposal first, which your assistant then applies. (`create_company`, `record_metric_value`, `record_investment`, `lp_create_investor`, `lp_record_commitment`) |
| Categorising bank transactions | Yes, from your assistant | Your assistant matches each transaction to the chart of accounts and sets it. (`list_bank_transactions`, `list_accounts`, `set_bank_transaction_account`) |
| Adding and analysing a deal against the thesis | Yes, from your assistant | A deal added from chat is saved unanalysed; your assistant reads it and the thesis and writes the analysis back. (`deals_create_inbound`, `deals_inbound_detail`, `deals_update_inbound`) |
| Editing an investment memo | Yes, from your assistant | Your assistant reads the memo and evidence and rewrites paragraphs. (`diligence_memo`, `diligence_evidence`, `diligence_write_memo`) |
| Investor questions in the LP portal | Yes, from your assistant | An investor connects their own assistant to the portal and asks it. |
| AI buttons in the web app (Analyst panel, Generate letter, AI import, Summarise) | Needs a key | A button in the browser has no model of its own to borrow; without a key, do the same thing from your assistant. |
| Reading emailed company updates | Waits for your assistant | With a key it runs as each email arrives. Without one, each update is saved and waits in an inbox your assistant clears when you ask. (`inbox_waiting`, `inbox_read`, `record_metric_value`, `inbox_done`) |
| Sorting inbound email into deals, diligence and updates | Needs a key | It runs as each email arrives, with nobody present. Without a key, everything is treated as a company update. |
| Reading scanned pages in company updates | Waits for your assistant | With a key a background job reads them. Without one, scans wait until you ask: your assistant looks at each page and saves its text. Text PDFs are read without a model either way. (`ocr_waiting`, `ocr_page`, `ocr_save_text`) |
| The memo agent (ingest, research, draft, score) | Waits for your assistant | With a key its stages run as background jobs. Without one, a stage waits until you ask: your assistant answers each request the stage would have sent a model, and the stage stores the result as it would with a key. (`diligence_run_agent`, `diligence_stage_next`, `diligence_stage_read`, `diligence_stage_submit`) |
| Asking questions of a deal's data room | Yes, from your assistant | Your assistant reads the documents' text and the memo agent's evidence, and answers in chat. (`diligence_list_documents`, `diligence_document_text`, `diligence_evidence`) |
| Saving an AI summary on a company page | Yes, from your assistant | Your assistant reads the company's metrics and updates, writes the summary and saves it to the company. With a server key, company_generate_summary has the app's model write it, as the Summarise button does. (`company_detail`, `company_metrics`, `get_updates`, `company_save_summary`) |
| Web research on inbound deals | Yes, from your assistant | Your assistant searches the web with its own tools and saves the findings and sources to the deal. (`deals_inbound_detail`, `deals_update_inbound`) |

### Feature Visibility

Admins control which features the fund uses, in **Settings → Feature visibility**. Each feature is set to one of three levels:

| Level | Behavior |
|-------|----------|
| **Members** | On; each member reaches it subject to their own access grant |
| **Admins only** | On for admins only, whatever a member's grant says |
| **Off** | Denied on every surface — page, API, Analyst, MCP — to everyone, admins included. Its data is kept |

A feature's level is the ceiling; a member's access grant (Settings → Team → Access) can narrow it, never widen it. A stored "Hidden" from older versions behaves as Off.

Features are grouped into products, and a product's **Turn on** sets all of its features at once (to Admins only, ready to widen):

| Product | Features |
|---------|----------|
| **Portfolio Reporting** | Investments, Imports, Notes, Interactions, Asks |
| **Investment Workflow** | Deals, Diligence |
| **LP Reporting** | LPs, LP capital tracking, LP letters, LP portal, LP activity log |
| **Fund Operations** | Accounting, Management company, Tax reporting, **Forecast**, GP economics, Compliance |

Turning a feature off hides and denies it; it never deletes data, and for accounting it never stops the books being kept — investments and capital calls still post. Separately, **Agent access** (Settings, admin) is the fund-wide switch for MCP, API keys and the Claude and ChatGPT plugins.

### Tech stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 14 (App Router), TypeScript |
| **Styling** | Tailwind CSS, Radix UI primitives (shadcn/ui) |
| **Charts** | Recharts |
| **Database & Auth** | Supabase (PostgreSQL with Row Level Security) |
| **AI** | Anthropic Claude, OpenAI, and/or OpenRouter |
| **File parsing** | mammoth (DOCX), xlsx (spreadsheets), jszip (PPTX), PDF and images handled natively by the AI provider |
| **Icons** | Lucide React |

### Security

- Two-factor authentication (TOTP)
- Envelope encryption (AES-256-GCM) for all stored secrets
- Email whitelist for signups
- Rate limiting on auth and AI endpoints
- Timing-safe webhook verification
- Security headers
- Row Level Security on all database tables
- One set of access rules for the web app, the API and MCP, with admin-only changes enforced on every surface
- Changes from a connected assistant are staged until a person approves them
- An append-only audit trail that records who made each change and its source (web, API or MCP)

### Updates

The app includes a built-in update checker. It periodically compares your installed version against the latest [GitHub release](https://github.com/tdavidson/portfolio/releases). When a newer version is available, admins will see an **Updates** link in the sidebar. Click it to see the current version, the latest version, release notes, and a link to the GitHub release.

Non-admin users do not see the update indicator. The check runs against the public GitHub Releases API (no authentication required) and is cached for one hour.

Each installation has a unique **Installation ID** — a UUID automatically generated in your database when you run migrations. This ID is specific to your deployment and is displayed at the bottom of the Updates page. It lays the groundwork for future license key validation and is not shared externally.

## Contact

Built by Taylor Davidson at [Hemrock](https://www.hemrock.com).

For setup assistance, support, or questions: [hemrock.com/contact](https://www.hemrock.com/contact).

For bug reports and feature requests: [GitHub Issues](https://github.com/tdavidson/portfolio/issues).
