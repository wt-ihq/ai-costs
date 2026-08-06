-- OpenRouter workspace -> department mapping. Workspaces auto-register on
-- each sync (name refreshed, department never touched after creation);
-- department is PREFILLED with the workspace name on first sight — the org's
-- workspaces are named after departments — and admins correct exceptions on
-- the Data page. Usage from workspace-owned API keys (no user attached)
-- attributes to the mapped department.
create table openrouter_workspaces (
  id           uuid primary key default gen_random_uuid(),
  workspace_id text not null unique,
  name         text not null,
  department   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
