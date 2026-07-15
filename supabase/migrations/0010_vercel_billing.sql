-- NOTE (prod apply): run the ALTER TYPE line as its OWN statement first.
alter type vendor add value 'vercel';

-- Project -> department mapping for Vercel billing attribution. Projects
-- auto-register on each sync (name refreshed, department never touched);
-- admins assign departments on the Imports page.
create table vercel_projects (
  id           uuid primary key default gen_random_uuid(),
  project_id   text not null unique,
  project_name text not null,
  department   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
