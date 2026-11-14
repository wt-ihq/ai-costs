-- The company and team Explore pages add spend up by day, vendor, cost type, person and team;
-- they never show a model or an API key. Until now a cold load still read every spend_facts row
-- through PostgREST, 1000 rows a request (hundreds of requests for the company), and summed them
-- in Node. This function does the summing in Postgres and answers in ONE response.
--
-- It returns a single json value (an array of row arrays), not a set of rows: a set would be cut
-- at PostgREST's 1000-row cap and paged again, re-running the aggregate for every page.
--
-- The grouping rule MUST stay in step with src/lib/explore/rollup.ts (rollUpKey), which is the
-- rule's tested definition; the app runs that roll-up over this result too, so this function may
-- group more finely than rollup.ts but never more coarsely:
--   model      kept for "other" (recurring) costs, and for person-less rows except Vercel's and
--              OpenRouter's metered ones; blank otherwise.
--   entity_key kept for person-less rows and "unassigned seats…"; blank otherwise.
--
-- Filters mirror src/lib/queries/common.ts:fetchFactsInRange:
--   p_employee_ids null                 → every fact (company)
--   p_department set                    → those people's facts OR person-less facts pinned to the team
--   p_include_unattributed              → those people's facts OR facts with no person and no team
--   otherwise                           → those people's facts
--
-- The app falls back to the paged read when this function is missing or fails, so the code and
-- this migration can ship in either order.

create or replace function public.explore_facts_rollup(
  p_from date,
  p_to_exclusive date,
  p_employee_ids uuid[] default null,
  p_department text default null,
  p_include_unattributed boolean default false
) returns json
language sql
stable
set search_path = public
as $$
  with scoped as (
    select
      f.day,
      f.source::text as source,
      f.cost_type::text as cost_type,
      case
        when f.employee_id is null or f.entity_key like 'unassigned seats%' then f.entity_key
        else ''
      end as entity_key,
      case
        when f.source::text = 'other'
          or (f.employee_id is null
              and f.source::text <> 'vercel'
              and not (f.source::text = 'openrouter' and f.cost_type::text = 'metered'))
        then f.model
        else ''
      end as model,
      f.employee_id,
      e.full_name,
      coalesce(f.department, e.department) as department,
      f.cost_usd
    from spend_facts f
    left join employees e on e.id = f.employee_id
    where f.day >= p_from
      and f.day < p_to_exclusive
      and (
        p_employee_ids is null
        or f.employee_id = any (p_employee_ids)
        or (p_department is not null and f.department = p_department)
        or (p_department is null and p_include_unattributed and f.employee_id is null and f.department is null)
      )
  ),
  rolled as (
    select day, source, cost_type, entity_key, model, employee_id, full_name, department, sum(cost_usd) as cost_usd
    from scoped
    group by day, source, cost_type, entity_key, model, employee_id, full_name, department
  )
  select coalesce(
    json_agg(
      json_build_array(day, source, cost_type, entity_key, model, employee_id, full_name, department, cost_usd)
      order by day, source, cost_type, employee_id, entity_key, model
    ),
    '[]'::json
  )
  from rolled;
$$;

-- Server-side only: the app calls it with the service role. It runs with the caller's rights
-- (security invoker), so row level security on spend_facts would hide the rows from anyone else
-- anyway; the grants just close the endpoint.
revoke all on function public.explore_facts_rollup(date, date, uuid[], text, boolean) from public, anon, authenticated;
grant execute on function public.explore_facts_rollup(date, date, uuid[], text, boolean) to service_role;
