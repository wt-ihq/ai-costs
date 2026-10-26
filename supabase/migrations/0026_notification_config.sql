-- Slack digest mode chosen on Data → Notifications
-- (docs/superpowers/specs/2026-10-26-notification-controls-design.md).
-- One row, key 'mode', value off|preview|live. No row = SLACK_NOTIFY_MODE decides.
-- Apply BEFORE deploying: the hourly notify cron and the admin page read it.
create table notification_config (
  key        text primary key,
  value      text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

alter table notification_config enable row level security;
grant all on public.notification_config to service_role;
