-- Recurring tool costs get their own cost category instead of masquerading
-- as seats. NOTE (prod apply): ALTER TYPE ... ADD VALUE must run as its own
-- statement (same rule as migration 0008's vendor enum).
alter type cost_type add value 'subscription';
