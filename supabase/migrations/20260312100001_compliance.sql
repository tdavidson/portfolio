-- Compliance module tables

-- Fund compliance profile (intake questionnaire answers)
create table if not exists fund_compliance_profile (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id) on delete cascade unique not null,
  registration_status text, -- ria, era, not_registered, unsure
  aum_range text,
  fund_structure text,
  fundraising_status text,
  reg_d_exemption text,
  investor_state_count text,
  california_nexus text[], -- multi-select
  public_equity text,
  cftc_activity text,
  access_person_count text,
  has_foreign_entities text, -- yes, no
  completed_at timestamptz,
  updated_at timestamptz default now(),
  updated_by uuid,
  created_at timestamptz default now()
);

-- Compliance items (seed/reference data)
create table if not exists compliance_items (
  id text primary key,
  category text not null,
  name text not null,
  short_name text not null,
  description text not null,
  frequency text not null,
  deadline_description text not null,
  deadline_month int,
  deadline_day int,
  rolling_days int,
  applicability_text text not null,
  applicability_question text not null,
  filing_system text not null,
  filing_portal_url text,
  regulation_url text,
  form_instructions_url text,
  complexity text not null default 'medium',
  data_fields jsonb default '[]'::jsonb,
  notes text,
  alert text,
  sort_order int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Per-fund applicability settings
create table if not exists compliance_fund_settings (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id) on delete cascade not null,
  compliance_item_id text references compliance_items(id) on delete cascade not null,
  applies text, -- yes, no, unsure
  dismissed boolean default false,
  dismissed_reason text,
  dismissed_by uuid,
  dismissed_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(fund_id, compliance_item_id)
);

-- Annual deadline instances
create table if not exists compliance_deadlines (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id) on delete cascade not null,
  compliance_item_id text references compliance_items(id) on delete cascade not null,
  year int not null,
  due_date date,
  status text not null default 'upcoming', -- upcoming, in_progress, under_review, filed, extended, overdue, not_applicable
  filed_date date,
  filed_by uuid,
  filing_reference_url text,
  extension_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(fund_id, compliance_item_id, year)
);

-- Workflow steps for deadline items
create table if not exists compliance_workflows (
  id uuid primary key default gen_random_uuid(),
  deadline_id uuid references compliance_deadlines(id) on delete cascade not null,
  step_number int not null,
  actor_role text not null,
  action_description text not null,
  assigned_to uuid,
  status text not null default 'pending', -- pending, in_progress, waiting_review, complete, blocked
  completed_at timestamptz,
  completed_by uuid,
  notes text,
  due_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Historical filing records
create table if not exists compliance_filings (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid references funds(id) on delete cascade not null,
  compliance_item_id text references compliance_items(id) on delete cascade not null,
  filing_date date not null,
  filing_url text,
  filing_reference text,
  filing_type text,
  document_storage_key text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Form field data for each deadline
create table if not exists compliance_entry_data (
  id uuid primary key default gen_random_uuid(),
  deadline_id uuid references compliance_deadlines(id) on delete cascade not null,
  field_key text not null,
  field_value text,
  source text default 'manual', -- manual, imported, computed
  source_reference text,
  updated_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(deadline_id, field_key)
);

-- RLS policies
alter table fund_compliance_profile enable row level security;
alter table compliance_items enable row level security;
alter table compliance_fund_settings enable row level security;
alter table compliance_deadlines enable row level security;
alter table compliance_workflows enable row level security;
alter table compliance_filings enable row level security;
alter table compliance_entry_data enable row level security;

-- compliance_items is reference data, readable by all authenticated users
create policy "compliance_items_read" on compliance_items for select to authenticated using (true);

-- fund-scoped tables: readable by fund members via service role (API routes use admin client)
create policy "fund_compliance_profile_service" on fund_compliance_profile for all to service_role using (true);
create policy "compliance_fund_settings_service" on compliance_fund_settings for all to service_role using (true);
create policy "compliance_deadlines_service" on compliance_deadlines for all to service_role using (true);
create policy "compliance_workflows_service" on compliance_workflows for all to service_role using (true);
create policy "compliance_filings_service" on compliance_filings for all to service_role using (true);
create policy "compliance_entry_data_service" on compliance_entry_data for all to service_role using (true);
