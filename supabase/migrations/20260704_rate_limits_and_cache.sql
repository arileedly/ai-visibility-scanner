-- Rate limiting + scan cache support for submit-scan Edge Function.
-- Safe to run on an existing project: only creates what is missing.
-- NOTE: column alignment runs BEFORE index creation, so this works on
-- pre-existing tables that lack the new columns.

create table if not exists rate_limits (
  id bigint generated always as identity primary key,
  identifier text not null,          -- client IP or normalized domain
  kind text not null,                -- 'ip' | 'domain'
  created_at timestamptz not null default now()
);

create table if not exists scan_cache (
  id bigint generated always as identity primary key,
  normalized_domain text not null,
  payload jsonb not null,            -- { serp, backlinks, llm } findings
  created_at timestamptz not null default now()
);

-- Align pre-existing tables: add any missing columns BEFORE indexing them.
alter table rate_limits add column if not exists identifier text;
alter table rate_limits add column if not exists kind text;
alter table rate_limits add column if not exists created_at timestamptz default now();
alter table scan_cache add column if not exists normalized_domain text;
alter table scan_cache add column if not exists payload jsonb;
alter table scan_cache add column if not exists created_at timestamptz default now();

create index if not exists rate_limits_lookup_idx
  on rate_limits (identifier, kind, created_at desc);

create index if not exists scan_cache_domain_idx
  on scan_cache (normalized_domain, created_at desc);

-- Housekeeping: old rows have no value; run occasionally or wire to pg_cron.
delete from rate_limits where created_at < now() - interval '2 days';
delete from scan_cache where created_at < now() - interval '30 days';
