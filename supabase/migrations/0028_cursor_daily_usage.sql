-- Teams-plan usage detail: the whole per-user/day row from Cursor's
-- daily-usage-data (Admin API) — requests by kind, lines, accepts/rejects,
-- tab completions, Bugbot uses, top model and client version. Written
-- best-effort by the nightly Cursor sync; cursor_top_model keeps only the model.

create table cursor_daily_usage (
  id                         uuid primary key default gen_random_uuid(),
  day                        date not null,
  entity_key                 text not null,        -- user email, lowercased
  employee_id                uuid references employees(id),
  is_active                  boolean not null default false,
  agent_requests             integer not null default 0,
  subscription_included_reqs integer not null default 0,
  usage_based_reqs           integer not null default 0,
  api_key_reqs               integer not null default 0,
  total_lines_added          integer not null default 0,
  total_lines_deleted        integer not null default 0,
  accepted_lines_added       integer not null default 0,
  accepted_lines_deleted     integer not null default 0,
  total_accepts              integer not null default 0,
  total_rejects              integer not null default 0,
  total_applies              integer not null default 0,
  total_tabs_shown           integer not null default 0,
  total_tabs_accepted        integer not null default 0,
  bugbot_usages              integer not null default 0,
  most_used_model            text,
  client_version             text,
  created_at                 timestamptz not null default now(),
  unique (day, entity_key)                         -- one row per user/day; idempotent upsert
);

create index cursor_daily_usage_day_idx      on cursor_daily_usage (day);
create index cursor_daily_usage_employee_idx on cursor_daily_usage (employee_id);

alter table cursor_daily_usage enable row level security;
grant all on public.cursor_daily_usage to service_role;
