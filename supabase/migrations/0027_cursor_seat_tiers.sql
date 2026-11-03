-- Cursor seat tiers (spec 2026-11-03-premium-recommendations-and-cursor-usage-design.md).
-- Prices per tier for the Cursor members roster upload; 'teams' stays for existing readers.
insert into seat_prices (vendor, seat_type, monthly_price_usd) values
  ('cursor', 'standard', 40.00),
  ('cursor', 'premium', 120.00),
  ('cursor', 'free', 0.00)
on conflict (vendor, seat_type) do nothing;
