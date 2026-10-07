-- Slack digests go out at 10:30 in each recipient's own time zone
-- (src/lib/notify/schedule.ts sendDay). users.lookupByEmail returns the zone
-- alongside the id, so it's cached here and refreshed weekly with it.
-- Apply BEFORE deploying the code that writes it (saveSlackUser).
alter table slack_users add column if not exists tz text;
comment on column slack_users.tz is 'Slack IANA time zone (users.lookupByEmail), e.g. Europe/London; null = unknown → London.';
