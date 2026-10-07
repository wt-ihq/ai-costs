-- Fixed costs in Slack digests (docs/superpowers/specs/2026-10-07-digest-fixed-costs-design.md).
-- Whether digests count seats & subscriptions: an organisation default
-- (scope 'org', scope_key ''), overridden per team ('department', the Okta
-- department name), overridden per person ('employee', the employee id).
-- No org row = exclude. Apply BEFORE deploying — every digest run reads it.
create table notification_settings (
  scope         text not null check (scope in ('org', 'department', 'employee')),
  scope_key     text not null,
  include_fixed boolean not null,
  updated_by    text not null,
  updated_at    timestamptz not null default now(),
  primary key (scope, scope_key),
  check ((scope = 'org') = (scope_key = ''))
);

alter table notification_settings enable row level security;
grant all on public.notification_settings to service_role;
