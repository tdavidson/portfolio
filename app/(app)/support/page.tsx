import type { Metadata } from 'next'
import { Github, Scale, ExternalLink, BookOpen, Home, Newspaper, ListChecks, Globe, Building2, ClipboardCheck, Mail, Upload, Send, Settings, MessageSquare, Monitor, PanelLeftClose, Sparkles, Shield, ShieldCheck, Handshake, Users, ArrowDownCircle, DollarSign, FileText, Briefcase, Crown, Lightbulb, Microscope } from 'lucide-react'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PRIVACY_URL, PRODUCT_DOCS, PRODUCT_SITE, TERMS_URL } from '@/lib/site-links'
import { AREAS } from '@/lib/agent/getting-started'

export const metadata: Metadata = { title: 'Support' }

export default function SupportPage() {
  const tocLinks = (
    <ul className="space-y-1 text-muted-foreground">
      <li><a href="#links" className="hover:text-foreground underline underline-offset-4">Links</a></li>
      <li><a href="#getting-started" className="hover:text-foreground underline underline-offset-4">Getting Started</a></li>
      <li className="pl-4"><a href="#start" className="hover:text-foreground underline underline-offset-4">Start</a></li>
      <li className="pl-4"><a href="#setup" className="hover:text-foreground underline underline-offset-4">Self-hosting &amp; license</a></li>
      <li><a href="#portfolio" className="hover:text-foreground underline underline-offset-4">Portfolio</a></li>
      <li className="pl-4"><a href="#company-detail" className="hover:text-foreground underline underline-offset-4">Company detail</a></li>
      <li><a href="#review" className="hover:text-foreground underline underline-offset-4">Review</a></li>
      <li className="pl-4"><a href="#pending-actions" className="hover:text-foreground underline underline-offset-4">Pending actions</a></li>
      <li><a href="#inbound" className="hover:text-foreground underline underline-offset-4">Inbound</a></li>
      <li className="pl-4"><a href="#email-detail" className="hover:text-foreground underline underline-offset-4">Email detail</a></li>
      <li className="pl-4"><a href="#company-updates" className="hover:text-foreground underline underline-offset-4">Company updates</a></li>
      <li><a href="#import" className="hover:text-foreground underline underline-offset-4">Import</a></li>
      <li><a href="#asks" className="hover:text-foreground underline underline-offset-4">Asks</a></li>
      <li><a href="#settings" className="hover:text-foreground underline underline-offset-4">Settings</a></li>
      <li className="pl-4"><a href="#access" className="hover:text-foreground underline underline-offset-4">Access</a></li>
      <li><a href="#notes" className="hover:text-foreground underline underline-offset-4">Notes</a></li>
      <li><a href="#interactions" className="hover:text-foreground underline underline-offset-4">Interactions</a></li>
      <li><a href="#deals" className="hover:text-foreground underline underline-offset-4">Deals</a></li>
      <li><a href="#diligence" className="hover:text-foreground underline underline-offset-4">Diligence</a></li>
      <li><a href="#investments" className="hover:text-foreground underline underline-offset-4">Investments</a></li>
      <li><a href="#funds" className="hover:text-foreground underline underline-offset-4">Entities &amp; accounting</a></li>
      <li className="pl-4"><a href="#accounting" className="hover:text-foreground underline underline-offset-4">Accounting</a></li>
      <li><a href="#forecast" className="hover:text-foreground underline underline-offset-4">Forecast</a></li>
      <li><a href="#management-company" className="hover:text-foreground underline underline-offset-4">Management company</a></li>
      <li><a href="#letters" className="hover:text-foreground underline underline-offset-4">Letters</a></li>
      <li><a href="#lps" className="hover:text-foreground underline underline-offset-4">LPs</a></li>
      <li className="pl-4"><a href="#lp-portal" className="hover:text-foreground underline underline-offset-4">LP portal</a></li>
      <li><a href="#compliance" className="hover:text-foreground underline underline-offset-4">Compliance</a></li>
      <li><a href="#usage" className="hover:text-foreground underline underline-offset-4">Usage</a></li>
      <li><a href="#analyst" className="hover:text-foreground underline underline-offset-4">Analyst</a></li>
      <li><a href="#ai-assistants" className="hover:text-foreground underline underline-offset-4">Claude &amp; ChatGPT</a></li>
      <li><a href="#file-handling" className="hover:text-foreground underline underline-offset-4">File Handling &amp; Security</a></li>
      <li><a href="#updates" className="hover:text-foreground underline underline-offset-4">Version updates</a></li>
      <li><a href="#sidebar" className="hover:text-foreground underline underline-offset-4">Navigation &amp; theme</a></li>
    </ul>
  )

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
        <AnalystToggleButton />
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">
      <div className="flex gap-16">
        {/* Main content */}
        <div className="flex-1 min-w-0 max-w-3xl space-y-8 text-sm leading-relaxed">
          {/* Contact info */}
          <div className="rounded-card border bg-card p-5">
            <h2 className="text-base font-medium mb-2">Need help?</h2>
            <p className="text-muted-foreground">
              For questions about your fund&apos;s data, companies, metrics, or account access,
              contact the admin on your team. For technical questions, feature requests, or bug reports,
              reach out to Taylor Davidson at{' '}
              <a
                href="https://www.hemrock.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-foreground/80"
              >
                Hemrock
              </a>
              {' '}or open an issue on{' '}
              <a
                href="https://github.com/tdavidson/reporting"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-foreground/80"
              >
                GitHub
              </a>
              .
            </p>
          </div>

          {/* The links the in-app footer used to carry on every page. It no longer appears on
              /start, so this is where they are guaranteed to be found. */}
          <div id="links" className="rounded-card border bg-card p-5">
            <h2 className="text-base font-medium mb-3">Links</h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
              <li>
                <a href="https://hemrock.com" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <ExternalLink className="h-3.5 w-3.5" />Hemrock
                </a>
              </li>
              <li>
                <a href="https://github.com/tdavidson/reporting" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <Github className="h-3.5 w-3.5" />GitHub
                </a>
              </li>
              <li>
                <a href="https://github.com/tdavidson/reporting/blob/main/LICENSE.md" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <Scale className="h-3.5 w-3.5" />License
                </a>
              </li>
              <li>
                <a href={PRODUCT_SITE} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <ExternalLink className="h-3.5 w-3.5" />Product
                </a>
              </li>
              <li>
                <a href={PRODUCT_DOCS} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                  <BookOpen className="h-3.5 w-3.5" />Docs
                </a>
              </li>
              {TERMS_URL && (
                <li>
                  <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Terms</a>
                </li>
              )}
              {PRIVACY_URL && (
                <li>
                  <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Privacy</a>
                </li>
              )}
            </ul>
          </div>

          {/* Table of contents, inline on mobile only */}
          <nav className="xl:hidden">
            <h2 className="text-base font-medium mb-2">On this page</h2>
            {tocLinks}
          </nav>

          {/* Sections */}
        <div id="getting-started">
          <h2 className="text-base font-medium mb-2">Getting Started</h2>
          <p className="text-muted-foreground mb-2">
            This platform is designed to automate the collection, parsing, and tracking of portfolio
            company reports. Instead of manually copying numbers out of emails and spreadsheets,
            the system uses AI to extract metrics from whatever format your companies send &mdash;
            emails, PDFs, Excel workbooks, slide decks, images &mdash; and writes the data directly
            into each company&apos;s metrics history.
          </p>
          <p className="text-muted-foreground mb-2">
            The fastest way to get data flowing is to forward reporting emails to the <strong>inbound address</strong> shown
            in Settings. You can forward emails yourself, or give the inbound address to your
            founders or fund analysts and ask them to CC or send reports directly. Every email that
            arrives at that address is automatically parsed: the system identifies which company it&apos;s
            from, extracts the metrics you&apos;ve defined, and flags anything it&apos;s unsure about
            for your review.
          </p>
          <p className="text-muted-foreground mb-2">
            Not everything arrives by email. Files you download &mdash; PDFs, Excel workbooks, Word docs,
            PowerPoint decks, CSVs and images &mdash; can be added to a company&rsquo;s documents through the
            <strong>Import</strong> page, and spreadsheets of metrics or investment history can be pasted there in
            bulk.
          </p>
          <p className="text-muted-foreground mb-2">
            Once data starts flowing, the <strong>Portfolio</strong> dashboard shows every company, the
            <strong> Review</strong> queue catches anything that needs a human decision, and the <strong>Analyst</strong> is
            available on every page. The goal is to spend less time on data entry and more time on the analysis
            and conversations that matter.
          </p>
          <p className="text-muted-foreground">
            The app is four products an admin turns on separately in Settings &mdash; <strong>Portfolio
            Reporting</strong>, <strong>Investment Workflow</strong> (deals and diligence), <strong>LP Reporting</strong> and
            <strong> Fund Operations</strong> (accounting, forecast, compliance) &mdash; so you only see what your fund
            uses. On a phone you can install it as an app from the browser&rsquo;s Share or Install menu.
          </p>
        </div>

        <div id="start" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <Home className="h-3.5 w-3.5 text-muted-foreground" />
            Start
          </h3>
          <p className="text-muted-foreground">
            Members land on <strong>Start</strong>: an Analyst chat across everything you can see, with quick actions for the common tasks &mdash; add a company, an investment or a vehicle, import documents, add a deal, issue a capital call, or declare a distribution. Ask a question or pick a task. Each entity&rsquo;s <strong>Admin</strong> page carries the same actions for that entity, with a <strong>Capital calls</strong> card showing each open call&rsquo;s received, outstanding and overdue, how many partners have paid, and who says they wired.
          </p>
        </div>

        <div id="setup" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2">Self-hosting &amp; license</h3>
          <p className="text-muted-foreground mb-2">
            Under the hood, the platform uses a database, authentication, file storage, inbound email
            processing, and an AI provider, with prebuilt integrations for several third-party services
            across the stack. Download it from{' '}
            <a
              href="https://github.com/tdavidson/reporting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              GitHub
            </a>
            {' '}and deploy it on your own accounts; DOCS.md in the repository is the full installation guide
            &mdash; database, environment variables, encryption, email providers, AI and deployment. You control
            the operational details and the costs. Most services in the stack have generous free tiers; AI
            features need an API key from Anthropic, OpenAI or OpenRouter, which are paid accounts.
          </p>
          <p id="license" className="text-muted-foreground mb-2">
            <strong>License:</strong> Apache License 2.0. You are free to use it, modify it, and deploy it on
            your own infrastructure &mdash; for your own fund or commercially. There are no per-seat fees and no
            single-fund restriction. It includes an express patent grant, and the software is provided as-is,
            without warranty of any kind. Per its trademark clause, it does not grant rights to the
            &ldquo;Hemrock&rdquo; or &ldquo;Unstructured Ventures&rdquo; names or logos &mdash; if you fork or
            redeploy the software, please use your own branding. Read the{' '}
            <a
              href="https://github.com/tdavidson/reporting/blob/main/LICENSE.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              full license
            </a>
            .
          </p>
          <p className="text-muted-foreground">
            <a
              href="https://www.hemrock.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              Taylor Davidson
            </a>
            {' '}of Hemrock offers paid setup and support on your own infrastructure and accounts, including
            onboarding your portfolio data &mdash; write to{' '}
            <a href="mailto:hello@hemrock.com" className="text-foreground underline underline-offset-4 hover:text-foreground/80">
              hello@hemrock.com
            </a>
            .
          </p>
        </div>

        <div id="portfolio">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Portfolio
          </h2>
          <p className="text-muted-foreground mb-2">
            The Portfolio page is the main dashboard for monitoring the fund. Companies show as <strong>cards or a table</strong> with their headline metrics (such as MRR and cash balance), filtered by status (Active by default) and sorted by name or investment date. Fund holdings and digital assets are listed below the companies.
          </p>
          <p className="text-muted-foreground mb-2">
            An <strong>entity picker</strong> narrows the dashboard to one fund or SPV; your choice is saved to your account, and an admin sets the default under Settings &rarr; Portfolio Reporting &rarr; Dashboard entities. Settings &rarr; <strong>Default metrics</strong> applies a metric set to every company.
          </p>
          <p className="text-muted-foreground mb-2">
            Click any company to open its detail page. Anyone with write access to the portfolio can edit company details, metrics and aliases (alternative names that help the system match inbound emails to the right company).
          </p>
          <p className="text-muted-foreground">
            The header&rsquo;s notes and chat buttons open the fund-level notes and the Analyst. Each note belongs to an entity, and is read by the people who can see that entity.
          </p>
        </div>

        <div id="company-detail" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            Company Detail
          </h3>
          <p className="text-muted-foreground mb-2">
            Clicking a company on the Portfolio dashboard opens its detail page. At the top you&apos;ll
            see the company name, headline metrics (like MRR and cash balance), and badges for stage,
            industry and portfolio groups &mdash; or <strong>Fund holding</strong> / <strong>Digital asset</strong>. Anyone
            with write access can edit the name, aliases, stage, industry, founders, overview, and other details
            that give the AI more context for analysis. The same page holds fund holdings (with the underlying
            fund&rsquo;s register: commitment, NAV and capital calls) and digital assets (with wallets and units),
            and companies and assets show a <strong>price feed</strong> with any marks owed; it shows only the panels
            that kind of holding uses.
          </p>
          <p className="text-muted-foreground mb-2">
            The main content area starts with the <strong>Analyst</strong> card. This is where you
            can generate an AI-powered summary of the company based on all available data &mdash; reported
            metrics, email content, uploaded documents, and any previous summaries. The AI acts as a
            senior analyst preparing a portfolio review memo: it highlights current performance, trends,
            strengths, risks, and follow-up questions. You can regenerate the summary at any time as new
            data comes in, clear it to start fresh, or upload additional context documents (board decks,
            strategy memos, investor updates) directly from this card to give the AI more to work with.
            If your fund has multiple AI providers configured, a provider selector lets you choose
            which AI to use for each generation.
          </p>
          <p className="text-muted-foreground mb-2">
            Below the Analyst is the <strong>metrics section</strong>, where each metric has its own
            chart card. You can add new metrics directly from this page using the &ldquo;Add metric&rdquo;
            button, or delete a metric and all its data from its card. Each chart shows data points over
            time, color-coded by confidence level (green for high, amber for medium, red for low) with
            manual entries shown as hollow circles. Click any data point on a chart to open a popover
            where you can view the full details &mdash; period, value, confidence, source email, and
            notes &mdash; and edit or delete the value directly. You can also add data points manually
            using the &ldquo;Add&rdquo; button on each card, which is useful for entering historical data
            or correcting values. An export button at the top lets you download all metric data as a CSV.
            An <strong>Updates</strong> panel lists each update the company reported, with its period, attachments,
            an inline preview, and the OCR status of scanned pages.
          </p>
          <p className="text-muted-foreground mb-2">
            Further down the page, a <strong>documents section</strong> lists all files associated with
            the company &mdash; both files you&apos;ve uploaded and attachments from processed emails.
            These documents are available to the Analyst when generating summaries. Individual file
            uploads are limited to 20 MB per file. Finally, if the company has additional details like founders,
            contact emails, an overview, investment thesis, or a current business update, those appear
            at the bottom. A <strong>notes panel</strong> on
            the right side (or toggled via the chat button on mobile) lets your team leave company-specific
            observations. Each note belongs to an entity: on a company two funds share, Fund I&rsquo;s notes are
            read only by people who can see Fund I.
          </p>
          <p className="text-muted-foreground">
            The company page also has an <strong>Investments</strong> section with the fund&rsquo;s transactions in
            that company &mdash; see <a href="#investments" className="text-foreground underline underline-offset-4 hover:text-foreground/80">Investments</a>.
          </p>
        </div>

        <div id="review">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            Review
          </h2>
          <p className="text-muted-foreground mb-2">
            When inbound emails are processed, the AI pipeline sometimes flags items that need a human
            decision. These flagged items appear in the Review queue. Common reasons include: a <strong>new
            company</strong> was detected that doesn&apos;t match any existing portfolio company, a metric
            value was extracted with <strong>low confidence</strong>, a reporting period was ambiguous or duplicated, the
            company couldn&apos;t be identified, or a metric couldn&apos;t be found in the report at all. Review also
            holds emails that match a deal in diligence (<strong>Diligence match</strong>, accepted into its data room
            by a person), and NAV, capital-call and distribution notices from funds you hold &mdash; each fund notice
            is approved into the right entity.
          </p>
          <p className="text-muted-foreground mb-2">
            Each review item shows you the issue type, the extracted value (if any), and a snippet of
            context from the source email so you can make an informed decision. You can accept the
            extracted value as-is, reject it, or manually correct it with the right number. For new
            company detections, you can create the company or map it to an existing one.
          </p>
          <p className="text-muted-foreground mb-2">
            The <strong>review badge</strong> in the sidebar shows how many items are waiting for attention. Once all
            review items for a given email are resolved, that email&apos;s status automatically moves
            from &ldquo;needs review&rdquo; to &ldquo;success.&rdquo; You can also dismiss all review
            items for an email at once if the entire report should be skipped.
          </p>
          <p className="text-muted-foreground">
            Staying on top of the review queue is important &mdash; it&apos;s how you ensure the
            data flowing into your portfolio metrics is accurate. The system is designed to err on the
            side of flagging rather than silently writing bad data.
          </p>
        </div>

        <div id="pending-actions" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
            Pending actions
          </h3>
          <p className="text-muted-foreground">
            <strong>Pending actions</strong> (admins) lists changes the Analyst or a connected agent staged rather than made &mdash; metric updates, investments, capital calls &mdash; each to approve or reject. It appears in the sidebar only when something is waiting.
          </p>
        </div>

        <div id="inbound">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Inbound
          </h2>
          <p className="text-muted-foreground mb-2">
            Inbound shows every email that has been received and processed by the system. It&apos;s the
            audit trail for all automated report ingestion. Each row displays the sender, subject line,
            which company the email was matched to, and the <strong>processing status</strong> (success, needs review,
            failed, processing, pending, or skipped). Every email is first classified as reporting, an interaction,
            a deal, diligence, or other, and the detail page shows where it was routed.
          </p>
          <p className="text-muted-foreground mb-2">
            Filter by status, company and date range (from the last 7 days to last year). Filters
            apply immediately as you change them. The list is paginated and sorted by most recent first,
            so new emails always appear at the top.
          </p>
          <p className="text-muted-foreground mb-2">
            Clicking on any email opens its detail view. There you&apos;ll see the full processing
            result: which company was identified, which metrics were extracted and their values, the
            reporting period that was detected, and any review items that were created. The raw email
            body and attachment information are also available for reference.
          </p>
          <p className="text-muted-foreground mb-2">
            If an email failed processing (for example, the AI key was misconfigured or the email
            content was unreadable), you can see the error message in the detail view. For emails
            stuck in &ldquo;needs review,&rdquo; you can open the review modal directly from the
            Inbound page to resolve flagged items without navigating to the Review queue.
          </p>
          <p className="text-muted-foreground">
            The platform can also store documents for you automatically. If your admin has connected
            <strong>Google Drive</strong> in Settings, every inbound email and its attachments are saved
            into company-specific folders &mdash; organized by company name &mdash; so you always have
            the original source files alongside the extracted data.
          </p>
        </div>

        <div id="email-detail" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            Email Detail
          </h3>
          <p className="text-muted-foreground mb-2">
            Clicking on any email in the Inbound list opens its detail page. At the top you&apos;ll
            see the subject line, sender address, received date, processing status badge, and the
            company the email was matched to (if identified). If processing failed, an error message
            explains what went wrong.
          </p>
          <p className="text-muted-foreground mb-2">
            Below that, the page shows the metrics that were extracted &mdash; a table with each
            metric name, the reporting period, the extracted value, and a confidence indicator (high,
            medium, or low). If there are unresolved review items for this email, they appear next
            with their issue type, context snippet, and action buttons so you can accept, reject,
            edit, or dismiss each one. For new company detections, you can create the company directly
            from this page.
          </p>
          <p className="text-muted-foreground mb-2">
            The detail page also lists any attachments that came with the email (with filename, type,
            and size), the raw email body text, and a collapsible view of the AI&apos;s full response
            for debugging or reference.
          </p>
          <p className="text-muted-foreground">
            <strong>Approve</strong> accepts every open metric review on the email in one click (fund notices stay
            open for their own review). <strong>Process</strong> reruns the email &mdash; automatically (reclassified),
            or forced as reporting, an interaction or a new deal &mdash; replacing its extracted metrics and review
            items; you can also file it without processing, or skip it. If Google Drive is connected,
            <strong> Save to storage</strong> pushes the email and its attachments into the company&rsquo;s folder, and a
            document can be uploaded against the email.
          </p>
        </div>

        <div id="company-updates" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <Newspaper className="h-3.5 w-3.5 text-muted-foreground" />
            Company updates
          </h3>
          <p className="text-muted-foreground">
            Reporting emails become <strong>Company updates</strong> (Portfolio &rarr; Updates): a searchable record of what each company reported, with its attachments. Images and scanned PDF pages are queued for OCR &mdash; transcribed by the AI vision model &mdash; so their text is searchable too. You see the updates of the companies in your entities.
          </p>
        </div>

        <div id="import">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" />
            Import
          </h2>
          <p className="text-muted-foreground mb-2">
            <strong>Document Upload</strong> matches each file to a company by name and saves it to that company&rsquo;s documents, where the Analyst can use it. It accepts PDF, Word, PowerPoint, Excel, CSV and JPEG/PNG files up to 20 MB; files over 10 MB keep their extracted text only. To have a report&rsquo;s metrics extracted, forward it to the inbound address instead.
          </p>
          <p className="text-muted-foreground mb-2">
            You can also paste data that covers <strong>multiple companies</strong> at once &mdash; for example, rows copied from a spreadsheet or CSV file containing metrics across your portfolio. The system will parse the data, create new companies if they don&apos;t already exist, add new metrics as needed, and populate values for existing companies and metrics. An Email column adds those addresses to the authorized senders.
          </p>
          <p className="text-muted-foreground">
            Additionally, you can paste <strong>investment transaction data</strong> &mdash; rounds, proceeds, valuations, and share prices &mdash; and the AI will parse the entries and match them to your portfolio companies. This is useful for bulk-importing cap table history, backfilling historical rounds, or onboarding an entire portfolio&apos;s investment data at once. Transactions are written to each company&apos;s Investments section automatically.
          </p>
        </div>

        <div id="asks">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            Asks
          </h2>
          <p className="text-muted-foreground mb-2">
            Asks lets you send reporting request emails to your portfolio companies. This is how you
            kick off a reporting cycle &mdash; compose a message asking companies to send in their latest
            numbers, select which companies should receive it, and send it out. The system tracks each
            request so you know what was sent and when.
          </p>
          <p className="text-muted-foreground mb-2">
            The <strong>email composer</strong> takes a plain-text subject and body, pre-filled from your last ask.
            Set the from name and address, the reporting period and the date responses are due, add CC and BCC,
            and send yourself a test first. Emails go out through whichever outbound provider your admin has
            configured (Gmail, Resend, Postmark, or Mailgun).
          </p>
          <p className="text-muted-foreground mb-2">
            Each request is logged with its recipient list, send timestamp, and delivery results. You
            can view past requests to see the full history of reporting asks. The <strong>response tracker</strong> is a
            grid of companies by quarter, each marked yes, no, n/a or waived, so you can see who still owes a report.
            Operational reminders (Settings) can email you when it&rsquo;s time to send the quarterly ask and which
            companies haven&rsquo;t responded by the due date.
          </p>
          <p className="text-muted-foreground">
            When companies reply to your ask email with their report, those replies flow into the
            Inbound pipeline automatically (assuming the sender is on the authorized senders list and
            replies to the configured inbound address). The full loop &mdash; ask, receive, parse,
            review &mdash; is designed to work end to end with minimal manual effort.
          </p>
        </div>

        <div id="settings">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Settings className="h-4 w-4 text-muted-foreground" />
            Settings
          </h2>
          <p className="text-muted-foreground mb-2">
            Everyone can set their display name, two-factor authentication, note notifications, and their own API and MCP keys; non-admins can also connect their own Affinity key and read the AI summary prompt.
          </p>
          <p className="text-muted-foreground mb-2">
            Admins configure the <strong>organization</strong> &mdash; fund name, logo and address, the sign-in page, appearance (accent colour), currency, team and roles, AI providers (Anthropic, OpenAI and/or OpenRouter), inbound email (Postmark or Mailgun) and authorized senders, outbound email (Gmail, Resend, Postmark or Mailgun), authentication email templates, file storage (Google Drive), analytics, usage tracking, operational reminders, Agent access and the version card &mdash; and turn on each <strong>product</strong>.
          </p>
          <p className="text-muted-foreground mb-2">
            Each product group has a <em>Turn on</em> button and a row per feature, set to members, admins only, or off: <strong>Portfolio Reporting</strong> (default metrics, the AI summary prompt, dashboard entities), <strong>Investment Workflow</strong> (deal screening, external deal research, known referrers, AI models, diligence schemas, style anchors, defaults and caps, the Affinity connection), <strong>LP Reporting</strong> (the LP portal), and <strong>Fund Operations</strong> &mdash; whose accounting configuration lives on each entity&rsquo;s Admin page. A danger zone at the end of the organization settings permanently deletes all fund data.
          </p>
          <div id="access" className="pl-4 border-l-2 border-border mb-2">
            <h3 className="font-medium mb-1">Access</h3>
            <p className="text-muted-foreground mb-2">
              Two questions decide what a member sees, and both must say yes. <strong>Which areas</strong>:
              portfolio, deal flow, diligence, accounting, the management company, LP capital, GP economics,
              LP relations, compliance &mdash; each none, read, or read &amp; write. <strong>Whose data</strong>:
              All entities (including ones added later, and items assigned to none), specific funds, SPVs and
              entities, or none. Set both in <strong>Settings &rarr; Team &rarr; Access</strong>; the first column
              is the member&rsquo;s entities. Approving a join request asks which entities the person can see,
              and new members start with none. Admins always see everything.
            </p>
            <p className="text-muted-foreground mb-2">
              On a company two funds hold, a Fund I member sees the company, its updates and KPIs, and Fund
              I&rsquo;s position and books &mdash; not Fund II&rsquo;s, nor that Fund II holds it. Deals and diligence
              records belong to an entity (unassigned ones are visible to admins until assigned); an LP shows
              only their positions in your entities; notes, documents and emails follow their company or
              entity; and the Analyst, MCP, the Claude and ChatGPT connections and API keys see exactly
              what the member sees. Something you cannot see is simply &ldquo;not found&rdquo;.
            </p>
            <p className="text-muted-foreground">
              <strong>Feature visibility</strong> is the ceiling above all of it: a feature is on for members,
              admins only, or off &mdash; and off denies it to everyone, admins included, without deleting data.
            </p>
          </div>
          <p className="text-muted-foreground">
            For detailed technical setup instructions &mdash; configuring Supabase, environment
            variables, encryption keys, email providers, deployment, and more &mdash; see DOCS.md in the{' '}
            <a
              href="https://github.com/tdavidson/reporting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              repository on GitHub
            </a>
            .
          </p>
        </div>

        <div id="notes">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Notes
          </h2>
          <p className="text-muted-foreground mb-2">
            Notes are on each company&apos;s detail page, on the Notes page, and in a notes panel on the
            Portfolio, Investments, Asks, Interactions, Compliance, LPs and deal pages. They provide a lightweight way for team members
            to share observations, context, and follow-up items without leaving the platform.
          </p>
          <p className="text-muted-foreground mb-2">
            On a company detail page, the notes panel appears on the right side on desktop or can be
            toggled via a chat button on mobile. Notes here are specific to that company &mdash; use
            them for takeaways from founder calls, questions to raise at the next board meeting, context
            on a metric anomaly, or anything else your team should know about that particular investment.
            On the Portfolio dashboard, the shared notes section is for fund-level observations that
            apply across the portfolio: market trends, cross-company themes, reminders for the next
            investment committee, or general team updates.
          </p>
          <p className="text-muted-foreground mb-2">
            The Notes page is a centralized feed that collects all notes across the fund in one place.
            You can filter by All notes, General (fund-level) notes, or just notes where you were
            @mentioned. Each note shows the author, timestamp, its entity, and which company it belongs to (if
            any), with unread notes highlighted so you can quickly catch up on what you&apos;ve missed. Reply to
            a note to keep a thread together, and pin the ones that should stay at the top.
          </p>
          <p className="text-muted-foreground mb-2">
            Notes support <strong>@mentions</strong> &mdash; type <strong>@</strong> while writing a note
            to see a dropdown of team members, then select a name to mention them. Mentioned team members
            are highlighted in the note text and can receive email notifications depending on their
            preferences.
          </p>
          <p className="text-muted-foreground mb-2">
            You can also <strong>follow companies</strong> to stay informed about notes posted on companies
            you care about, even if you aren&apos;t directly mentioned. When someone posts a note on a
            company you follow, you&apos;ll receive a notification.
          </p>
          <p className="text-muted-foreground mb-2">
            Notification preferences are managed in <strong>Settings</strong> under your user profile.
            Choose <em>All notes</em>, <em>@Mentions &amp; followed companies</em> (and pick the companies to
            follow), or <em>None</em>, which sends nothing.
          </p>
          <p className="text-muted-foreground">
            All notes show the author&apos;s display name and timestamp. Team members can edit or
            delete their own notes. Each note belongs to an entity, and only people who can see that entity
            read it.
          </p>
        </div>

        <div id="interactions">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Handshake className="h-4 w-4 text-muted-foreground" />
            Interactions
          </h2>
          <p className="text-muted-foreground mb-2">
            Interactions gives GPs a searchable log of all conversations and introductions with portfolio
            companies. When a GP BCCs the fund&apos;s inbound email address on a conversation, the system
            automatically detects that the sender is a fund member, classifies the email as a CRM interaction
            (not a metrics report), and uses AI to extract a summary and identify any introductions.
          </p>
          <p className="text-muted-foreground mb-2">
            The inbound classifier decides whether an email is a report, an interaction, a deal or something
            else; mail from fund members leans toward interactions. No manual tagging is required.
          </p>
          <p className="text-muted-foreground mb-2">
            For each interaction, the AI generates a short summary, detects whether the email contains an
            introduction between parties, and extracts the names and context of anyone being introduced.
            Interactions are linked to portfolio companies when possible, so you can see all conversations
            related to a specific company.
          </p>
          <p className="text-muted-foreground mb-2">
            The Interactions page shows all logged interactions across the fund. Filter by tag &mdash; intro,
            hiring, strategy, fundraising, product, partnership, legal, operations &mdash; for the tags present. Each entry shows the date, linked company,
            subject line, AI summary, and an intro badge when introductions were detected. Click the intro
            details to expand and see the names, emails, and context of introduced contacts.
          </p>
          <p className="text-muted-foreground mb-2">
            On each company&apos;s detail page, a <strong>Recent Interactions</strong> section shows the
            latest interactions for that company, with intro entries highlighted in a distinct style. A
            &ldquo;View all&rdquo; link takes you to the full interactions list.
          </p>
          <p className="text-muted-foreground">
            The fund&apos;s inbound email address is displayed at the top of the Interactions page for
            easy reference and can be copied with one click. Simply BCC this address on any email conversation
            you want to log.
          </p>
        </div>

        <div id="deals">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" />
            Deals
          </h2>
          <p className="text-muted-foreground mb-2">
            Deals is the inbound side of deal flow &mdash; cold pitches, partner-forwarded intros, and
            scout submissions arrive at your existing inbound email address and are screened against your
            fund&apos;s thesis before they reach a partner&apos;s inbox. Every inbound email runs through a
            content-aware classifier that decides between five destinations: <strong>reporting</strong> (portfolio
            metrics), <strong>interactions</strong> (CRM-style emails from fund members),
            <strong> deals</strong> (a company pitching the fund), <strong>diligence</strong> (an email about a company
            already in diligence), or <strong>other</strong> (newsletters, recruiter spam, vendor pitches &mdash; filed
            without processing). Sender identity is a strong signal but not a hard rule, so a
            partner forwarding a cold pitch lands in Deals where it belongs.
          </p>
          <p className="text-muted-foreground mb-2">
            For each pitch routed to Deals, a single AI call extracts company name, founder, intro source,
            referrer when applicable, stage, industry, raise size, a 100&ndash;150 word company summary, and a
            thesis-fit analysis with a fit score (strong, moderate, weak, out of thesis). Out-of-thesis pitches
            auto-archive and surface in a weekly digest email so partners can sanity-check without eyeballing
            every cold pitch. Founders can also submit pitches directly via a public form at a per-fund URL
            &mdash; admins generate or rotate the URL in Settings. <strong>New deal</strong> adds one by hand, and each
            deal belongs to an entity. <strong>External deal research</strong> runs web research on the founders and
            company for deals at or above a fit threshold you set in Settings.
          </p>
          <p className="text-muted-foreground mb-2">
            The Deals page lists active pitches as a sortable table or a kanban board (drag-and-drop across
            status columns New, Reviewing, Advancing, Met, Diligence, Invested and Passed); moving a deal to
            Diligence opens a diligence record pre-filled from it. Click a pitch to see the summary,
            thesis-fit analysis, source email, attachments, founders, intro source, and a deal-scoped Analyst
            chat that knows the pitch and your thesis.
          </p>
          <p className="text-muted-foreground">
            Settings &rarr; Investment Workflow controls the investment thesis, screening prompt, public submission token,
            and the Known Referrers list (scouts and friends-of-fund whose intros bias toward Deals).
            Uncertain items go to a Review queue with the top two predicted destinations for one-click
            resolution &mdash; nothing is silently dropped.
          </p>
        </div>

        <div id="diligence">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Microscope className="h-4 w-4 text-muted-foreground" />
            Diligence
          </h2>
          <p className="text-muted-foreground mb-2">
            Diligence is the pre-investment workflow: when a deal is worth real time, you create a diligence
            record, upload the data room, and run a schema-driven agent that ingests the
            documents, conducts external research, asks partner Q&amp;A, drafts a structured memo, scores it
            per your rubric, and renders to Word or Google Docs. Each diligence record has Checklist, Data Room,
            Research, Founders, Scoring, Memo and Settings tabs. The checklist is assessed against the data room
            (found, partial, missing, n/a); documents are categorized; call recordings are transcribed; notes and
            files can be imported from Affinity; inbound emails about the deal can be accepted into its data room;
            and each deal shows its token, cost and time usage.
          </p>
          <p className="text-muted-foreground mb-2">
            The agent is operated by <strong>seven YAML/MD configuration files</strong> (&ldquo;schemas&rdquo;)
            that admins edit per-fund through an in-app editor under Settings &rarr; Investment Workflow &rarr; Diligence &rarr; Schemas:
            instructions, rubric, qa_library, data_room_ingestion, research_dossier, memo_output, and
            style_anchors. The schema editor is a plain-text editor with inline YAML syntax validation and
            version history; rolling back to a prior version is one click. Defaults are seeded automatically
            the first time you open the editor, so you can run the agent immediately and customize as you go.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Style Anchors</strong> are uploaded reference memos that teach the agent your firm&apos;s
            voice. Upload 3&ndash;8 prior memos in Settings &rarr; Investment Workflow &rarr; Diligence &rarr; Style anchors, tag each
            with vintage, sector, voice representativeness, and partner notes, and the agent uses them to
            match structure and tone during drafting. Reference memos teach voice &mdash; they never supply
            facts to a new memo.
          </p>
          <p className="text-muted-foreground mb-2">
            The agent runs in six stages: <strong>Ingest</strong> (classify each doc, extract claims, run gap
            analysis), <strong>Research</strong> (verify or contradict claims, build a competitive map,
            compile founder dossiers), <strong>Q&amp;A</strong> (next-best partner questions per the qa_library
            with skip logic against ingestion + research), <strong>Draft</strong> (assemble paragraphs with
            paragraph-level citations), <strong>Score</strong> (rate each rubric dimension; partner-only
            dimensions like team get null score with supporting material), <strong>Render</strong> (markdown,
            .docx download, or native Google Doc). Long stages run as background jobs picked up by a worker
            every minute.
          </p>
          <p className="text-muted-foreground mb-2">
            The memo editor is a two-pane view: rendered memo on the left with inline citation markers and
            visual treatment for projections, unverified claims, and contradictions; paragraph inspector and
            partner-attention sidebar on the right. Partners edit any paragraph (it flips to
            <em>partner_edited</em> origin), update rubric scores by hand, work through the attention queue
            (must-address / should-address / FYI), and finalize when ready &mdash; finalizing locks the draft.
            Recommendation and team scoring are partner-only and can never be set by the agent.
          </p>
          <p className="text-muted-foreground">
            Across all your active deals, the <strong>Inbox</strong> aggregates open partner-attention
            items so you can triage them in one pass. The <strong>Analytics</strong> view shows the agent
            funnel (created &rarr; ingestion &rarr; research &rarr; Q&amp;A &rarr; draft &rarr; finalized
            &rarr; won) with drop-off percentages, time-in-stage medians, win/loss by sector, and throughput
            per lead partner. Settings &rarr; Investment Workflow &rarr; Diligence &rarr; Defaults &amp; caps
            sets per-deal and monthly token caps (with a current-month usage bar), the research web-search toggle
            and the transcription check; <em>Per-stage AI models</em> picks a model per stage &mdash; e.g. a cheap
            model for ingest, a stronger one for draft.
          </p>
        </div>

        <div id="investments">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            Investments
          </h2>
          <p className="text-muted-foreground mb-2">
            Investments lists every holding &mdash; companies, fund holdings and digital assets &mdash; at cost and value, with a per-vehicle summary (MOIC, IRR and, where the books exist, TVPI, DPI and RVPI) and two charts. One <strong>Add</strong> menu creates a company, fund holding, digital asset or vehicle. <strong>Filters</strong> narrow it by vehicle type, status and individual entity, and each vehicle&rsquo;s name opens its entity page.
          </p>
          <p className="text-muted-foreground mb-2">
            The holdings chart switches between <strong>Value</strong> (fair value against current cost) and <strong>Multiple</strong> (gross multiple &mdash; proceeds plus fair value over invested &mdash; against 1.0x). The multiple view follows the Status filter, so <em>All</em> includes exits and write-offs.
          </p>
          <p className="text-muted-foreground mb-2">
            A direct deal or SPV whose holdings carry no figures yet &mdash; none recorded, or set up but never given an investment, proceeds or a mark &mdash; is shown as a <strong>Deal vehicle</strong> at the sum of its LP positions: paid-in as invested, distributions as proceeds, NAV as value. The moment any of its holdings has a figure, the holdings take over, so nothing is counted twice.
          </p>
          <p className="text-muted-foreground mb-2">
            On each <strong>company detail page</strong>, the Investments section holds the fund&rsquo;s transactions with that company: investments, conversions, proceeds and escrow receipts, valuation updates, rounds, share splits and income. Each one posts its entry to the entity&rsquo;s books. Summary metrics &mdash; total invested, current FMV, MOIC, and total realized &mdash; are shown above the transaction table.
          </p>
          <p className="text-muted-foreground">
            Anyone with write access to investments can add, edit or delete transactions. For exited companies the FMV reflects total realized proceeds; for written-off companies it shows zero; and for active companies it uses the latest share price multiplied by the shares still held &mdash; or, where no share price has been recorded, the remaining cost plus its marks. Investment data can also be bulk-imported via the Import page by pasting transaction data from a spreadsheet.
          </p>
        </div>

        <div id="funds">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-muted-foreground" />
            Entities &amp; accounting
          </h2>
          <p className="text-muted-foreground mb-2">
            <strong>Entities</strong> lists every fund, SPV, GP entity, individual and management company,
            with performance &mdash; committed, called, distributed, NAV, DPI, TVPI, IRR &mdash; derived from the
            books, and a <em>Net to LP</em> lens. Open one for its pages: journal, bank, capital accounts,
            schedule of investments, statements, portfolio construction, forecast, tax and close.
          </p>
          <div id="accounting" className="pl-4 border-l-2 border-border mb-2">
            <h3 className="font-medium mb-1">Accounting is always on</h3>
            <p className="text-muted-foreground mb-2">
              Every entity keeps double-entry books from the day it is created. Recording an investment, an
              exit, a mark, a conversion or a capital call posts its entry; a bank row matching one is linked to
              it rather than booked twice; and each income or expense entry is allocated to the partners as it
              posts. So the books are complete whether or not anyone opens them. The <strong>Accounting</strong> 
              switch (Settings &rarr; Feature visibility, or <em>Turn on Fund Operations</em>) only decides whether
              the pages are shown &mdash; like Investments and LP capital tracking.
            </p>
            <p className="text-muted-foreground mb-2">
              <strong>Bringing in history:</strong> on the entity&rsquo;s status page, <em>Put them on the ledger</em> 
              books investment history already in the tracker; <em>Migrate from QuickBooks</em> imports a general
              ledger; the bank page takes a CSV or a table copied straight from your bank&rsquo;s website; and 
              <em>Opening balances</em> takes over at a cutover date. An administrator&rsquo;s statement can be kept
              beside the books as dated positions and reconciled against them.
            </p>
            <p className="text-muted-foreground">
              <strong>Close</strong> reviews and locks each month: drafts and suggested recurring entries can be
              posted right there, it reconciles ledger cash to the bank feed, trues up carried interest, and
              lists every partner allocation in the month. The full guide is ACCOUNTING.md in the repository.
            </p>
            <p className="text-muted-foreground mt-2">
              <strong>GP economics</strong> (carry terms, carry accrued and paid per partner, per-deal carry and GP
              entity ownership) and <strong>Tax reporting</strong> (Schedule K-1 packages per vehicle and tax year,
              the allocation behind them, and delivery to the LP portal) are separate switches, so someone can keep
              the books without seeing the partners&rsquo; carry.
            </p>
            <p className="text-muted-foreground mt-2">
              <strong>Capital calls and distributions</strong> are issued from an entity&rsquo;s Capital accounts (or its
              Admin page): as an amount or a percentage of commitments, split pro-rata, or <em>pasted from a
              spreadsheet</em> &mdash; a partner column, an amount, and optionally what was paid and when. The sheet fills
              each partner&rsquo;s line for you to check, and anything already paid is recorded as a receipt when you
              issue, so the call shows who has paid from the start.
            </p>
          </div>
        </div>

        <div id="forecast">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" />
            Forecast
          </h2>
          <p className="text-muted-foreground mb-2">
            Budgets and rolling forecasts for each entity, built on the posted books and never written to them.
            Turn on <strong>Forecast</strong> in Settings &rarr; Feature visibility (Fund Operations). A 
            <strong>budget</strong> is a year planned by month and approved as the baseline; a 
            <strong>rolling forecast</strong> starts after the last closed month and runs 12&ndash;36 months.
          </p>
          <p className="text-muted-foreground mb-2">
            Each income and expense account has a rule &mdash; fixed, recurring schedule, historical run rate,
            growth, seasonal, manual, a linked management fee, or portfolio construction &mdash; and any month
            can be overridden. Cash timing (in advance, in arrears, a billing cycle) separates cash from P&amp;L.
            View any range by month, quarter or year as a P&amp;L, a cash-flow statement, or variance against
            the budget; every chart and table follows the same filters, and everything exports to CSV.
          </p>
          <p className="text-muted-foreground">
            <strong>Draft with AI</strong> asks the Analyst to suggest a rule for every account from up to 36
            months of history, adjust for what you tell it, and stage the plan for your approval. A 
            <strong>fee link</strong> ties a management company&rsquo;s fee revenue to each fund&rsquo;s fee terms.
          </p>
        </div>

        <div id="management-company">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-muted-foreground" />
            Management company
          </h2>
          <p className="text-muted-foreground mb-2">
            The management company is the firm&rsquo;s own operating entity &mdash; the company that
            employs the team, collects the management fee and pays the rent &mdash; as opposed to the
            funds it manages. It is listed on Entities with the funds but in its own table, because it has
            no commitments, no NAV, no TVPI and no limited partners. Switch it on under Settings &rarr; Fund
            Operations, then add a vehicle of type <strong>Management company</strong> from Investments or Start:
            its chart of accounts is there from creation. Members also
            need the separate Management company grant (Settings &rarr; Team &rarr; Access).
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Its chart of accounts is its own.</strong> Cash, receivables, prepaid and fixed
            assets, payables, payroll liabilities, deferred fee revenue, members&rsquo; capital and
            draws, fee and reimbursement income, and an operating expense structure that begins with
            four separate compensation accounts &mdash; salaries, payroll taxes, benefits, and bonus.
            They are kept apart because &ldquo;what does a head cost us&rdquo; and &ldquo;what did we
            pay out on last year&rsquo;s performance&rdquo; are different questions, and once they are
            booked together neither can be answered from the ledger again.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>The dashboard</strong> answers the four questions a firm asks about its own
            operating entity: how much cash there is and how long it lasts (burn excludes depreciation,
            which is not money leaving the building); what came in and went out{' '}
            <strong>by quarter</strong>, with the empty quarters drawn rather than skipped, because a
            fee that never arrived should look like a hole and not a flat line; where the money goes,
            ranked by account; and who owes whom.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Intercompany.</strong> Recording a charge &mdash; a management fee, an expense
            reimbursement, an allocated cost, an advance &mdash; posts <em>both sides</em> in one
            action: the receivable and the fee income on the management company, the expense and the
            payable on the fund, linked so the two can be reconciled. Settlement is a separate step,
            because the cash usually moves in a different quarter from the charge. Balances are shown
            per counterparty with due-from and due-to kept apart rather than netted, and they are read
            from the ledger rather than summed from the register &mdash; so a correcting journal entry
            is reflected without anyone having to amend a record as well. The same charges can be recorded from
            the fund side, on a fund&rsquo;s Admin page.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>The books themselves are the same tools a fund uses</strong>, scoped to this
            entity: the journal, the bank feed, financial statements, the period close, and the
            QuickBooks general-ledger import. The import&rsquo;s account mapping knows the
            management-company vocabulary, so payroll, benefits, occupancy and technology accounts
            arrive already matched rather than needing a dropdown each.
          </p>
          <p className="text-muted-foreground">
            <strong>Access is granted separately.</strong> A management company&rsquo;s ledger carries
            salaries, bonuses and partner draws, and none of that appears anywhere in a fund&rsquo;s
            books &mdash; the fund sees one number, the fee it pays. So Management company is its own
            access grant, it starts at <em>no access</em> for everyone, and granting someone fund
            accounting does not hand them the partners&rsquo; compensation. The rule is enforced by the
            entity rather than the page: an accounting request for a management company is refused
            whatever the caller&rsquo;s accounting grant says.
          </p>
        </div>

        <div id="letters">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Letters
          </h2>
          <p className="text-muted-foreground mb-2">
            Letters helps you generate quarterly update letters for your limited partners. Using AI
            and your portfolio data &mdash; reported metrics, company summaries, investment performance,
            and team notes &mdash; the system drafts professional LP communications scoped to a specific
            portfolio group and reporting period. To create a letter, click &ldquo;New letter&rdquo; and
            select the year, quarter, portfolio group, and template. You can optionally toggle
            &ldquo;year-end summary&rdquo; for Q4 letters and add custom instructions to guide the AI.
            A preview step shows the companies and data that will be included before generation begins.
          </p>
          <p className="text-muted-foreground mb-2">
            If you&apos;ve written LP letters before, you can upload a previous letter (.docx or .pdf)
            and the AI will analyze it to match your writing style, tone, and structure. Otherwise, a
            built-in default <strong>template</strong> is available. Templates are reusable across letters and managed
            from the Templates dialog on the Letters page.
          </p>
          <p className="text-muted-foreground mb-2">
            During generation, the AI writes a narrative for each company in the portfolio group, drawing
            on reported metrics, recent trends, company summaries, investment data, and team notes. A
            portfolio summary table with investment performance is also generated, and the full letter is
            assembled from these sections. After generation, the letter opens in an <strong>editor</strong> with two views:
            &ldquo;Sections&rdquo; shows each company narrative individually for targeted editing, and
            &ldquo;Full&rdquo; shows the complete assembled letter. You can edit narratives inline,
            regenerate individual company sections or the entire letter, and add <strong>custom prompts</strong> per-company
            or globally to refine the output. Per-company prompts can either add to or replace the
            default generation prompt.
          </p>
          <p className="text-muted-foreground">
            When you&apos;re satisfied with the letter, download it as .docx, or export it to Google Docs if
            Google is connected. With the LP portal on, <strong>Share with LPs</strong> publishes it to the portal.
          </p>
        </div>

        <div id="lps">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Crown className="h-4 w-4 text-muted-foreground" />
            LPs
          </h2>
          <p className="text-muted-foreground mb-2">
            <strong>LPs</strong> rolls every LP across every vehicle up to the investor, live as of any date: commitment, paid-in, distributions, NAV, DPI, TVPI and IRR, with charts, search and a vehicle filter. Print investor <strong>report cards</strong> (one PDF each, or all at once), export to Excel, group or rename investors, and set the report header and footer from its Settings button.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Capital accounts</strong> keeps each vehicle&rsquo;s administrator statements as dated positions you paste or type, with history and inline editing. Sharing with LPs freezes a snapshot of the figures.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Documents</strong> manages the portal side: invite LPs and their authorized users (one at a time or from a pasted sheet), the onboarding checklist with LP uploads to review, shared documents, and messages. <strong>Preview portal</strong> shows the portal as an LP sees it, and <strong>Activity</strong> shows who logged in, viewed or downloaded.
          </p>
          <p className="text-muted-foreground">
            These are separate switches under LP Reporting: LPs, LP Capital Accounts, LP Documents and Sharing, and LP Activity Log.
          </p>
        </div>

        <div id="lp-portal" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2 flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            LP portal
          </h3>
          <p className="text-muted-foreground">
            Your LPs sign in to their own portal, separate from the app: an overview of their positions, notices for capital calls and distributions (with a &ldquo;We&rsquo;ve wired&rdquo; form), letters, documents, onboarding, a way to contact you, and their settings. Each LP sees only their own entities.
          </p>
        </div>

        <div id="compliance">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Compliance
          </h2>
          <p className="text-muted-foreground mb-2">
            Compliance helps fund managers stay on top of regulatory filings, tax deadlines, internal
            compliance requirements, and fund reporting obligations. It provides a calendar-based view
            of everything due throughout the year, tailored to your fund&apos;s specific profile and
            registration status.
          </p>
          <p className="text-muted-foreground mb-2">
            Start by completing a short <strong>compliance profile</strong> questionnaire about your fund &mdash; registration status, AUM
            range, fund structure, Reg D exemption type, state presence, and a few other details. The
            system uses your answers to automatically determine which compliance items apply, which need
            further review, and which you can safely dismiss. If your fund profile changes, update the
            questionnaire and the calendar adjusts accordingly.
          </p>
          <p className="text-muted-foreground mb-2">
            All applicable items appear in a <strong>monthly calendar</strong> organized by deadline. Items are color-coded
            by category &mdash; SEC filings in amber, tax filings in green, internal compliance in blue,
            fund reporting in purple, state compliance in rose, CFTC in orange, and AML/FinCEN in red.
            Quarterly items like partnership expense reviews and access person disclosures appear in each
            quarter independently, so you can track and dismiss them separately. Items can be per vehicle, and
            you see those for your entities; other years are a click away, and upcoming filings appear in the
            operational-reminders digest.
          </p>
          <p className="text-muted-foreground mb-2">
            When you finish a filing, mark it <strong>complete</strong> (with an optional note and filing link), or
            <strong> dismiss</strong> it if it doesn&apos;t apply; filter by Active, Completed, Dismissed or All. The
            page has Calendar, All Items, Fund Profile and Filing Links tabs. The <strong>all items</strong> view provides a comprehensive list of every compliance
            item organized by category, with each item showing its frequency, deadline, applicability,
            filing system, and any relevant notes or alerts.
          </p>
          <p className="text-muted-foreground mb-2">
            The system ships with a curated registry of compliance items covering SEC filings
            (Form ADV, Form PF, Form 13F, Schedule 13G, Form 13H, Form N-PX), securities offerings
            (Form D, Blue Sky), CFTC exemptions, California diversity reporting, tax filings (Form 1065,
            K-1s, Form 7004), internal compliance (access person disclosures, annual compliance review,
            privacy notice), AML/FinCEN requirements, fund reporting (quarterly financials, valuations),
            and partnership expense allocation.
          </p>

          <p className="text-muted-foreground mb-2">
            Save links to filing portals, regulatory accounts, and reference documents alongside your
            compliance items. Each link can optionally be associated with a specific compliance item,
            and associated links appear on that item&apos;s detail card for quick access during filing
            season. Links are editable after entry &mdash; hover over any link and click the pencil
            icon to update the title, URL, description, or associated compliance item.
          </p>
        </div>

        <div id="usage">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Usage
          </h2>
          <p className="text-muted-foreground mb-2">
            <strong>AI Usage</strong> is an admin-only page that shows how your fund is consuming AI tokens and how team members are using the platform.
          </p>
          <p className="text-muted-foreground mb-2">
            The top section shows <strong>AI token usage</strong> by provider (Anthropic, OpenAI and/or OpenRouter), with month-to-date input tokens, output tokens and estimated cost. A daily table breaks usage down by provider and model, and a monthly summary shows totals by month.
          </p>
          <p className="text-muted-foreground">
            The bottom section shows <strong>team activity</strong>: logins, companies, imports and other actions per team member, and a recent activity feed. Activity logging can be turned off in Settings &rarr; Usage tracking.
          </p>
        </div>

        <div id="analyst">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Analyst
          </h2>
          <p className="text-muted-foreground mb-2">
            The Analyst is an interactive chat interface available on every page. Powered by AI, it acts as a senior
            venture capital analyst with full access to your portfolio data, answering questions, surfacing
            insights, and helping you prepare for board meetings and investment committee discussions.
          </p>
          <p className="text-muted-foreground mb-2">
            On a <strong>company page</strong>, the Analyst has access to that company&apos;s reported metrics,
            email content, uploaded documents, previous AI summaries, investment transaction history, portfolio
            peer comparisons, and your team&apos;s internal discussion notes. You can ask it to analyze
            performance trends, compare the company to peers, identify risks, draft or refine summaries,
            interpret financial data from reports, or answer any question about the company&apos;s data.
          </p>
          <p className="text-muted-foreground mb-2">
            Elsewhere it is scoped to the section you&rsquo;re in &mdash; portfolio, deals, diligence, LPs, or an
            entity&rsquo;s books &mdash; and only to the entities you can see; on Start it covers all of them. Use it to
            compare companies, get portfolio-level insights, or ask about cross-portfolio trends and themes.
          </p>
          <p className="text-muted-foreground mb-2">
            Your <strong>chat history</strong> is persistent and saved to your account in the database. You can close the panel,
            navigate to other pages, or close the browser entirely &mdash; when you return, click the clock icon to
            open your conversation history and resume any previous thread. Conversations are scoped by context:
            company-specific chats stay with that company, and portfolio-wide chats have their own history.
          </p>
          <p className="text-muted-foreground mb-2">
            The Analyst has <strong>conversation memory</strong> that gives it continuity across sessions. When you
            start a new conversation, the system automatically summarizes your recent past conversations
            in the same context and injects those summaries into the AI&apos;s prompt. This means the
            Analyst remembers what you&apos;ve discussed before &mdash; key questions, conclusions, and
            concerns &mdash; without you needing to repeat context.
          </p>
          <p className="text-muted-foreground mb-2">
            The Analyst also incorporates your <strong>team notes</strong> into its analysis. Notes posted on a company page
            are included when chatting about that company, and portfolio-wide notes are included in fund-level
            conversations. This means the AI is aware of your team&apos;s observations, follow-up items, and
            qualitative context alongside the quantitative data.
          </p>
          <p className="text-muted-foreground mb-2">
            Use the header controls to manage conversations: the <strong>clock icon</strong> opens your
            conversation history, the <strong>plus icon</strong> starts a new conversation, and you can
            delete old conversations from the history list. Pick a model from any configured provider (or
            Auto) and, where the model supports it, an effort level.
          </p>
          <p className="text-muted-foreground mb-2">
            The Analyst can also save its responses directly as company summaries using the &ldquo;Save
            as Summary&rdquo; button that appears below each response on company pages. This lets you
            use the chat to iteratively refine a summary and then commit it to the company&apos;s record
            with one click.
          </p>
          <p className="text-muted-foreground">
            <strong>Attach a document</strong> (PDF, Word, Excel, Markdown, CSV or text) to ask about it; in an
            entity&rsquo;s books the Analyst drafts the journal entry from a capital-call notice, invoice or wire,
            saved as a draft for you to review. Changes it proposes elsewhere &mdash; metric updates, investments,
            capital calls &mdash; appear as Approve/Reject cards and in Pending actions. On Forecast, <em>Draft with
            AI</em> opens it with the entity&rsquo;s history.
          </p>
        </div>

        <div id="ai-assistants">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Claude &amp; ChatGPT
          </h2>
          <p className="text-muted-foreground mb-2">
            Use your fund from Claude or ChatGPT: ask questions, and open live portfolio, company, financial
            statement and LP dashboards inside the conversation &mdash; signed in as you, seeing only what you
            can see. An admin first switches on <strong>Settings &rarr; Agent access</strong>; then each member
            finds their connection under <strong>Settings &rarr; API and MCP</strong>.
          </p>
          <div className="pl-4 border-l-2 border-border mb-2">
            <h3 className="font-medium mb-1">Claude</h3>
            <ol className="list-decimal pl-5 text-muted-foreground space-y-1">
              <li>In Settings &rarr; API and MCP, download <strong>Plugin for Claude</strong>.</li>
              <li>In Claude, open <strong>Customize &rarr; Plugins &rarr; Add &rarr; Upload plugin</strong> and choose the file.</li>
              <li>Open the plugin&rsquo;s <strong>Connectors</strong> tab, choose <strong>Connect</strong>, sign in to your fund and approve.</li>
            </ol>
            <p className="text-muted-foreground mt-1">
              Claude Code: <code className="font-mono text-xs">claude mcp add --transport http fund &lt;MCP URL&gt;</code> 
              and sign in when prompted, or add an API key header from the same Settings page.
            </p>
          </div>
          <div className="pl-4 border-l-2 border-border mb-2">
            <h3 className="font-medium mb-1">ChatGPT</h3>
            <ol className="list-decimal pl-5 text-muted-foreground space-y-1">
              <li>Copy the <strong>MCP URL</strong> from Settings &rarr; API and MCP.</li>
              <li>In ChatGPT, open <strong>Plugins</strong>, choose <strong>+</strong>, then <strong>Add custom MCP server</strong>; paste the URL, upload the icon from Settings &rarr; API and MCP, and create it as a plugin.</li>
              <li>Connect, sign in to your fund and approve.</li>
            </ol>
            <p className="text-muted-foreground mt-1">
              For the skills in the ChatGPT desktop app or Codex, download <strong>Plugin for ChatGPT</strong>,
              unzip it into <code className="font-mono text-xs">~/.agents/plugins/</code>, list it in 
              <code className="font-mono text-xs">~/.agents/plugins/marketplace.json</code> and restart the app
              (DOCS.md has the exact entry).
            </p>
          </div>
          <div className="pl-4 border-l-2 border-border mb-2">
            <h3 className="font-medium mb-1">Getting started</h3>
            <p className="text-muted-foreground mb-2">
              Once connected, ask <strong>&ldquo;What can you do?&rdquo;</strong>. That opens your <strong>home
              dashboard</strong>: tiles for the dashboards your access allows (the portfolio, statements per
              entity, LP capital), the dashboards you and your colleagues saved, and questions for each area
              you can see &mdash; click one and it is asked for you.
            </p>
            <p className="text-muted-foreground mb-2">
              <strong>Prompts</strong> are ready-made requests in your assistant&rsquo;s prompt menu (in Claude, the
              + menu; in Claude Code, type /): <em>Get started</em>, <em>Portfolio review</em>, <em>Company
              check-in</em>, <em>Quarter-end review</em>, <em>LP capital status</em>, <em>Draft a forecast</em> and{' '}
              <em>Budget variance</em> &mdash; only those your access covers. Pick one, fill in the company or
              fund, and send. Ask for an LP&rsquo;s capital account statement or an investor&rsquo;s report card as a
              PDF and the assistant gives you a download link that works for an hour, for you only.
            </p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              {AREAS.map(a => (
                <li key={a.key}><strong>{a.label}</strong> &mdash; &ldquo;{a.questions[0]}&rdquo; &middot; &ldquo;{a.questions[1]}&rdquo;</li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground">
            The plugin is built for your own deployment&rsquo;s address and contains no key and no data. You
            choose read, or read and change, when you approve; revoking it or switching Agent access off
            stops it at once. Ask the assistant to <em>save this dashboard</em> to reopen it later, in either
            assistant, always on current figures.
          </p>
          <div className="pl-4 border-l-2 border-border mt-2">
            <h3 className="font-medium mb-1">What the assistants can show</h3>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li><strong>Portfolio</strong> &mdash; pick an entity, switch between current holdings and all companies, and chart by fair value or by gross multiple.</li>
              <li><strong>Capital calls</strong> &mdash; &ldquo;who still owes us on the latest call?&rdquo; shows each LP as paid, partly paid, says wired (their word from the portal, not yet received), unpaid or overdue, with the fund&rsquo;s other calls to switch between.</li>
              <li><strong>LP documents</strong> &mdash; ask for an LP&rsquo;s capital account statement or an investor&rsquo;s report card as a PDF; the link works for an hour, only for you, and checks your access again when opened.</li>
              <li><strong>Carried interest</strong> &mdash; the fund&rsquo;s carry is shown to anyone who can see LP capital; what each carry recipient personally earns needs GP economics access.</li>
            </ul>
          </div>
          <p className="text-muted-foreground mt-2">
            <strong>The connector&rsquo;s icon.</strong> ChatGPT uses the icon you upload when adding the server (download it from Settings &rarr; API and MCP). Claude currently shows a generic icon for every custom connector; the server already declares your fund&rsquo;s icon for when it reads it.
          </p>
        </div>

        <div id="file-handling">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            File Handling &amp; Security
          </h2>
          <p className="text-muted-foreground mb-2">
            The platform accepts PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), Excel (.xls/.xlsx), CSV and
            JPEG/PNG images. Files can be uploaded through the Import page, attached to
            inbound emails, or uploaded directly to a company&apos;s documents section.
          </p>
          <p className="text-muted-foreground mb-2">
            Individual file uploads are limited to <strong>20 MB per file</strong>, for both manual uploads and
            email attachments; files over 10 MB keep their extracted text only. Diligence data rooms accept files
            up to 100 MB. For larger files (such as high-resolution board
            decks or extensive spreadsheets), consider splitting them into smaller parts, compressing images,
            or exporting to a more compact format before uploading. The AI processing pipeline works best
            with focused, well-structured documents rather than very large omnibus files.
          </p>
          <p className="text-muted-foreground mb-2">
            The system extracts <strong>text content</strong> from uploaded files to make
            them available to the AI for analysis and metric extraction. PDFs and Office documents have
            their text extracted server-side. Images are processed using the AI&apos;s <strong>vision capabilities</strong> to
            read charts, tables, and text directly from screenshots or photos of reports, and images and scanned PDF
            pages in company updates are queued for OCR so their text is searchable.
          </p>
          <p className="text-muted-foreground mb-2">
            Every upload is <strong>checked before it is stored</strong>: blocked file types, executable content,
            files whose contents don&apos;t match their type, and archive bombs are rejected. This is not a full
            antivirus, so if your policy requires one, add scanning at the storage provider (Supabase Storage or
            Google Drive) as well.
          </p>
          <p className="text-muted-foreground mb-2">
            When <strong>file storage</strong> is configured (Google Drive),
            email attachments and uploaded documents are automatically organized into company-specific
            folders. This provides a backup of all source materials alongside the extracted data. Files
            stored in Supabase Storage are accessible through the platform&apos;s UI; files in Google
            Drive can also be accessed directly through that service.
          </p>
          <p className="text-muted-foreground">
            Uploaded files and their extracted content are only accessible to members of your fund.
            <strong>Row-level security</strong> limits each user to their fund and, within it, to the entities they&rsquo;ve
            been granted, storage included. File content sent to AI providers (Anthropic, OpenAI or OpenRouter) for processing is subject to those
            providers&apos; <strong>data handling policies</strong> &mdash; refer to their documentation for details on
            data retention and usage.
          </p>
        </div>

        <div id="updates">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <ArrowDownCircle className="h-4 w-4 text-muted-foreground" />
            Version updates
          </h2>
          <p className="text-muted-foreground mb-2">
            The platform includes a built-in update checker that compares your installed version against
            the latest release on GitHub. When a newer version is available, admins will see an{' '}
            <strong className="text-foreground">Updates</strong> link in the sidebar with an indicator dot.
          </p>
          <p className="text-muted-foreground mb-2">
            The Updates page shows your current version, the latest available version, release notes, and
            a link to the GitHub release. The check runs automatically and is cached for one hour, so
            it does not slow down normal usage.
          </p>
          <p className="text-muted-foreground">
            Each installation has a unique <strong className="text-foreground">Installation ID</strong> &mdash;
            a UUID generated automatically in your database. This ID is specific to your deployment and is
            shown at the bottom of the Updates page, and is sent to GitHub with the version check. Only admins
            can see the Updates page; non-admin users are not shown the update indicator. (Not to be confused with
            Portfolio &rarr; Updates, which is company updates.)
          </p>
        </div>

        <div id="sidebar">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
            Navigation &amp; theme
          </h2>
          <p className="text-muted-foreground mb-2">
            The sidebar follows the products: Start, Inbound, Deals, Diligence (Inbox, Analytics), Portfolio (Import, Investments, Asks, Interactions, Updates, Letters, Notes, Compliance), LPs (Capital accounts, Documents, Preview portal, Activity), Entities, Usage, Settings and Support &mdash; only the sections you can see. A lock marks admin-only items, and admins see an Updates link when a new version is out.
          </p>
          <p className="text-muted-foreground mb-2">
            At the bottom, the theme toggle cycles between System, Light and Dark; System follows your operating system&apos;s preference. The <strong>Hide sidebar</strong> button collapses it to an icon strip for more room.
          </p>
          <p className="text-muted-foreground">
            On a phone, a tab bar at the bottom holds four sections plus <strong>More</strong> for everything else; a dot on More means something is waiting. Install the app from the browser&rsquo;s Share or Install menu to use it full-screen.
          </p>
        </div>
        </div>

        {/* Sticky sidebar TOC, desktop only */}
        <nav className="hidden xl:block w-44 shrink-0 text-sm">
          <div className="sticky top-8">
            <h2 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider mb-3">On this page</h2>
            {tocLinks}
          </div>
        </nav>
      </div>
    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}
