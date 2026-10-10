-- 900_test_clock.sql: applied ONLY by migrate({ testClock: true }); never in production migrations
create or replace function moona._clock(p jsonb) returns timestamptz language sql volatile
set search_path = pg_catalog, pg_temp as $$ select coalesce((p->>'now')::timestamptz, clock_timestamp()) $$;
