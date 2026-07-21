-- Purge stale scan_cache entries written while the backlinks call used the
-- wrong endpoint (before the 2026-07-17 fix) and before rank normalization.
-- Those entries serve false zeros (e.g. "Only 0 sites link to you") until
-- their 7-day TTL expires. Clearing the cache is safe: the only cost is that
-- the next scan of each domain runs fresh API calls.
--
-- Run once in the Supabase SQL editor AFTER deploying the updated function.

delete from scan_cache;
