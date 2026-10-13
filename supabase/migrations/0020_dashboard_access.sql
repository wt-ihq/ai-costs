-- Dashboard access list. Admins (ADMIN_EMAILS) always get in; anyone else signing in only when listed here
-- (managed on Data → Access). Slack digests show their dashboard button and links only to the same people.
-- Apply BEFORE deploying: every dashboard page reads this table (unreadable = admins only), and the notify
-- cron writes notification_sends.dashboard_link on every send.
create table if not exists dashboard_access (
  email     text primary key check (email = lower(email)),
  added_by  text not null,
  added_at  timestamptz not null default now()
);
alter table dashboard_access enable row level security;
grant all on public.dashboard_access to service_role;

-- Whether a sent digest carried the "Open in dashboard" button, so the open rate counts only those.
-- Every send before this had one.
alter table notification_sends
  add column if not exists dashboard_link boolean not null default true;
