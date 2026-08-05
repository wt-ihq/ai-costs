-- A recurring entry can be tagged with the real vendor it belongs to (e.g. an
-- OpenRouter platform subscription) so its facts materialize under that vendor
-- as cost_type='subscription' and Explore shows ONE vendor row whose
-- composition splits subscription vs API usage. Default 'other' keeps every
-- existing entry in the "Other tools" bucket.
alter table recurring_costs add column vendor vendor not null default 'other';
