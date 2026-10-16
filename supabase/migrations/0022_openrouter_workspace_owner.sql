-- An OpenRouter workspace's shared-key spend (workspace-owned API keys, no member) can belong to a person,
-- set on Data → Tools; without an owner it stays on the workspace's department as before.
-- Apply BEFORE deploying: the OpenRouter sync and the Tools tab read this column.
alter table openrouter_workspaces
  add column if not exists owner_employee_id uuid references employees(id) on delete set null;
