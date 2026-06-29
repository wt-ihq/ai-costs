-- Switch the identity spine from HiBob to Okta.
--
-- Not everyone is in HiBob, but everyone is in Okta (SSO), so Okta becomes the
-- source of users + teams (team = the Okta user-profile `department` field).
-- Attribution is unchanged — it has always joined on `email`, never on the
-- vendor id — so this is purely additive at the column level:
--   * `hibob_id` is kept for historical reference but is no longer required
--     (Okta-only users have none), so drop its NOT NULL.
--   * `okta_id` is the new external key (unique; NULLs allowed for legacy rows
--     not yet seen in Okta).

alter table employees alter column hibob_id drop not null;
alter table employees add column if not exists okta_id text;
create unique index if not exists employees_okta_id_key on employees (okta_id);

comment on table employees is 'Identity spine for every join. Sourced from Okta (was HiBob); attribution matches on email.';
