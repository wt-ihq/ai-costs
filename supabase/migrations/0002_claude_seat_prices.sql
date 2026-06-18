-- Real Claude Team tier prices (were placeholder $30/$30).
-- Source: roster pricing in GBP ex-VAT, converted at fx_rates.GBP (1.27):
--   standard £15  -> $19.05
--   premium  £75  -> $95.25
update seat_prices set monthly_price_usd = 19.05 where vendor = 'claude_team' and seat_type = 'standard';
update seat_prices set monthly_price_usd = 95.25 where vendor = 'claude_team' and seat_type = 'premium';
