-- Teams-plan model signal: the per-user/day "most used model" from Cursor's
-- daily-usage-data (Admin API, Teams plan). It's a weaker signal than the
-- Enterprise model-usage analytics (one top model per user/day, no per-model
-- message counts), but it lets the Cursor Usage page show real adoption on the
-- Teams plan instead of an "Enterprise only" wall.

create table cursor_top_model (
  id            uuid primary key default gen_random_uuid(),
  day           date not null,
  entity_key    text not null,        -- user email, lowercased
  model         text not null,        -- the user's most-used model that day
  employee_id   uuid references employees(id),
  created_at    timestamptz not null default now(),
  unique (day, entity_key)            -- one top model per user/day; idempotent upsert
);

create index cursor_top_model_day_idx      on cursor_top_model (day);
create index cursor_top_model_employee_idx on cursor_top_model (employee_id);

alter table cursor_top_model enable row level security;
grant all on public.cursor_top_model to service_role;
