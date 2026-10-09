# Portfolio, by Hemrock — Documentation and deployment

- Project overview at [README](./README.md)
- Detailed feature descriptions at [FEATURES](./FEATURES.md)
- Technical deployment details at [DOCS](./DOCS.md)
- Fund accounting setup and double-entry reference at [ACCOUNTING](./ACCOUNTING.md)

## Setup & Deployment

Designed as a single-tenant deployment per fund. You control your own data, your own API keys, your own domain, and your own infrastructure. [Taylor Davidson](https://www.hemrock.com) of Hemrock is available to manage the setup, onboard you and your portfolio data, and provide ongoing support, [contact him for details](https://www.hemrock.com/contact).

### Required services

| Service | What it does | Free tier |
|---------|-------------|-----------|
| Hosting platform | Runs the Next.js app — choose **Netlify** or **Vercel** or other platfoms | Yes |
| [Supabase](https://supabase.com) | Database (PostgreSQL), authentication, file storage, row-level security | Yes — 500 MB database, 1 GB storage |
| Inbound email provider | Receives portfolio company emails — choose **Postmark** or **Mailgun** | Postmark: 100 emails/mo. Mailgun: 1,000/mo |
| AI provider — at least one | AI for email processing, metric extraction, and summaries | See below |
| ↳ [Anthropic](https://console.anthropic.com) | Claude API (default model: `claude-sonnet-4-5`) | Pay-as-you-go |
| ↳ [OpenAI](https://platform.openai.com) | OpenAI API (default model: `gpt-4o`) | Pay-as-you-go |
| ↳ [OpenRouter](https://openrouter.ai) | Unified API for many model providers | Pay-as-you-go |

### Optional services

| Service | What it does | When you need it |
|---------|-------------|-----------------|
| Outbound email provider | Sends quarterly reporting requests and system notifications | If you want to email portfolio companies from the app. Choose **Resend**, **Postmark**, **Mailgun**, or **Gmail**. |
| [Google Cloud](https://console.cloud.google.com) (OAuth) | Google Drive archiving + Gmail sending | If you want to save emails/attachments to Drive or send via Gmail |

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

### Step 7: Complete the onboarding wizard

After confirming your email and signing in, the app walks you through:

1. **Fund name** — this appears in the app header
2. **AI API key** — enter at least one: an Anthropic key from [console.anthropic.com](https://console.anthropic.com), an OpenAI key from [platform.openai.com](https://platform.openai.com), or an OpenRouter key from [openrouter.ai](https://openrouter.ai). You can configure multiple providers and switch between them. Keys are encrypted and stored in your database, not in environment variables.
3. **Inbound email address** — see Step 8

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
3. In the app's Settings page, select Mailgun as your inbound provider and enter your Mailgun API key and signing key

You can also edit the app to use other inbound email parsing services.

### Step 8: Add authorized senders

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

> Many of the inputs on Settings are only for the admin. All setting only available to admins are noted with a lock icon and color.

> By default the app assumes all colleagues use the same email domain. If this is not the case, contact Taylor and we can change this restriction.

### Verify your setup

A built-in setup checklist page helps you confirm your deployment is correctly configured. To enable it, add this environment variable:

```bash
ENABLE_SETUP_PAGE=true
```

Then visit `/setup` (no login required). The page checks infrastructure (env vars, database connectivity, core tables), authentication (at least one user), fund configuration, AI provider keys, email setup, file storage, and authorized senders. Each check shows a green, red, or gray icon indicating whether it passed, failed (required), or is missing (optional). Help links point you to the relevant settings or docs.

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

### Optional: Fund accounting

Accounting is a feature switch, and each vehicle keeps its own books — a fund, an SPV, a direct deal, or a GP/associate entity. Nothing else in the platform changes if you never turn it on.

Before you start, define your vehicles in **Settings > Investment vehicles**. Every accounting page is scoped to one of them.

For each vehicle you want books on:

1. **The chart of accounts is already there.** A vehicle gets its chart when it is created — the standard fund chart for a fund, SPV or direct vehicle; the GP-entity chart (investment in fund, members' capital, carried interest income) for one classified as an *associate*, because it keeps different books. A vehicle created before that gets its chart the first time its books are opened. Accounts are added, renamed or hidden under the vehicle's **Admin → Chart of accounts**.
2. **Bring in what came before.** Import the bank history, or take over at a cutover date on the vehicle's **Opening balances** page with each LP's capital balance from their latest statement. Investments and marks are recorded on the companies; each posts its own journal entry.
3. **Set the allocation terms.** Under **Accounting > Allocation terms**: the allocation basis, each partner's commitment, who bears which category, and — if the vehicle pays carry — the carry terms (none, a straight split, or a European waterfall with a preferred return and catch-up). Carry accrues at each close only if you set terms here; the default is no carry.

Then work the vehicle: import a bank feed under **Bank transactions**, review the drafted entries in the **Journal**, and run a **Period close** to allocate to each partner's capital account.

Two things worth knowing:

- **A vehicle does not need a ledger to appear in LP reporting.** If you don't keep books on an SPV, record its LP capital movements directly under **Accounting > LP capital events** — by hand or by pasting a spreadsheet — and it produces the same capital accounts, statements and LP report as a fully-booked vehicle. You can promote it to a full ledger later.
- **Associates and GP entities.** If a GP/associate vehicle invests in one of your funds, set both halves of its link in **Settings > Investment vehicles**: which fund it is *GP of*, and which partner on that fund's books it *invests as*. Without both, its members won't appear in the LP report.

### Optional: Two-factor authentication

Admins and team members can enable TOTP-based two-factor authentication from the Settings page. Once enabled, MFA is enforced on every login. Use any authenticator app (1Password, Authy, Google Authenticator, etc.).

### Optional: Invite team members

In **Settings > Team**, your team members can sign up (if their email matches the whitelist or your fund's email domain) and request to join. Admins approve requests and can assign admin or member roles.

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

### Dashboards in Claude and ChatGPT

Members can open the fund's dashboards inside a Claude or ChatGPT conversation, ask questions about what they are looking at, and save a dashboard to reopen later. There are four: the portfolio overview, a company with its KPIs, a vehicle's financial statements, and LP capital.

It needs **Settings > Agent access** switched on by an admin, which is off by default. Everything below is then per member, under **Settings > API and MCP**.

**How it works.** The app's MCP endpoint (`/api/mcp`) serves the dashboards as [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), an extension both assistants implement: a `show_…` tool returns the figures, and the assistant draws them in a view the endpoint also serves. An assistant that cannot draw the view shows the same figures as text. Each dashboard is the figures of the read tools beside it, so a dashboard and an answer in prose cannot disagree.

**Access is the member's own.** The assistant acts as the person who connected it. A dashboard for an area their access does not include is refused there exactly as it is in the app, and fund performance on the portfolio overview and the carry line in partners' capital are left out for a member without those grants. Switching Agent access off stops every connection at once.

**Saved dashboards** are kept in this deployment's database (`saved_dashboards`), because neither assistant keeps a view beyond the conversation it appeared in. What is saved is the view and its filters, never the figures, so a saved dashboard always opens on current data, in either assistant. A member can share one with the fund; a colleague opening it sees their own figures or a refusal. Saving and deleting need a connection approved for changes; a read-only connection can open any dashboard but not save one.

**Connecting Claude.** Download **Plugin for Claude** from Settings. In Claude, go to **Customize > Plugins > Add > Upload plugin** and select the file, then open the plugin's **Connectors** tab, connect it and sign in. The plugin is the connector plus two skills that tell Claude when to open a dashboard and how to save one. The connector alone (add the MCP URL as a custom connector) also draws the dashboards; the skills make Claude better at choosing them.

**Connecting ChatGPT.** In **Plugins**, choose the plus button, then **Add custom MCP server**, paste the MCP URL from Settings, and create it as a plugin. That is all the dashboards need. To add the skills in the ChatGPT desktop app or Codex, download **Plugin for ChatGPT**, unzip it to `~/.agents/plugins/portfolio/`, list it in `~/.agents/plugins/marketplace.json`, and restart the app:

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

The platform supports three AI providers. Configure at least one in Settings, then select the default provider used for email processing, metric extraction, summaries, and imports.

| Provider | Default Model | Key Required | Notes |
|----------|--------------|-------------|-------|
| **Anthropic** | `claude-sonnet-4-5` | API key from [console.anthropic.com](https://console.anthropic.com) | Best overall quality for analysis and extraction |
| **OpenAI** | `gpt-4o` | API key from [platform.openai.com](https://platform.openai.com) | Strong alternative with broad model selection |
| **OpenRouter** | Configurable | API key from [openrouter.ai](https://openrouter.ai) | Unified access to many model providers through one key |

Each provider has a model selector in Settings — after saving your API key, you can fetch the available models and choose which one to use. The **Analyst** panel also has a model dropdown that shows models from all configured providers, with an "Auto" option that uses the fund's default.

### Feature Visibility

Admins can control which optional features are visible in the sidebar and accessible across the platform. Each feature can be set to one of four visibility levels:

| Level | Behavior |
|-------|----------|
| **Everyone** | Visible to all team members in the sidebar and fully accessible |
| **Admin only** | Only visible to admin users; hidden from members |
| **Hidden** | Removed from the sidebar for all users, but still accessible via direct URL |
| **Off** | Functionally disabled — the feature is completely inaccessible |

The features that can be configured are: **Interactions** (CRM-style email logging), **Investments** (fund transaction tracking), **Funds** (fund-level cash flows and LP metrics), **Notes** (team discussion and observations), **Letters** (quarterly LP update generation), **LPs** (LP position tracking and reporting), **Compliance** (regulatory filing calendar and tracking), **Imports** (bulk data import), and **Asks** (portfolio company reporting requests).

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

### Updates

The app includes a built-in update checker. It periodically compares your installed version against the latest [GitHub release](https://github.com/tdavidson/portfolio/releases). When a newer version is available, admins will see an **Updates** link in the sidebar. Click it to see the current version, the latest version, release notes, and a link to the GitHub release.

Non-admin users do not see the update indicator. The check runs against the public GitHub Releases API (no authentication required) and is cached for one hour.

Each installation has a unique **Installation ID** — a UUID automatically generated in your database when you run migrations. This ID is specific to your deployment and is displayed at the bottom of the Updates page. It lays the groundwork for future license key validation and is not shared externally.

## Contact

Built by Taylor Davidson at [Hemrock](https://www.hemrock.com).

For setup assistance, support, or questions: [hemrock.com/contact](https://www.hemrock.com/contact).

For bug reports and feature requests: [GitHub Issues](https://github.com/tdavidson/portfolio/issues).
