-- Cursor service accounts: a name and a team for each automation account (Bugbot, background
-- agents, the CLI in CI), so its person-less spend counts toward a team. Set on Data → Tools;
-- new accounts are registered by the nightly Cursor sync.
-- Apply BEFORE deploying: the Cursor sync reads and writes this table on every run.

create table if not exists cursor_service_accounts (
  account_id  text primary key,        -- Cursor's id, "sa_…" (spend_facts.entity_key = 'cursor service account ' || account_id)
  label       text,                    -- e.g. "Bugbot"; null = unnamed
  department  text,                    -- the team its spend counts toward; null = Unattributed
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table cursor_service_accounts enable row level security;

-- Bugbot (Cursor's GitHub code review) counts toward Engineering, history included.
insert into cursor_service_accounts (account_id, label, department, updated_by)
values ('sa_6088564e-d3d3-43b0-a166-957eb316d402', 'Bugbot', 'Engineering', 'migration 0025')
on conflict (account_id) do update set label = excluded.label, department = excluded.department, updated_by = excluded.updated_by, updated_at = now();

update spend_facts
set department = 'Engineering'
where source = 'cursor'
  and entity_key = 'cursor service account sa_6088564e-d3d3-43b0-a166-957eb316d402'
  and employee_id is null
  and department is distinct from 'Engineering';
