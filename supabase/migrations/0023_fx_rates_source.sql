-- Where each exchange rate came from: 'ecb' rows are fetched nightly from the ECB's daily reference
-- rates (run-ecb.ts); anything else (the original GBP 1.27 placeholder) is 'manual'. The rate fields
-- prefill from the latest 'ecb' row and say so.
-- Apply BEFORE deploying: the nightly sync writes this column and the Imports and Tools tabs read it.
alter table fx_rates
  add column if not exists source text not null default 'manual';
