-- 003_roles.sql
do $$ begin if not exists (select 1 from pg_roles where rolname = 'moona_app') then create role moona_app login; end if; end $$;
-- The user sets the password themselves: alter role moona_app password '...'; Vercel uses the moona_app pooler URL.
revoke all on schema moona from public;
grant usage on schema moona to moona_app;
revoke all on all tables in schema moona from public, moona_app;
revoke all on all sequences in schema moona from public, moona_app;
revoke all on all functions in schema moona from public;
grant execute on function moona.reserve(jsonb), moona.complete(jsonb), moona.fail(jsonb), moona.mint_visitor(jsonb),
  moona.ensure_account(jsonb), moona.entitlements(jsonb), moona.view_order(jsonb), moona.orders_to_verify(jsonb),
  moona.create_order(jsonb), moona.attach_session(jsonb), moona.fulfil(jsonb), moona.expire_order(jsonb), moona.revoke_order(jsonb),
  moona.reap(jsonb), moona.purge_results(jsonb), moona.snapshot(jsonb), moona.audit(jsonb), moona.set_flag(jsonb),
  moona.functions_version() to moona_app;
-- Owner only (ledger-admin script via DATABASE_OWNER_URL): sync_plan, record_spend, revoke_mode.
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then
  revoke all on schema moona from anon, authenticated; end if; end $$;  -- Supabase: never add 'moona' to the Data API exposed schemas
