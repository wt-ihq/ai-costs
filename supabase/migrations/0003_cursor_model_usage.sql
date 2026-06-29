-- Cursor Analytics API — by-user model usage (ADOPTION, not spend).
-- Source: GET https://api.cursor.com/analytics/by-user/models
--   data: { "<email>": [ { date, model_breakdown: { "<model>": { messages, users } } } ] }
--
-- This is message-volume per (day, user, model). There are NO dollars here, so
-- it lives in its own table rather than spend_facts — mixing message counts
-- into the cost layer would corrupt every $ rollup. It joins to employees on
-- employee_id exactly like spend_facts, so the company → team → person
-- drill-down works identically.

create table cursor_model_usage (
  id            uuid primary key default gen_random_uuid(),
  day           date not null,
  entity_key    text not null,        -- user email, lowercased
  model         text not null,        -- e.g. 'claude-sonnet-4.5', 'gpt-4o', 'auto'
  messages      bigint not null default 0,
  employee_id   uuid references employees(id),  -- null => "Unmatched" bucket
  created_at    timestamptz not null default now(),
  -- idempotency: re-running a window upserts instead of duplicating. We upsert
  -- (never delete-then-insert) so a transient empty API response can't wipe a
  -- day's adoption history. 'users' from the API is always 1 at this grain, so
  -- it's dropped; distinct-user counts are derived by counting employee_ids.
  unique (day, entity_key, model)
);

create index cursor_model_usage_day_idx      on cursor_model_usage (day);
create index cursor_model_usage_employee_idx on cursor_model_usage (employee_id);
create index cursor_model_usage_model_idx    on cursor_model_usage (model);

-- Access model mirrors 0001: server-side only via the service-role key. Enable
-- RLS with no policies so the public/anon roles can never read this data.
alter table cursor_model_usage enable row level security;
grant all on public.cursor_model_usage to service_role;
