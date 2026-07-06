-- Enable Row Level Security on every table used by the scanner.
-- Run this in the Supabase SQL editor AFTER 20260704_rate_limits_and_cache.sql
-- (so all five tables exist), and BEFORE relying on the public site.
--
-- Why: the frontend ships a public `anon` key. Without RLS, anyone with that key
-- can read `scan_requests` (lead name/email/phone) straight from the REST API.
-- The submit-scan Edge Function uses the SERVICE ROLE key, which has BYPASSRLS,
-- so enabling RLS with NO anon policies locks out the public while the function
-- keeps full read/write access. Nothing in the app queries these tables with the
-- anon key directly, so this is safe to enable.
--
-- Net effect: RLS ON + zero policies  ->  anon/authenticated = no access,
--                                          service_role       = full access.

do $$
declare
  t text;
  tables text[] := array[
    'scan_requests',
    'scan_results',
    'api_usage_logs',
    'rate_limits',
    'scan_cache'
  ];
begin
  foreach t in array tables loop
    if exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      execute format('alter table public.%I enable row level security;', t);
      raise notice 'RLS enabled on public.%', t;
    else
      raise notice 'Skipped (table not found): public.%', t;
    end if;
  end loop;
end $$;

-- Defense in depth: make sure the anon/authenticated roles hold no leftover
-- direct grants on the lead tables. (RLS-with-no-policies already blocks reads;
-- revoking grants is a belt-and-suspenders second layer.)
do $$
declare
  t text;
  tables text[] := array['scan_requests','scan_results','api_usage_logs'];
begin
  foreach t in array tables loop
    if exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      execute format('revoke all on public.%I from anon;', t);
      execute format('revoke all on public.%I from authenticated;', t);
    end if;
  end loop;
end $$;
