import type { Metadata } from 'next'
import { Github, Scale, ExternalLink, Building2, ClipboardCheck, Mail, Upload, Send, Settings, MessageSquare, Monitor, PanelLeftClose, Sparkles, Shield, ShieldCheck, Handshake, Users, ArrowDownCircle, DollarSign, FileText, Briefcase, Crown, Lightbulb, Microscope } from 'lucide-react'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PRIVACY_URL, TERMS_URL } from '@/lib/site-links'

export const metadata: Metadata = { title: 'Support' }

export default function SupportPage() {
  const tocLinks = (
    <ul className="space-y-1 text-muted-foreground">
      <li><a href="#links" className="hover:text-foreground underline underline-offset-4">Links</a></li>
      <li><a href="#getting-started" className="hover:text-foreground underline underline-offset-4">Getting Started</a></li>
      <li className="pl-4"><a href="#setup" className="hover:text-foreground underline underline-offset-4">Setup</a></li>
      <li className="pl-4"><a href="#license" className="hover:text-foreground underline underline-offset-4">License</a></li>
      <li className="pl-4"><a href="#pricing" className="hover:text-foreground underline underline-offset-4">Pricing</a></li>
      <li><a href="#portfolio" className="hover:text-foreground underline underline-offset-4">Portfolio</a></li>
      <li><a href="#review" className="hover:text-foreground underline underline-offset-4">Review</a></li>
      <li><a href="#inbound" className="hover:text-foreground underline underline-offset-4">Inbound</a></li>
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
      <li><a href="#forecast" className="hover:text-foreground underline underline-offset-4">Forecast</a></li>
      <li><a href="#management-company" className="hover:text-foreground underline underline-offset-4">Management company</a></li>
      <li><a href="#letters" className="hover:text-foreground underline underline-offset-4">Letters</a></li>
      <li><a href="#lps" className="hover:text-foreground underline underline-offset-4">LPs</a></li>
      <li><a href="#compliance" className="hover:text-foreground underline underline-offset-4">Compliance</a></li>
      <li><a href="#usage" className="hover:text-foreground underline underline-offset-4">Usage</a></li>
      <li><a href="#analyst" className="hover:text-foreground underline underline-offset-4">Analyst</a></li>
      <li><a href="#ai-assistants" className="hover:text-foreground underline underline-offset-4">Claude &amp; ChatGPT</a></li>
      <li><a href="#file-handling" className="hover:text-foreground underline underline-offset-4">File Handling &amp; Security</a></li>
      <li><a href="#updates" className="hover:text-foreground underline underline-offset-4">Updates</a></li>
      <li><a href="#sidebar" className="hover:text-foreground underline underline-offset-4">Theme &amp; Sidebar</a></li>
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
            Not everything arrives by email. When someone sends you a link to a Google Sheet, Google
            Slides, Docsend deck, or any other hosted file, download it and upload it through the
            <strong>Import</strong> page. The same goes for PDFs, Excel workbooks, Word docs, PowerPoint decks, CSVs,
            and images &mdash; anything you can download, you can import. The AI pipeline processes
            uploads identically to inbound emails.
          </p>
          <p className="text-muted-foreground">
            Once data starts flowing, the <strong>Portfolio</strong> dashboard gives you a real-time view of every
            company, the <strong>Review</strong> queue catches anything that needs a human decision, and the <strong>Analyst</strong> on
            each company page synthesizes the data into actionable summaries. The goal is to spend
            less time on data entry and more time on the analysis and conversations that matter.
          </p>
        </div>

        <div id="setup" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2">Setup</h3>
          <p className="text-muted-foreground mb-2">
            Under the hood, the platform uses a database, authentication, file storage, inbound email
            processing, and an AI provider, with prebuilt integrations for several third-party services
            across the stack. The software can be downloaded and deployed on your own infrastructure
            from{' '}
            <a
              href="https://github.com/tdavidson/reporting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              GitHub
            </a>
            . The README provides a detailed installation guide covering database setup, environment
            variables, encryption, email providers, AI configuration, and deployment.
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
            {' '}of Hemrock is available to set this up, onboard you and your portfolio data, and
            provide ongoing support &mdash;{' '}
            <a
              href="https://www.hemrock.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              contact him for details
            </a>
            .
          </p>
        </div>

        <div id="license" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2">License</h3>
          <p className="text-muted-foreground mb-2">
            Apache License 2.0. You are free to use it, modify it,
            and deploy it on your own infrastructure &mdash; for your own fund or commercially. There are no
            per-seat fees and no single-fund restriction. It includes an express patent grant, and the
            software is provided as-is, without warranty of any kind.
          </p>
          <p className="text-muted-foreground mb-2">
            The license covers the source code and documentation. Per its trademark clause, it does not
            grant rights to the &ldquo;Hemrock&rdquo; or &ldquo;Unstructured Ventures&rdquo; names or logos
            &mdash; if you fork or redeploy the software, please use your own branding.
          </p>
          <p className="text-muted-foreground">
            Need help deploying, hosting, or supporting it? Reach out to{' '}
            <a
              href="mailto:hello@hemrock.com"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              hello@hemrock.com
            </a>
            . Read the{' '}
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
        </div>

        <div id="pricing" className="pl-4 border-l-2 border-border">
          <h3 className="text-base font-medium mb-2">Pricing</h3>
          <p className="text-muted-foreground mb-2">
            You can download and deploy this platform for your own use under the terms of the{' '}
            <a
              href="https://github.com/tdavidson/reporting/blob/main/LICENSE.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              license
            </a>
            , using your own accounts for the components in the stack &mdash; database, hosting,
            email providers, file storage, and AI. This means you control your own operational
            details and costs, and all of those costs are controlled by you.
          </p>
          <p className="text-muted-foreground mb-2">
            Most of the services used in the stack have fairly generous free pricing tiers that
            should handle normal usage of the product, but your costs may vary depending on your
            portfolio size and usage patterns. The platform does require use of Anthropic or OpenAI
            API keys for AI-powered features (metric extraction, summaries, and analysis), which
            will require paid accounts with those providers.
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
            {' '}of Hemrock is also available to set up, host, and manage the platform for you,
            including onboarding your portfolio data and providing ongoing support &mdash;{' '}
            <a
              href="https://www.hemrock.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              contact him for details and pricing
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
            The Portfolio page is the main dashboard and your starting point for monitoring the fund.
            It shows all active companies with key headline metrics (such as MRR and cash balance) so you
            can quickly scan the health of the portfolio without clicking into individual companies.
            Companies are displayed as cards with their most recently reported figures.
          </p>
          <p className="text-muted-foreground mb-2">
            Click any company card to open its detail page. The detail page shows historical metric
            charts, the Analyst summary, uploaded documents, and a notes panel. You can track how
            metrics have trended over time, upload supplementary documents (board decks, strategy memos,
            etc.) to give the AI more context, and generate or regenerate AI summaries on demand.
          </p>
          <p className="text-muted-foreground mb-2">
            At the top of each company page you&apos;ll see headline numbers and metadata like industry,
            stage, and any tags your team has applied. Admins can edit company details, add or remove
            metrics, and manage aliases (alternative names) that help the system match inbound emails
            to the right company.
          </p>
          <p className="text-muted-foreground">
            The dashboard also includes a shared notes section at the bottom where team members can post
            fund-level observations &mdash; market commentary, cross-portfolio themes, reminders for the
            next IC meeting, and so on. Each note belongs to an entity, and is read by the people who can see
            that entity.
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
            industry, and portfolio groups. Admins can click the edit button to update the company&apos;s
            name, aliases, stage, industry, founders, overview, and other details that give the AI more
            context for analysis.
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
            The company page also includes an <strong>Investments</strong> section that tracks the
            fund&apos;s transaction history with that company. You can record investment rounds (with
            date, round name, amount invested, shares acquired, and cost per share), proceeds from
            exits or distributions (including escrowed amounts), and unrealized gain changes (current
            share price updates). The section displays summary metrics &mdash; total invested, current
            fair market value, MOIC, and total realized &mdash; along with a detailed transaction
            table. Admins can add, edit, and delete transactions directly from this panel. For exited
            companies the FMV reflects total realized proceeds; for written-off companies it shows zero;
            and for active companies it uses the latest share price multiplied by total shares held.
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
            value was extracted with <strong>low confidence</strong>, a reporting period was ambiguous, or a metric
            couldn&apos;t be found in the report at all.
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

        <div id="inbound">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Inbound
          </h2>
          <p className="text-muted-foreground mb-2">
            Inbound shows every email that has been received and processed by the system. It&apos;s the
            audit trail for all automated report ingestion. Each row displays the sender, subject line,
            which company the email was matched to, and the <strong>processing status</strong> (success, needs review,
            failed, processing, or pending).
          </p>
          <p className="text-muted-foreground mb-2">
            You can filter the list by status and date range to quickly find specific emails. Filters
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
            Two actions are available at the bottom. <strong>Process Email</strong> lets you rerun the
            entire AI pipeline on this email &mdash; useful if you&apos;ve since added the company to
            your portfolio, updated metric definitions, or changed AI providers. It will replace any
            existing extracted metrics and review items with fresh results. If file storage is
            connected, a <strong>Save to File Storage</strong> button lets you manually push the email
            and its attachments to your Google Drive, organized into the appropriate company
            folder.
          </p>
        </div>

        <div id="import">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" />
            Import
          </h2>
          <p className="text-muted-foreground mb-2">
            Import lets you process reports manually when they arrive outside the normal email flow.
            You can paste email text directly, upload file attachments (PDFs, Excel spreadsheets, Word
            documents, PowerPoint decks, CSV files, and images up to 20 MB each), paste email text directly, or combine both. The system runs the
            same AI pipeline as automated inbound processing &mdash; identifying the company, extracting
            metrics, and writing results to the database.
          </p>
          <p className="text-muted-foreground mb-2">
            This is useful for several scenarios: reports received through Slack or other messaging tools,
            historical data you want to backfill from older files, reports forwarded from colleagues
            outside the authorized sender list, or situations where you want to re-extract data from a
            document with updated metrics definitions.
          </p>
          <p className="text-muted-foreground mb-2">
            When you submit an import, the system processes it identically to an inbound email. The
            result appears in the Inbound list with the same status tracking, and any flagged items
            show up in the Review queue. You can import multiple reports in sequence without waiting
            for each one to finish.
          </p>
          <p className="text-muted-foreground mb-2">
            You can also paste data that covers <strong>multiple companies</strong> at once &mdash; for example, rows copied
            from a spreadsheet or CSV file containing metrics across your portfolio. The system will parse
            the data, create new companies if they don&apos;t already exist, add new metrics as needed, and
            populate values for existing companies and metrics. This makes it easy to bulk import historical
            data or onboard an entire portfolio in one step.
          </p>
          <p className="text-muted-foreground mb-2">
            Additionally, you can paste <strong>investment transaction data</strong> &mdash; rounds, proceeds, valuations,
            and share prices &mdash; and the AI will parse the entries and match them to your portfolio
            companies. This is useful for bulk-importing cap table history, backfilling historical rounds,
            or onboarding an entire portfolio&apos;s investment data at once. Transactions are written to
            each company&apos;s Investments section automatically.
          </p>
          <p className="text-muted-foreground">
            Tip: for best results, include the company name and reporting period somewhere in the pasted
            text or attachment. The AI uses these cues to match the report to the correct company and
            assign the right period to extracted metrics.
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
            The <strong>email composer</strong> supports a customizable subject and HTML body. You can write a standard
            template that you reuse each quarter, or tailor messages for specific companies. Emails are
            sent through whichever outbound email provider your admin has configured (Gmail, Resend,
            Postmark, or Mailgun).
          </p>
          <p className="text-muted-foreground mb-2">
            Each request is logged with its recipient list, send timestamp, and delivery results. You
            can view past requests to see the full history of reporting asks. This is helpful for
            tracking which companies have been contacted and following up with those that haven&apos;t
            responded.
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
            Settings is where the platform is configured. Most settings are admin-only, but all users
            can update their display name (shown on notes and activity) and enable two-factor
            authentication for additional account security.
          </p>
          <p className="text-muted-foreground mb-2">
            For admins, Settings covers the full platform configuration: <strong>AI provider keys</strong> and model
            selection (Anthropic, OpenAI, and/or OpenRouter), the default AI provider
            for the fund, <strong>feature visibility</strong> controls, inbound email setup (Postmark or Mailgun), outbound email
            providers (Gmail, Resend, Postmark, or Mailgun), file storage connections (Google Drive),
            the AI summary prompt, and email templates for reporting asks.
          </p>
          <p className="text-muted-foreground mb-2">
            Admins also manage the <strong>authorized senders</strong> list (email addresses allowed to submit reports
            via the inbound pipeline), <strong>team members</strong> and their roles, and an allow-list that controls
            who can sign up for the platform. A danger zone at the bottom allows admins to permanently
            delete all fund data if needed.
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
            variables, encryption keys, email providers, deployment, and more &mdash; see the{' '}
            <a
              href="https://github.com/tdavidson/reporting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80"
            >
              README on GitHub
            </a>
            . It is the best reference for technical implementation details.
          </p>
        </div>

        <div id="notes">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Notes
          </h2>
          <p className="text-muted-foreground mb-2">
            Notes are available in three places: on each company&apos;s detail page, on the Portfolio
            dashboard, and on the dedicated Notes page. They provide a lightweight way for team members
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
            @mentioned. Each note shows the author, timestamp, and which company it belongs to (if any),
            with unread notes highlighted so you can quickly catch up on what you&apos;ve missed.
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
            You can choose to receive email notifications for all notes across the fund, only when you
            are @mentioned, or turn notifications off entirely. Company follows work alongside whichever
            level you choose &mdash; if you follow a company, you&apos;ll get notified about notes on
            that company regardless of your global setting.
          </p>
          <p className="text-muted-foreground">
            All notes show the author&apos;s display name and timestamp. Team members can edit or
            delete their own notes. Notes are visible to everyone on the team, so they work well as a
            lightweight internal communication tool alongside your existing workflows.
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
            The classification is automatic: emails from fund members are routed to the interaction pipeline,
            while emails from authorized senders (portfolio companies) continue through the existing metrics
            extraction pipeline. No manual tagging is required.
          </p>
          <p className="text-muted-foreground mb-2">
            For each interaction, the AI generates a short summary, detects whether the email contains an
            introduction between parties, and extracts the names and context of anyone being introduced.
            Interactions are linked to portfolio companies when possible, so you can see all conversations
            related to a specific company.
          </p>
          <p className="text-muted-foreground mb-2">
            The Interactions page shows all logged interactions across the fund, with filter tabs
            for <strong>All</strong> and <strong>Intros</strong>. Each entry shows the date, linked company,
            subject line, AI summary, and an intro badge when introductions were detected. Click the intro
            details to expand and see the names, emails, and context of introduced contacts.
          </p>
          <p className="text-muted-foreground mb-2">
            On each company&apos;s detail page, a <strong>Recent Interactions</strong> section shows the
            latest interactions for that company, with intro entries highlighted in a distinct style. A
            &ldquo;View all&rdquo; link takes you to the full interactions list filtered to that company.
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
            content-aware classifier that decides between four destinations: <strong>reporting</strong> (portfolio
            metrics), <strong>interactions</strong> (CRM-style emails from fund members),
            <strong>deals</strong> (a company pitching the fund), or <strong>other</strong> (newsletters,
            recruiter spam, vendor pitches). Sender identity is a strong signal but not a hard rule, so a
            partner forwarding a cold pitch lands in Deals where it belongs.
          </p>
          <p className="text-muted-foreground mb-2">
            For each pitch routed to Deals, a single AI call extracts company name, founder, intro source,
            referrer when applicable, stage, industry, raise size, a 100&ndash;150 word company summary, and a
            thesis-fit analysis with a fit score (strong, moderate, weak, out of thesis). Out-of-thesis pitches
            auto-archive and surface in a weekly digest email so partners can sanity-check without eyeballing
            every cold pitch. Founders can also submit pitches directly via a public form at a per-fund URL
            &mdash; admins generate or rotate the URL in Settings.
          </p>
          <p className="text-muted-foreground mb-2">
            The Deals page lists active pitches as a sortable table or a kanban board (drag-and-drop across
            status columns: new, reviewing, advancing, met, passed). Click a pitch to see the summary,
            thesis-fit analysis, source email, attachments, founders, intro source, and a deal-scoped Analyst
            chat that knows the pitch and your thesis.
          </p>
          <p className="text-muted-foreground">
            Settings &rarr; Deals controls the investment thesis, screening prompt, public submission token,
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
            per your rubric, and renders to Word or Google Docs. Each diligence record has tabs for Decision,
            Data Room (uploaded files), Diligence (external research), Partner Q&amp;A, and Memo (drafts).
          </p>
          <p className="text-muted-foreground mb-2">
            The agent is operated by <strong>seven YAML/MD configuration files</strong> (&ldquo;schemas&rdquo;)
            that admins edit per-fund through an in-app editor under Settings &rarr; Diligence &rarr; Schemas:
            instructions, rubric, qa_library, data_room_ingestion, research_dossier, memo_output, and
            style_anchors. The schema editor is a plain-text editor with inline YAML syntax validation and
            version history; rolling back to a prior version is one click. Defaults are seeded automatically
            the first time you open the editor, so you can run the agent immediately and customize as you go.
          </p>
          <p className="text-muted-foreground mb-2">
            <strong>Style Anchors</strong> are uploaded reference memos that teach the agent your firm&apos;s
            voice. Upload 3&ndash;8 prior memos in Settings &rarr; Diligence &rarr; Style Anchors, tag each
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
            per lead partner. Settings &rarr; Diligence &rarr; Defaults sets per-deal and monthly token caps
            (with current-month usage bar) and per-stage AI provider overrides &mdash; e.g. cheap model for
            ingest, stronger model for draft.
          </p>
        </div>

        <div id="investments">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            Investments
          </h2>
          <p className="text-muted-foreground mb-2">
            The Investments page provides a fund-level view of all investment transactions across your portfolio.
            It aggregates data from each company&apos;s individual Investments section into a single table,
            showing total invested, current fair market value (FMV), MOIC, and total realized across the entire fund.
          </p>
          <p className="text-muted-foreground mb-2">
            On each <strong>company detail page</strong>, the Investments section tracks the fund&apos;s transaction
            history with that specific company. You can record investment rounds (with date, round name, amount invested,
            shares acquired, and cost per share), proceeds from exits or distributions (including escrowed amounts),
            and unrealized gain changes (current share price updates). Summary metrics &mdash; total invested,
            current FMV, MOIC, and total realized &mdash; are displayed above the transaction table.
          </p>
          <p className="text-muted-foreground">
            Admins can add, edit, and delete transactions directly. For exited companies the FMV reflects total
            realized proceeds; for written-off companies it shows zero; and for active companies it uses the latest
            share price multiplied by total shares held. Investment data can also be bulk-imported via the
            Import page by pasting transaction data from a spreadsheet.
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
            funds it manages. It gets its own section rather than a row on the Funds page because it
            is a different kind of thing: it has no commitments, no NAV, no TVPI and no limited
            partners, so every column of a fund performance table would be a dash. Switch it on in
            Settings &rarr; Feature visibility, then add a vehicle of type{' '}
            <strong>Management company</strong>: its chart of accounts is there from creation. Members also
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
            is reflected without anyone having to amend a record as well.
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
            When you&apos;re satisfied with the letter, export it as a .docx file for final formatting
            and distribution. If Google Drive is connected, you can export directly to Drive.
          </p>
        </div>

        <div id="lps">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Crown className="h-4 w-4 text-muted-foreground" />
            LPs
          </h2>
          <p className="text-muted-foreground mb-2">
            LPs helps you track and report on your limited partner positions across snapshots. Each
            snapshot represents LP positions at a point in time &mdash; typically a quarter-end. The
            LPs index page lists all snapshots; click one to view investor data, summary cards, and
            the full investor table.
          </p>
          <p className="text-muted-foreground mb-2">
            To get data in, create a new snapshot and paste spreadsheet content into the <strong>import dialog</strong>.
            AI automatically matches columns to fields like investor name, entity, commitment, paid-in
            capital, distributions, NAV, DPI, RVPI, TVPI, and IRR. Investors, entities, and investments
            are created or updated automatically, and rows with zero commitment and no financial data
            are filtered out.
          </p>

          <p className="text-muted-foreground mb-2">
            The snapshot detail page shows all investors with aggregated metrics. Expand an investor
            to see individual entity and portfolio group line items. All values are <strong>inline-editable</strong>:
            click a row to edit metrics, or click an investor name to rename. Investors can be grouped
            under a parent for consolidated reporting, and duplicate investors can be merged together.
            When a snapshot has multiple portfolio groups, a <strong>portfolio group filter</strong> appears in the header to include
            or exclude specific groups from the view and totals.
          </p>
          <p className="text-muted-foreground mb-2">
            Each snapshot can have its own <strong>report header and footer</strong>, configured via the Settings button.
            These appear on individual investor PDFs and batch exports. Click the document icon on any
            investor row to view their <strong>individual report</strong>, which includes a capital summary table, a
            performance metrics table, and a narrative summary of total invested, distributions, and
            current value. The &ldquo;Batch PDFs&rdquo; button generates all selected investor reports
            at once and downloads them as a ZIP file of individual PDFs. You can also <strong>export to Excel</strong> with
            all investors, entities, portfolio groups, and metrics.
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
            quarter independently, so you can track and dismiss them separately. Certain <strong>event-driven</strong> filings
            like Form D and Blue Sky appear only in the months where your fund has committed
            capital entries, derived automatically from your fund cash flows data.
          </p>
          <p className="text-muted-foreground mb-2">
            When you finish a filing, mark it as done by <strong>dismissing</strong> it for the year or quarter. You can
            filter the view between active items, dismissed items, or all items to see what&apos;s been
            completed and what remains. An <strong>all items</strong> view provides a comprehensive list of every compliance
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
            Usage is an <strong>admin-only</strong> page that shows how your fund is consuming AI tokens
            and how team members are using the platform.
          </p>
          <p className="text-muted-foreground mb-2">
            The top section displays <strong>AI token usage</strong> broken down by provider (Anthropic,
            OpenAI, and/or OpenRouter), with month-to-date totals for input tokens, output tokens, and estimated cost.
            A daily breakdown table shows usage by model, so you can see exactly where tokens are being
            spent &mdash; email processing, metric extraction, company identification, summaries, or
            analyst conversations.
          </p>
          <p className="text-muted-foreground">
            The bottom section shows <strong>team activity</strong>: a summary of actions per team member
            (logins, company updates, imports, notes, reviews resolved) and a recent activity feed with
            timestamps. This gives admins visibility into how the platform is being used across the team.
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
            On <strong>portfolio-wide pages</strong> (Portfolio, Investments, Asks, Notes), the Analyst has
            access to fund-level data across the companies and entities you can see &mdash; investment amounts, FMV, MOIC, and your
            team&apos;s discussion notes. Use it to compare companies, get portfolio-level insights, or ask
            about cross-portfolio trends and themes.
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
            delete old conversations from the history list. If your fund has both Anthropic and OpenAI
            configured, a model selector lets you choose which AI to use.
          </p>
          <p className="text-muted-foreground">
            The Analyst can also save its responses directly as company summaries using the &ldquo;Save
            as Summary&rdquo; button that appears below each response on company pages. This lets you
            use the chat to iteratively refine a summary and then commit it to the company&apos;s record
            with one click.
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
              <li>In ChatGPT, open <strong>Plugins</strong>, choose <strong>+</strong>, then <strong>Add custom MCP server</strong>; paste the URL and create it as a plugin.</li>
              <li>Connect, sign in to your fund and approve.</li>
            </ol>
            <p className="text-muted-foreground mt-1">
              For the skills in the ChatGPT desktop app or Codex, download <strong>Plugin for ChatGPT</strong>,
              unzip it into <code className="font-mono text-xs">~/.agents/plugins/</code>, list it in 
              <code className="font-mono text-xs">~/.agents/plugins/marketplace.json</code> and restart the app
              (DOCS.md has the exact entry).
            </p>
          </div>
          <p className="text-muted-foreground">
            The plugin is built for your own deployment&rsquo;s address and contains no key and no data. You
            choose read, or read and change, when you approve; revoking it or switching Agent access off
            stops it at once. Ask the assistant to <em>save this dashboard</em> to reopen it later, in either
            assistant, always on current figures.
          </p>
        </div>

        <div id="file-handling">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            File Handling &amp; Security
          </h2>
          <p className="text-muted-foreground mb-2">
            The platform accepts a wide range of file types for processing: PDFs, Excel spreadsheets
            (.xlsx, .xls), Word documents (.docx), PowerPoint presentations (.pptx), CSV files, and
            images (PNG, JPEG, GIF, WebP). Files can be uploaded through the Import page, attached to
            inbound emails, or uploaded directly to a company&apos;s documents section.
          </p>
          <p className="text-muted-foreground mb-2">
            Individual file uploads are limited to <strong>20 MB per file</strong>. This applies
            to both manual uploads and email attachments. For larger files (such as high-resolution board
            decks or extensive spreadsheets), consider splitting them into smaller parts, compressing images,
            or exporting to a more compact format before uploading. The AI processing pipeline works best
            with focused, well-structured documents rather than very large omnibus files.
          </p>
          <p className="text-muted-foreground mb-2">
            The system extracts <strong>text content</strong> from uploaded files to make
            them available to the AI for analysis and metric extraction. PDFs and Office documents have
            their text extracted server-side. Images are processed using the AI&apos;s <strong>vision capabilities</strong> to
            read charts, tables, and text directly from screenshots or photos of reports.
          </p>
          <p className="text-muted-foreground mb-2">
            The platform does not currently include built-in antivirus or <strong>malware scanning</strong> of uploaded
            files. Files are stored in your configured storage provider (Supabase Storage or Google
            Drive), which may provide their own scanning capabilities depending on your plan and
            configuration. If your organization requires virus scanning, we recommend configuring it at
            the storage provider level or scanning files before uploading them to the platform.
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
            <strong>Row-level security</strong> policies ensure that users can only see data belonging to their fund.
            File content sent to AI providers (Anthropic or OpenAI) for processing is subject to those
            providers&apos; <strong>data handling policies</strong> &mdash; refer to their documentation for details on
            data retention and usage.
          </p>
        </div>

        <div id="updates">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <ArrowDownCircle className="h-4 w-4 text-muted-foreground" />
            Updates
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
            shown at the bottom of the Updates page. Only admins can see the Updates page; non-admin users
            are not shown the update indicator.
          </p>
        </div>

        <div id="sidebar">
          <h2 className="text-base font-medium mb-2 flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
            Theme &amp; Sidebar
          </h2>
          <p className="text-muted-foreground mb-2">
            At the bottom of the sidebar you&apos;ll find two utility controls. The theme toggle cycles
            between System, Light, and Dark modes. System mode follows your operating system&apos;s
            preference, so if your OS switches to dark mode at night, the platform will follow
            automatically.
          </p>
          <p className="text-muted-foreground">
            Below the theme toggle is the sidebar collapse button. Collapsing the sidebar reduces it
            to a narrow icon-only strip, giving you more horizontal space for content &mdash; especially
            useful on smaller screens or when viewing wide metric charts. Click the button again to
            expand the sidebar back to its full width. On mobile, the sidebar opens as a slide-over
            overlay and closes when you navigate or tap outside it.
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
