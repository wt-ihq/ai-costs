create table if not exists notification_recommendation_recipients (
  employee_id uuid primary key references employees(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
alter table notification_recommendation_recipients enable row level security;
grant all on public.notification_recommendation_recipients to service_role;
alter table notification_sends drop constraint if exists notification_sends_report_check;
alter table notification_sends
  add constraint notification_sends_report_check check (report in ('personal', 'company', 'reminder', 'recommendations'));
