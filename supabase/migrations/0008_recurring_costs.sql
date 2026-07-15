-- NOTE (prod apply): run the ALTER TYPE line as its OWN statement first —
-- Postgres cannot mix "ALTER TYPE ... ADD VALUE" with other statements in
-- one transaction.
alter type vendor add value 'other';

-- Fact-level department attribution: recurring tool costs have no employee.
alter table spend_facts add column department text;

-- Source of truth for manual recurring/amortized tool costs. Facts with
-- source='other' are derived from this table and fully rebuilt from it.
create table recurring_costs (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,            -- display name; identity = lower(tool)
  color_slot  integer not null check (color_slot between 0 and 7),
  department  text,                     -- null => Unattributed
  kind        text not null check (kind in ('monthly', 'contract')),
  amount      numeric not null check (amount >= 0),  -- per month (monthly) or total (contract)
  currency    text not null default 'USD' check (currency in ('USD', 'GBP', 'EUR')),
  fx_rate     numeric not null default 1 check (fx_rate > 0),
  start_month date not null,            -- YYYY-MM-01
  end_month   date,                     -- inclusive month; required for 'contract' (app-enforced)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
