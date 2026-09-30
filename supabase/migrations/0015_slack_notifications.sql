-- Slack spend digests (docs/superpowers/specs/2026-09-30-slack-spend-digests-design.md).
--
-- Reporting tree inputs: Okta's raw profile.managerId, stored as-is and
-- resolved at read time against okta_id / email / employee_number (whichever
-- the tenant uses) — never a stored manager FK that could go stale.
alter table employees add column if not exists manager_ref text;
alter table employees add column if not exists employee_number text;
comment on column employees.manager_ref is 'Raw Okta profile.managerId; resolved at read time (src/lib/notify/tree.ts).';
comment on column employees.employee_number is 'Okta profile.employeeNumber; a possible target of manager_ref.';

-- The pilot allowlist: no row, no message. One row per cadence.
create table notification_subscriptions (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);

-- Send log + idempotency guard. A row is claimed (pending) BEFORE any Slack
-- call; the unique key makes a re-run skip anything already handled. `mode`
-- is in the key so preview runs never count as live sends.
create table notification_sends (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  period_key  text not null,
  mode        text not null check (mode in ('preview', 'live')),
  status      text not null check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts    integer not null default 1,
  slack_ts    text,
  detail      text, -- skip/failure reason; never names or amounts
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, cadence, period_key, mode)
);
create index notification_sends_updated_at_idx on notification_sends (updated_at desc);
create index notification_sends_pending_idx on notification_sends (updated_at) where status = 'pending';

-- users.lookupByEmail cache. slack_user_id null = looked up, not found.
-- Separate from employees so the nightly Okta upsert never touches it.
create table slack_users (
  employee_id   uuid primary key references employees(id) on delete cascade,
  slack_user_id text,
  looked_up_at  timestamptz not null default now()
);

alter table notification_subscriptions enable row level security;
grant all on public.notification_subscriptions to service_role;
alter table notification_sends enable row level security;
grant all on public.notification_sends to service_role;
alter table slack_users enable row level security;
grant all on public.slack_users to service_role;
