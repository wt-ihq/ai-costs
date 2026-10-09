-- Company AI spend report (spec: docs/superpowers/specs/2026-10-09-company-report-design.md).
-- Who gets the whole-company report, on which cadences. Separate from notification_subscriptions,
-- so that table's key (and the running code's upsert on it) is untouched.
-- Apply BEFORE deploying: the cron reads this table and writes notification_sends.report on every run.
create table if not exists notification_company_recipients (
  employee_id uuid not null references employees(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (employee_id, cadence)
);
alter table notification_company_recipients enable row level security;

-- Which DM a send was. Existing rows, and the code running until the deploy, are personal.
alter table notification_sends
  add column if not exists report text not null default 'personal' check (report in ('personal', 'company'));
alter table notification_sends drop constraint if exists notification_sends_employee_id_cadence_period_key_mode_key;
alter table notification_sends
  add constraint notification_sends_employee_cadence_period_mode_report_key unique (employee_id, cadence, period_key, mode, report);
