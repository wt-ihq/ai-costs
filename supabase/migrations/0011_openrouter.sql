-- NOTE (prod apply): run the ALTER TYPE line as its OWN statement first
-- (same rule as migration 0010's vendor enum).
alter type vendor add value 'openrouter';
