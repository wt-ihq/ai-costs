-- Slack digest opens: the first click on a digest's "Open in dashboard" button
-- (/api/digest/open/<send id>) stamps its send. Admin-only (Data → Notifications).
-- Apply BEFORE deploying — the send log and the open route read it.
alter table notification_sends add column if not exists opened_at timestamptz;
comment on column notification_sends.opened_at is 'First "Open in dashboard" click on this digest (null = not opened).';
