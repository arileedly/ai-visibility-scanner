-- The original project schema created rate_limits/scan_cache with extra
-- NOT NULL columns (scan_count, last_scan_at, expires_at, result_json) that
-- the v2 Edge Function does not populate. Give them defaults so inserts
-- succeed. Guarded per-column so this is a no-op on fresh databases that
-- never had the legacy columns. Applied to production 2026-07-06.

do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('rate_limits','scan_count',   '1'),
      ('rate_limits','last_scan_at', 'now()'),
      ('rate_limits','created_at',   'now()'),
      ('scan_cache','expires_at',    $d$now() + interval '7 days'$d$),
      ('scan_cache','result_json',   $d$'{}'::jsonb$d$),
      ('scan_cache','created_at',    'now()')
    ) as v(tbl, col, dflt)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = c.tbl and column_name = c.col
    ) then
      execute format('alter table public.%I alter column %I set default %s;', c.tbl, c.col, c.dflt);
      raise notice 'default set: %.%', c.tbl, c.col;
    else
      raise notice 'skipped (column absent): %.%', c.tbl, c.col;
    end if;
  end loop;
end $$;
