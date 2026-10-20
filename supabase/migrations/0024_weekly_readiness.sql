-- Weekly readiness, Claude Team in the weekly summary, Monday reminders
-- (spec: docs/superpowers/specs/2026-10-20-weekly-readiness-design.md).
-- Apply BEFORE deploying: the paste saves snapshots, the cron reads reminder recipients and
-- writes notification_sends.report = 'reminder'. Inserts and schema only; nothing is deleted.

-- Every Claude Team month-to-date paste, kept so a week's spend is the change between pastes.
create table if not exists claude_spend_snapshots (
  as_of        date not null,          -- the paste's date; its month is the month it belongs to
  email        text not null,
  employee_id  uuid references employees(id) on delete set null,
  mtd_gbp      numeric(12,2),          -- null only for rows seeded from old facts
  usd_per_gbp  numeric(12,6),          -- null only for rows seeded from old facts
  mtd_usd      numeric(12,2) not null,
  created_by   text,
  created_at   timestamptz not null default now(),
  primary key (as_of, email)
);
alter table claude_spend_snapshots enable row level security;

-- Seed: each stored month-to-date fact (one per person per month, dated the 1st) becomes a snapshot
-- as of that month's latest successful paste, else the month's last day (today for this month).
insert into claude_spend_snapshots (as_of, email, employee_id, mtd_usd, created_by)
select
  coalesce(
    (select max(i.data_as_of) from imports i
      where i.source = 'claude_team' and i.kind = 'clipboard' and i.status = 'success'
        and date_trunc('month', i.data_as_of) = date_trunc('month', f.day)),
    least((date_trunc('month', f.day) + interval '1 month - 1 day')::date, current_date)
  ),
  f.entity_key, f.employee_id, f.cost_usd, 'migration 0024'
from spend_facts f
where f.source = 'claude_team' and f.cost_type = 'overage' and extract(day from f.day) = 1 and f.cost_usd > 0
on conflict (as_of, email) do nothing;

-- Who gets the Monday "weekly updates" reminder and the month-end Claude Team reminder.
create table if not exists notification_reminder_recipients (
  employee_id uuid primary key references employees(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
alter table notification_reminder_recipients enable row level security;

-- Reminders are claimed in the send log like digests (never twice).
alter table notification_sends drop constraint if exists notification_sends_report_check;
alter table notification_sends
  add constraint notification_sends_report_check check (report in ('personal', 'company', 'reminder'));
