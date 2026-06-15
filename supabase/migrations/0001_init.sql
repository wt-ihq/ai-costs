-- ai-costs initial schema
-- Mirrors docs/superpowers/specs/2026-06-11-ai-spend-dashboard-design.md §5.
-- Design notes:
--   * Single spend_facts table; cost_type keeps seat/overage/metered visible.
--   * All fact writes are upserts keyed on (source, day, entity) -> idempotent.
--   * Leavers and unmatched identities are retained, never deleted.

create type vendor       as enum ('cursor', 'anthropic', 'openai', 'claude_team', 'chatgpt_business');
create type cost_type    as enum ('seat', 'overage', 'metered');
create type match_method as enum ('exact_email', 'alias_rule', 'manual', 'unmatched');
create type sync_status  as enum ('running', 'success', 'failed');

-- HiBob is the identity spine for every join.
create table employees (
  id                 uuid primary key default gen_random_uuid(),
  hibob_id           text unique not null,
  email              text unique not null,
  full_name          text not null,
  department         text,
  site               text,
  employment_status  text,            -- active | leaver | ...
  start_date         date,
  leave_date         date,            -- retained after leaving; spend keeps attribution
  synced_at          timestamptz not null default now()
);

-- (vendor, external id) -> employee, with how the match was made.
create table identities (
  id                 uuid primary key default gen_random_uuid(),
  vendor             vendor not null,
  external_email     text,
  external_id        text,
  employee_id        uuid references employees(id),  -- null => "Unmatched" bucket
  match_method       match_method not null default 'unmatched',
  created_at         timestamptz not null default now(),
  unique (vendor, external_email),
  unique (vendor, external_id)
);

-- Vendor API key registry (and projects/workspaces share this shape).
create table api_keys (
  id                  uuid primary key default gen_random_uuid(),
  vendor              vendor not null,
  external_key_id     text not null,
  name                text,
  created_by_email    text,
  owner_employee_id   uuid references employees(id),  -- derived from created_by
  owner_override      uuid references employees(id),  -- wins when set; no UI in v1
  unique (vendor, external_key_id)
);

create table projects (
  id                  uuid primary key default gen_random_uuid(),
  vendor              vendor not null,
  external_id         text not null,   -- OpenAI project / Anthropic workspace
  name                text,
  created_by_email    text,
  owner_employee_id   uuid references employees(id),
  owner_override      uuid references employees(id),
  unique (vendor, external_id)
);

-- One row per (source, day, grain entity). The single fact table.
create table spend_facts (
  id            uuid primary key default gen_random_uuid(),
  source        vendor not null,
  day           date not null,
  cost_type     cost_type not null,
  entity_key    text not null,        -- the grain key (user email, key id, project id, seat id)
  cost_usd      numeric(14,4) not null default 0,
  tokens        bigint,
  requests      bigint,
  employee_id   uuid references employees(id),
  api_key_id    uuid references api_keys(id),
  project_id    uuid references projects(id),
  model         text,
  created_at    timestamptz not null default now(),
  -- idempotency: re-running a sync upserts instead of duplicating
  unique (source, day, cost_type, entity_key, model)
);

create index spend_facts_day_idx        on spend_facts (day);
create index spend_facts_employee_idx   on spend_facts (employee_id);
create index spend_facts_source_idx     on spend_facts (source);

-- Seat assignments generate monthly seat-cost facts; prices are admin config.
create table seat_assignments (
  id                 uuid primary key default gen_random_uuid(),
  vendor             vendor not null,
  employee_id        uuid references employees(id),
  seat_type          text not null,
  monthly_price_usd  numeric(10,2) not null,
  period_start       date not null,
  period_end         date,
  unique (vendor, employee_id, seat_type, period_start)
);

-- Small admin-maintained pricing config (vendors don't expose negotiated prices).
create table seat_prices (
  vendor             vendor not null,
  seat_type          text not null,
  monthly_price_usd  numeric(10,2) not null,
  primary key (vendor, seat_type)
);
insert into seat_prices (vendor, seat_type, monthly_price_usd) values
  ('chatgpt_business', 'business', 25.00),
  ('claude_team',      'team',     30.00),
  ('cursor',           'teams',    40.00);

-- ChatGPT Business credits -> USD conversion rate (admin-configured).
create table credit_rates (
  vendor             vendor not null,
  usd_per_credit     numeric(12,6) not null,
  effective_from     date not null,
  primary key (vendor, effective_from)
);

-- Audit: every automated pull.
create table sync_runs (
  id            uuid primary key default gen_random_uuid(),
  source        vendor not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        sync_status not null default 'running',
  rows_written  integer not null default 0,
  error_detail  text
);

-- Audit: every manual upload/entry.
create table imports (
  id            uuid primary key default gen_random_uuid(),
  source        vendor not null,
  kind          text not null,        -- 'csv' | 'clipboard' | 'manual'
  file_name     text,
  data_as_of    date not null,        -- staleness is computed from this
  status        sync_status not null default 'running',
  row_counts    jsonb,
  errors        jsonb,
  created_by    text,
  created_at    timestamptz not null default now()
);

-- Raw API payloads retained pre-normalization, so a normalizer fix can be
-- replayed without re-fetching (spec §6).
create table raw_payloads (
  id            uuid primary key default gen_random_uuid(),
  source        vendor not null,
  sync_run_id   uuid references sync_runs(id),
  fetched_at    timestamptz not null default now(),
  payload       jsonb not null
);
