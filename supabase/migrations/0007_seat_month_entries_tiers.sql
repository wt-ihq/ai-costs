-- supabase/migrations/0007_seat_month_entries_tiers.sql
-- Per-tier monthly entries (Claude standard/premium) + GBP audit trail.
-- Existing ChatGPT rows keep working via the 'chatgpt' default.
alter table seat_month_entries
  add column seat_type text not null default 'chatgpt',
  add column price_gbp numeric,   -- Claude: price as entered (£); ChatGPT: null
  add column fx_rate   numeric;   -- £→$ rate used at save time; ChatGPT: null
alter table seat_month_entries drop constraint seat_month_entries_vendor_month_key;
alter table seat_month_entries add unique (vendor, month, seat_type);
