-- Admins can be added on Data → Access, besides those in ADMIN_EMAILS: each listed person is a viewer or an admin.
-- Everyone already listed stays a viewer. Apply BEFORE deploying: every page load reads this column, and without
-- it the list reads as unreadable — everyone but the ADMIN_EMAILS admins is shown "no access".
alter table dashboard_access
  add column if not exists role text not null default 'viewer' check (role in ('viewer', 'admin'));
