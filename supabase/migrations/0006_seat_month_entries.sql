-- supabase/migrations/0006_seat_month_entries.sql
-- Manual monthly seat entries: the authoritative seats × price total for a
-- month. The paste import only distributes attribution across people.
create table seat_month_entries (
  id          uuid primary key default gen_random_uuid(),
  vendor      vendor not null,
  month       date not null,           -- always YYYY-MM-01
  seats       integer not null check (seats >= 0),
  price_usd   numeric not null check (price_usd >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vendor, month)
);
