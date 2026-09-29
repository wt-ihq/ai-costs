-- ChatGPT Business seat tiers (Standard / Premium), mirroring Claude Team:
-- the Okta access-chatgpt group says who holds a seat, the members CSV
-- upload (seat_assignments) says which licence level.
-- The single 'chatgpt' tier becomes 'standard'. Prices are monthly billing:
-- Standard $25, Premium $125 (5× usage, no 5-hour limit).
update seat_month_entries set seat_type = 'standard'
  where vendor = 'chatgpt_business' and seat_type = 'chatgpt';
-- Every writer passes seat_type; the old 'chatgpt' default would now mint a dead tier.
alter table seat_month_entries alter column seat_type drop default;

update seat_prices set seat_type = 'standard'
  where vendor = 'chatgpt_business' and seat_type = 'chatgpt';
insert into seat_prices (vendor, seat_type, monthly_price_usd) values
  ('chatgpt_business', 'premium',    125.00),
  ('chatgpt_business', 'unassigned',   0.00)
on conflict (vendor, seat_type) do nothing;
