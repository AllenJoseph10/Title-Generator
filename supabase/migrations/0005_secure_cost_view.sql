-- Fixes the Supabase `security_definer_view` lint on public.cost_per_day.
--
-- Views default to definer semantics: they run with the privileges of the
-- owner (postgres, set by `supabase db push`), not the caller. That let
-- cost_per_day read `generations` straight through its deny-all RLS. Stock
-- Supabase projects also grant anon/authenticated SELECT on new objects in
-- `public`, so GET /rest/v1/cost_per_day exposed daily generation counts and
-- total spend even though `select * from generations` was blocked.
--
-- security_invoker makes the view honour the caller's RLS. `generations` has
-- no policies, so anon/authenticated now get zero rows; service_role still
-- bypasses RLS and reads everything. The revoke is belt-and-braces.

alter view public.cost_per_day set (security_invoker = on);

revoke all on public.cost_per_day from anon, authenticated;
