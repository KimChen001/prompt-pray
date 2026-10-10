-- Helpers (security invoker; called only from the definer functions below; EXECUTE revoked from public in 003)
create or replace function moona._clock(p jsonb) returns timestamptz
language sql volatile set search_path = pg_catalog, pg_temp as $$ select clock_timestamp() $$;   -- production: ignores p

create or replace function moona._lock() returns moona.gate
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare g moona.gate;
begin select * into strict g from moona.gate where id = 1 for update; return g; end $$;

create or replace function moona._deny(reason text) returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$ select jsonb_build_object('status','denied','reason',reason) $$;

create or replace function moona._view(r moona.requests) returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('id', r.id, 'state', r.state, 'mode', r.mode, 'purpose', r.purpose, 'error_code', r.error_code,
    'result', case when r.result_purged then null else r.result end,
    'paid_reading_id', x.id,
    'followups_left', x.followups_total - x.followups_used - x.followups_reserved)
  from (select 1) one
  left join moona.paid_readings x
    on x.id = coalesce(r.paid_reading_id, (select y.id from moona.paid_readings y where y.request_id = r.id)) $$;

create or replace function moona._order_view(o moona.orders) returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select (to_jsonb(o) - 'checkout_key') || jsonb_build_object(
    'credits_left', (select l.readings_total - l.readings_used - l.readings_reserved from moona.lots l where l.order_id = o.id and l.state = 'open'),
    'lot_state', (select l.state from moona.lots l where l.order_id = o.id)) $$;

create or replace function moona._event(p_id text, p_outcome text) returns jsonb
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin update moona.payment_events set outcome = p_outcome where event_id = p_id;
      return jsonb_build_object('status', p_outcome); end $$;

create or replace function moona._pool_settle(p_id text, p_release bigint, p_charge bigint, p_over bigint, p_uncall int)
returns void language sql set search_path = pg_catalog, pg_temp as $$
  update moona.pools set held_micro = held_micro - p_release, spent_micro = spent_micro + p_charge,
         overrun_micro = overrun_micro + p_over, calls_used = calls_used - p_uncall where id = p_id $$;

-- Settle one 'calling' request exactly once (caller holds the lock).
create or replace function moona._settle(r moona.requests, p_state text, p_charge bigint, p_billing text,
                                         p_usage jsonb, p_error text, p_now timestamptz) returns bigint
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_over bigint := greatest(p_charge - r.bound_micro, 0); v_uncall int := (p_billing = 'none')::int;
        v_lotc bigint; v_release bigint;
begin
  if r.state <> 'calling' then raise exception 'moona: settle on % request %', r.state, r.id; end if;
  if p_charge is null or p_charge < 0 then raise exception 'moona: invalid charge'; end if;
  if r.mode = 'free' then
    perform moona._pool_settle(r.window_id, r.bound_micro, p_charge, v_over, v_uncall);
    if r.slice_id is not null then perform moona._pool_settle(r.slice_id, r.bound_micro, p_charge, v_over, v_uncall); end if;
    perform moona._pool_settle('ai', r.bound_micro, p_charge, v_over, v_uncall);
    update moona.subject_usage set reserved = reserved - 1, used = used + (p_state = 'succeeded')::int,
           failed = failed + (p_state <> 'succeeded' and p_charge > 0)::int
     where subject_key = r.subject_key and window_id = r.window_id and purpose = r.purpose;
  else
    v_lotc := least(p_charge, r.take_micro);
    v_release := v_lotc + r.extra_micro;                 -- lot allocation moves held->spent; the extra hold is released
    update moona.lots set alloc_held_micro = alloc_held_micro - r.take_micro,
           alloc_spent_micro = alloc_spent_micro + v_lotc where order_id = r.lot_id;
    perform moona._pool_settle('ai', v_release, p_charge, v_over, v_uncall);
    perform moona._pool_settle('packs', v_release, p_charge, v_over, 0);
    if r.mode = 'paid_reading' then
      update moona.lots set readings_reserved = readings_reserved - 1,
             readings_used = readings_used + (p_state = 'succeeded')::int where order_id = r.lot_id;
    else
      update moona.paid_readings set followups_reserved = followups_reserved - 1,
             followups_used = followups_used + (p_state = 'succeeded')::int where id = r.paid_reading_id;
    end if;
  end if;
  update moona.gate set inflight = inflight - 1, updated_at = p_now where id = 1;
  update moona.requests set state = p_state, charged_micro = p_charge, lot_charged_micro = v_lotc, billing = p_billing,
         usage = coalesce(p_usage, usage), error_code = p_error, finished_at = p_now where id = r.id;
  if v_over > 0 then
    update moona.gate g set breaker = 'tripped', breaker_reason = 'bound_overrun ' || r.id, updated_at = p_now
     where g.id = 1 and (select x.overrun_micro from moona.pools x where x.id = 'ai') - g.overrun_ack_micro
                        >= (select pl.overrun_trip_micro from moona.plan pl);
  end if;
  return v_over;
end $$;

create or replace function moona._maybe_close_lot(p_lot uuid, p_now timestamptz) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v moona.lots; v_left bigint;
begin
  select * into strict v from moona.lots where order_id = p_lot;
  if v.state not in ('open','revoking') then return; end if;
  if exists (select 1 from moona.requests where lot_id = p_lot and state = 'calling') then return; end if;
  if v.state = 'open' and (v.readings_used < v.readings_total or exists (
       select 1 from moona.paid_readings where lot_id = p_lot and followups_used < followups_total)) then return; end if;
  v_left := v.alloc_micro - v.alloc_spent_micro;       -- alloc_held is 0 when nothing is calling
  update moona.pools set held_micro = held_micro - v_left where id in ('ai','packs');
  update moona.lots set state = case v.state when 'revoking' then 'revoked' else 'closed' end, closed_at = p_now where order_id = p_lot;
end $$;

create or replace function moona._release_order(o moona.orders, p_state text, p_now timestamptz) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if o.holds then
    update moona.pools set held_micro = held_micro - o.alloc_micro where id in ('ai','packs');
    update moona.pools set held_micro = held_micro - o.fee_hold_micro where id = 'reserve';
  end if;
  update moona.orders set state = p_state, holds = false, closed_at = p_now where id = o.id;
end $$;

create or replace function moona._reap_locked(p_now timestamptz, p_limit int) returns int
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare r moona.requests; o moona.orders; n int := 0;
begin
  for r in select * from moona.requests where state = 'calling' and lease_expires_at <= p_now
           order by lease_expires_at limit p_limit loop
    perform moona._settle(r, 'expired', r.bound_micro, 'bound', null, 'lease_expired', p_now); -- money: bound; entitlement: released
    if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, p_now); end if;
    n := n + 1;
  end loop;
  -- only orders WITHOUT a checkout session may be released without asking the payment provider
  for o in select * from moona.orders where state = 'pending' and provider_session_id is null
           and created_at <= p_now - interval '10 minutes' order by created_at limit p_limit loop
    perform moona._release_order(o, 'canceled', p_now); n := n + 1;
  end loop;
  -- texts past their time to live are forgotten here too (every reserve runs this), not only by the
  -- scheduled reconcile: the privacy copy promises how long a reply is kept
  update moona.requests set result = null, result_purged = true
   where id in (select id from moona.requests where result is not null and not result_purged and result_expires_at <= p_now
                order by result_expires_at limit p_limit);
  return n;
end $$;

-- RESERVE: free / paid reading / paid follow-up admission
create or replace function moona.reserve(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare
  v_now timestamptz := moona._clock(p); v_mode text := p->>'mode'; v_bound bigint := (p->>'bound_micro')::bigint;
  v_subject text := p->>'subject_key'; v_scope text := p->>'cache_scope'; v_purpose text := p->>'purpose';
  v_idem bytea := decode(p->>'idem_key','hex'); v_hash bytea := decode(p->>'input_hash','hex');
  v_acct uuid := nullif(p->>'account_id','')::uuid; v_exempt boolean := coalesce((p->>'quota_exempt')::boolean, false);
  g moona.gate; pl moona.plan; v_ai moona.pools; v_pk moona.pools; v_win moona.pools; v_sl moona.pools;
  v_q moona.free_quotas; v_u moona.subject_usage; v_has_u boolean; v_lot moona.lots; v_pr moona.paid_readings; v_r moona.requests;
  v_slice_id text; v_slice_start timestamptz; v_take bigint := 0; v_extra bigint := 0; v_free bigint;
  v_id uuid := gen_random_uuid(); v_lease timestamptz;
begin
  if v_bound is null or v_bound <= 0 then raise exception 'moona: invalid bound'; end if;
  if v_mode not in ('free','paid_reading','paid_followup') then raise exception 'moona: bad mode %', v_mode; end if;
  if v_mode <> 'free' and (v_acct is null or v_subject <> ('a:' || v_acct::text)) then raise exception 'moona: paid needs account subject'; end if;
  if v_mode = 'free' and left(v_subject, 2) <> 'v:' then raise exception 'moona: free needs visitor subject'; end if;
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  perform moona._reap_locked(v_now, 25);
  select * into g from moona.gate where id = 1;
  -- 1. idempotency (same subject + purpose + client request id)
  select * into v_r from moona.requests where idem_key = v_idem;
  if found then
    -- replay_only (paid only): the subject asks for the answer to its own earlier request, whatever has
    -- changed in its context since (notes withdrawn, a new model); it can never create a request
    if v_r.mode <> v_mode or (v_r.input_hash <> v_hash and not (v_mode <> 'free' and coalesce((p->>'replay_only')::boolean, false))) then return moona._deny('key_reused'); end if;
    if v_r.result is not null and not v_r.result_purged and v_r.result_expires_at <= v_now then
      -- past its time to live: never replayed (the caller makes a new request id)
      update moona.requests set result = null, result_purged = true where id = v_r.id returning * into v_r;
    end if;
    return jsonb_build_object('status','existing','request', moona._view(v_r));
  end if;
  if coalesce((p->>'replay_only')::boolean, false) then return moona._deny('no_such_request'); end if;
  -- 2. free only: replay a saved result, or join an identical in-flight request
  if v_mode = 'free' then
    select * into v_r from moona.requests where cache_scope = v_scope and purpose = v_purpose and input_hash = v_hash
       and mode = 'free' and state = 'succeeded' and not result_purged and (result_expires_at is null or result_expires_at > v_now)
     order by finished_at desc limit 1;
    if found then return jsonb_build_object('status','cached','request', moona._view(v_r)); end if;
    select * into v_r from moona.requests where cache_scope = v_scope and purpose = v_purpose and input_hash = v_hash
       and mode = 'free' and state = 'calling';
    if found then return jsonb_build_object('status','in_progress','request_id', v_r.id); end if;
  end if;
  -- 3. global gates
  if g.breaker = 'tripped' then return moona._deny('paused'); end if;
  if g.cooldown_until is not null and g.cooldown_until > v_now then
    return moona._deny('cooldown') || jsonb_build_object('retry_after_s', ceil(extract(epoch from g.cooldown_until - v_now))::int);
  end if;
  if g.inflight >= pl.inflight_cap then return moona._deny('busy'); end if;
  if (select count(*) from moona.requests where subject_key = v_subject and state = 'calling') >= pl.subject_inflight_cap
    then return moona._deny('subject_busy'); end if;
  select * into strict v_ai from moona.pools where id = 'ai';
  if v_mode = 'free' then
    select * into v_win from moona.pools where kind = 'window' and starts_at <= v_now and v_now < ends_at order by starts_at desc limit 1;
    if not found then return moona._deny('no_window'); end if;
    if v_ai.spent_micro + v_ai.held_micro + v_bound > v_ai.cap_micro then return moona._deny('total_usd'); end if;
    if v_win.spent_micro + v_win.held_micro + v_bound > v_win.cap_micro then return moona._deny('window_usd'); end if;
    if v_win.calls_cap is not null and v_win.calls_used >= v_win.calls_cap then return moona._deny('window_calls'); end if;
    if v_win.slice_cap_micro is not null then
      v_slice_start := to_timestamp((floor(extract(epoch from v_now) / v_win.slice_seconds) * v_win.slice_seconds)::double precision);
      -- the slice length is part of the id, so switching hourly <-> daily never reuses a row
      v_slice_id := 'slice:' || v_win.id || ':' || v_win.slice_seconds || ':' || to_char(v_slice_start at time zone 'UTC', 'YYYYMMDD"T"HH24MI"Z"');
      insert into moona.pools (id, kind, parent_id, cap_micro, starts_at, ends_at)
      values (v_slice_id, 'slice', v_win.id, v_win.slice_cap_micro, v_slice_start, v_slice_start + make_interval(secs => v_win.slice_seconds))
      on conflict (id) do nothing;
      select * into strict v_sl from moona.pools where id = v_slice_id;
      if v_sl.spent_micro + v_sl.held_micro + v_bound > v_sl.cap_micro then return moona._deny('slice_usd'); end if;
    end if;
    select * into v_q from moona.free_quotas where window_id = v_win.id and purpose = v_purpose;
    if not found then return moona._deny('purpose_closed'); end if;
    select * into v_u from moona.subject_usage where subject_key = v_subject and window_id = v_win.id and purpose = v_purpose;
    v_has_u := found;
    if not v_exempt then
      if v_q.per_subject < 1 or (v_has_u and v_u.reserved + v_u.used >= v_q.per_subject) then return moona._deny('subject_quota'); end if;
      if v_has_u and v_u.failed >= v_q.failed_cap then return moona._deny('subject_failures'); end if;
    end if;
    insert into moona.subject_usage as u (subject_key, window_id, purpose, reserved) values (v_subject, v_win.id, v_purpose, 1)
    on conflict (subject_key, window_id, purpose) do update set reserved = u.reserved + 1;
    update moona.pools set held_micro = held_micro + v_bound, calls_used = calls_used + 1
     where id = v_win.id or id = 'ai' or id = v_slice_id;
  else
    select * into strict v_pk from moona.pools where id = 'packs';
    if v_mode = 'paid_reading' then
      select * into v_lot from moona.lots where account_id = v_acct and state = 'open'
         and readings_reserved + readings_used < readings_total
       order by (alloc_micro - alloc_spent_micro - alloc_held_micro >= v_bound) desc, created_at, order_id limit 1; -- a lot that can still pay first
      if not found then return moona._deny('no_credits'); end if;
    else
      select * into v_pr from moona.paid_readings where id = nullif(p->>'paid_reading_id','')::uuid and account_id = v_acct;
      if not found then return moona._deny('no_such_reading'); end if;
      if v_pr.reading_hash is distinct from decode(p->>'reading_hash','hex') then return moona._deny('reading_mismatch'); end if;
      if v_pr.followups_reserved + v_pr.followups_used >= v_pr.followups_total then return moona._deny('no_followups'); end if;
      select * into strict v_lot from moona.lots where order_id = v_pr.lot_id;
      if v_lot.state <> 'open' then return moona._deny('lot_closed'); end if;
    end if;
    v_free := v_lot.alloc_micro - v_lot.alloc_spent_micro - v_lot.alloc_held_micro;
    v_take := least(v_bound, greatest(v_free, 0));
    v_extra := v_bound - v_take;                                   -- shortfall comes from the pack pool's slack
    if v_extra > 0 and (v_pk.spent_micro + v_pk.held_micro + v_extra > v_pk.cap_micro
                        or v_ai.spent_micro + v_ai.held_micro + v_extra > v_ai.cap_micro) then
      update moona.gate set sales = 'closed', sales_reason = 'paid_capacity ' || v_lot.order_id, updated_at = v_now where id = 1;
      return moona._deny('paid_capacity');                         -- credit kept; operator reviews / refunds
    end if;
    if v_mode = 'paid_reading' then
      update moona.lots set readings_reserved = readings_reserved + 1, alloc_held_micro = alloc_held_micro + v_take where order_id = v_lot.order_id;
    else
      update moona.paid_readings set followups_reserved = followups_reserved + 1 where id = v_pr.id;
      update moona.lots set alloc_held_micro = alloc_held_micro + v_take where order_id = v_lot.order_id;
    end if;
    update moona.pools set held_micro = held_micro + v_extra where id = 'packs';
    update moona.pools set held_micro = held_micro + v_extra, calls_used = calls_used + 1 where id = 'ai';
  end if;
  update moona.gate set inflight = inflight + 1, updated_at = v_now where id = 1;
  v_lease := v_now + make_interval(secs => pl.lease_seconds);
  insert into moona.requests (id, idem_key, subject_key, account_id, cache_scope, purpose, mode, input_hash, window_id, slice_id,
      lot_id, paid_reading_id, bound_micro, take_micro, extra_micro, state, lease_expires_at, created_at)
  values (v_id, v_idem, v_subject, v_acct, v_scope, v_purpose, v_mode, v_hash, v_win.id, v_slice_id,
      v_lot.order_id, v_pr.id, v_bound, v_take, v_extra, 'calling', v_lease, v_now);
  return jsonb_build_object('status','reserved','request_id', v_id, 'lease_expires_at', v_lease);
end $$;

-- COMPLETE: save the validated result + settle money + consume the entitlement, in one statement
create or replace function moona.complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_charge bigint := (p->>'charged_micro')::bigint;
        v_ttl int := (p->>'result_ttl_seconds')::int; r moona.requests; v_over bigint; v_ratio numeric;
begin
  perform moona._lock();
  select * into r from moona.requests where id = (p->>'request_id')::uuid;
  if not found then raise exception 'moona: unknown request'; end if;
  if r.state = 'succeeded' then return jsonb_build_object('status','already','request', moona._view(r)); end if;
  if r.state = 'failed' then return jsonb_build_object('status','conflict'); end if;
  if r.state = 'expired' then           -- late: bound already charged, entitlement already released; keep the text for replay only
    update moona.requests set result = case when result_purged then null else coalesce(result, p->'result') end, usage = coalesce(usage, p->'usage'),
           result_expires_at = coalesce(result_expires_at, v_now + make_interval(secs => v_ttl)) where id = r.id;
    return jsonb_build_object('status','late');
  end if;
  if p->>'billing' = 'bound' then v_charge := greatest(coalesce(v_charge, 0), r.bound_micro); end if;  -- unknown usage: never less than the bound
  if v_charge is null or v_charge < 0 or p->'result' is null or p->>'billing' not in ('known','bound') or v_ttl is null
    then raise exception 'moona: invalid completion'; end if;
  update moona.requests set result = p->'result', result_expires_at = v_now + make_interval(secs => v_ttl) where id = r.id;
  if r.mode = 'paid_reading' then
    insert into moona.paid_readings (lot_id, account_id, request_id, reading_hash, followups_total, created_at)
    select r.lot_id, r.account_id, r.id, decode(p->>'reading_hash','hex'), l.followups_per_reading, v_now
      from moona.lots l where l.order_id = r.lot_id;
  end if;
  v_over := moona._settle(r, 'succeeded', v_charge, p->>'billing', p->'usage', null, v_now);
  update moona.gate set unknown_streak = 0 where id = 1;
  if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, v_now); end if;
  select max((x.spent_micro + x.held_micro)::numeric / nullif(x.cap_micro, 0)) into v_ratio
    from moona.pools x where x.id in ('ai', coalesce(r.window_id, 'ai'), coalesce(r.slice_id, 'ai'));
  select * into r from moona.requests where id = r.id;
  return jsonb_build_object('status','succeeded','request', moona._view(r), 'overrun_micro', v_over, 'budget_ratio', v_ratio);
end $$;

-- FAIL: settle by billing certainty and RELEASE the entitlement / quota slot
create or replace function moona.fail(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_billing text := p->>'billing'; r moona.requests; pl moona.plan;
        v_charge bigint; v_over bigint; v_rl boolean := coalesce((p->>'rate_limited')::boolean, false);
        v_retry int := coalesce((p->>'retry_after_s')::int, 0);
begin
  perform moona._lock();
  select * into strict pl from moona.plan;
  select * into r from moona.requests where id = (p->>'request_id')::uuid;
  if not found then raise exception 'moona: unknown request'; end if;
  if r.state <> 'calling' then return jsonb_build_object('status', case r.state when 'expired' then 'late' else 'already' end); end if;
  v_charge := case v_billing when 'none' then 0 when 'unknown' then r.bound_micro when 'bound' then r.bound_micro
                             when 'known' then (p->>'charged_micro')::bigint end;
  v_over := moona._settle(r, 'failed', v_charge, v_billing, p->'usage', p->>'error_code', v_now);
  if v_billing = 'unknown' then
    update moona.gate set unknown_streak = unknown_streak + 1,
           cooldown_until = case when unknown_streak + 1 >= pl.unknown_trip
             then greatest(coalesce(cooldown_until, v_now), v_now + make_interval(secs => pl.unknown_cooldown_s)) else cooldown_until end
     where id = 1;
  else
    update moona.gate set unknown_streak = 0 where id = 1;
  end if;
  if v_rl then
    update moona.gate set
      rl_hits = case when rl_window_start is null or rl_window_start <= v_now - make_interval(secs => pl.rl_window_s) then 1 else rl_hits + 1 end,
      rl_window_start = case when rl_window_start is null or rl_window_start <= v_now - make_interval(secs => pl.rl_window_s) then v_now else rl_window_start end
     where id = 1;
    update moona.gate set cooldown_until = greatest(coalesce(cooldown_until, v_now), v_now + make_interval(secs => greatest(pl.rl_cooldown_s, v_retry))),
           rl_hits = 0, rl_window_start = null
     where id = 1 and rl_hits >= pl.rl_trip;
  end if;
  if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, v_now); end if;
  return jsonb_build_object('status','failed','charged_micro', v_charge, 'overrun_micro', v_over);
end $$;

create or replace function moona.mint_visitor(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); pl moona.plan; v_win moona.pools; v_ws timestamptz; v_n int;
begin
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  select * into v_win from moona.pools where kind = 'window' and starts_at <= v_now and v_now < ends_at order by starts_at desc limit 1;
  if found and v_win.mint_cap is not null and v_win.minted >= v_win.mint_cap then return moona._deny('mint_cap'); end if;
  v_ws := to_timestamp((floor(extract(epoch from v_now) / pl.mint_net_window_s) * pl.mint_net_window_s)::double precision);
  insert into moona.rate_windows as w (key, window_start, count) values ('mint:' || (p->>'net_bucket'), v_ws, 1)
  on conflict (key, window_start) do update set count = w.count + 1 where w.count < pl.mint_net_limit
  returning count into v_n;
  if v_n is null then return moona._deny('mint_net'); end if;
  update moona.pools set minted = minted + 1 where id = v_win.id;
  return jsonb_build_object('status','ok');
end $$;

create or replace function moona.ensure_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid;
begin
  insert into moona.accounts (provider, subject, created_at) values (p->>'provider', p->>'subject', moona._clock(p))
  on conflict (provider, subject) do nothing returning id into v_id;
  if v_id is null then select id into strict v_id from moona.accounts where provider = p->>'provider' and subject = p->>'subject'; end if;
  return jsonb_build_object('account_id', v_id);
end $$;

-- CREATE ORDER: hold fulfilment (ai + packs) and the fee estimate (reserve) BEFORE any redirect
create or replace function moona.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_acct uuid := (p->>'account_id')::uuid; v_mode text := p->>'mode';
        g moona.gate; pl moona.plan; v_ai moona.pools; v_pk moona.pools; v_res moona.pools; v_p moona.products; o moona.orders; v_sold int;
begin
  if v_mode not in ('fake','test','live') then raise exception 'moona: bad mode'; end if;
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  perform moona._reap_locked(v_now, 25);
  select * into g from moona.gate where id = 1;
  select * into o from moona.orders where account_id = v_acct and checkout_key = p->>'checkout_key';
  if found then return jsonb_build_object('status','existing','order', moona._order_view(o)); end if;
  select * into o from moona.orders where account_id = v_acct and state = 'pending';
  if found then return jsonb_build_object('status','pending_exists','order', moona._order_view(o)); end if;
  if g.breaker = 'tripped' or g.sales = 'closed' then return moona._deny('sales_closed'); end if;
  select * into v_p from moona.products where id = p->>'product_id' and active;
  if not found then return moona._deny('no_product'); end if;
  select count(*) into v_sold from moona.orders where product_id = v_p.id and (mode = 'live') = (v_mode = 'live')
     and state in ('pending','paid','paid_unfunded','needs_review');
  if v_sold >= (case when v_mode = 'live' then v_p.max_sold_live else v_p.max_sold_test end) then return moona._deny('sold_out'); end if;
  select * into strict v_ai from moona.pools where id = 'ai';
  select * into strict v_pk from moona.pools where id = 'packs';
  select * into strict v_res from moona.pools where id = 'reserve';
  if v_pk.spent_micro + v_pk.held_micro + v_p.alloc_micro + pl.pack_slack_micro > v_pk.cap_micro
     or v_ai.spent_micro + v_ai.held_micro + v_p.alloc_micro > v_ai.cap_micro
     or v_res.spent_micro + v_res.held_micro + v_p.fee_hold_micro > v_res.cap_micro then return moona._deny('budget_short'); end if;
  update moona.pools set held_micro = held_micro + v_p.alloc_micro where id in ('ai','packs');
  update moona.pools set held_micro = held_micro + v_p.fee_hold_micro where id = 'reserve';
  insert into moona.orders (account_id, product_id, mode, state, holds, amount_cents, currency, readings, followups_per_reading,
                            alloc_micro, fee_hold_micro, checkout_key, checkout_expires_at, created_at)
  values (v_acct, v_p.id, v_mode, 'pending', true, v_p.amount_cents, v_p.currency, v_p.readings, v_p.followups_per_reading,
          v_p.alloc_micro, v_p.fee_hold_micro, p->>'checkout_key', v_now + make_interval(secs => pl.checkout_ttl_s), v_now)
  returning * into o;
  return jsonb_build_object('status','created','order', moona._order_view(o));
end $$;

create or replace function moona.attach_session(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare o moona.orders;
begin
  perform moona._lock();
  select * into o from moona.orders where id = (p->>'order_id')::uuid;
  if not found then return jsonb_build_object('status','not_pending'); end if;
  if o.provider_session_id = p->>'session_id' then return jsonb_build_object('status','attached'); end if;
  if o.state <> 'pending' or o.provider_session_id is not null then return jsonb_build_object('status','not_pending'); end if;
  update moona.orders set provider_session_id = p->>'session_id', checkout_url = p->>'url' where id = o.id;
  return jsonb_build_object('status','attached');
end $$;

-- FULFIL: verified webhook or verified sync -> grant exactly once
create or replace function moona.fulfil(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_ev text := p->>'event_id'; v_ai moona.pools; v_pk moona.pools; v_res moona.pools;
        o moona.orders; v_n int;
begin
  perform moona._lock();
  insert into moona.payment_events (event_id, type, order_id, outcome, received_at)
  values (v_ev, p->>'type', nullif(p->>'order_id','')::uuid, 'processing', v_now) on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders where id = nullif(p->>'order_id','')::uuid;
  if not found then return moona._event(v_ev, 'unknown_order'); end if;
  if o.provider_session_id is distinct from p->>'session_id' then return moona._event(v_ev, 'session_mismatch'); end if;
  if (o.mode = 'live') is distinct from (p->>'livemode')::boolean then return moona._event(v_ev, 'mode_mismatch'); end if;
  if not coalesce((p->>'paid')::boolean, false) then return moona._event(v_ev, 'not_paid'); end if;
  if o.state in ('paid','paid_unfunded','needs_review','revoked') then return moona._event(v_ev, 'already'); end if;
  if o.amount_cents is distinct from (p->>'amount_cents')::int or o.currency is distinct from lower(p->>'currency') then
    update moona.orders set state = 'needs_review', review_note = 'amount_mismatch', paid_at = v_now,
           provider_payment_id = nullif(p->>'payment_id','') where id = o.id;     -- holds stay until an operator refunds
    update moona.gate set sales = 'closed', sales_reason = 'amount_mismatch ' || o.id, updated_at = v_now where id = 1;
    return moona._event(v_ev, 'amount_mismatch');
  end if;
  if not o.holds then                                   -- paid after expiry/cancel: re-acquire under the same caps
    select * into strict v_ai from moona.pools where id = 'ai';
    select * into strict v_pk from moona.pools where id = 'packs';
    select * into strict v_res from moona.pools where id = 'reserve';
    if v_pk.spent_micro + v_pk.held_micro + o.alloc_micro > v_pk.cap_micro
       or v_ai.spent_micro + v_ai.held_micro + o.alloc_micro > v_ai.cap_micro
       or v_res.spent_micro + v_res.held_micro + o.fee_hold_micro > v_res.cap_micro then
      update moona.orders set state = 'paid_unfunded', paid_at = v_now, provider_payment_id = nullif(p->>'payment_id','') where id = o.id;
      update moona.gate set sales = 'closed', sales_reason = 'paid_unfunded ' || o.id, updated_at = v_now where id = 1;
      return moona._event(v_ev, 'paid_unfunded');       -- nothing granted; the cap holds; operator refunds
    end if;
    update moona.pools set held_micro = held_micro + o.alloc_micro where id in ('ai','packs');
    update moona.pools set held_micro = held_micro + o.fee_hold_micro where id = 'reserve';
  end if;
  update moona.pools set held_micro = held_micro - o.fee_hold_micro, spent_micro = spent_micro + o.fee_hold_micro where id = 'reserve';
  insert into moona.entries (entry_id, pool_id, kind, amount_micro, order_id, note, created_at)
  values ('fee:' || o.id, 'reserve', 'fee_estimate', o.fee_hold_micro, o.id, 'payment fee estimate', v_now);
  update moona.orders set state = 'paid', holds = false, paid_at = v_now, closed_at = null,
         provider_payment_id = nullif(p->>'payment_id','') where id = o.id;
  insert into moona.lots (order_id, account_id, mode, state, readings_total, followups_per_reading, alloc_micro, created_at)
  values (o.id, o.account_id, o.mode, 'open', o.readings, o.followups_per_reading, o.alloc_micro, v_now);   -- order hold becomes lot allocation
  return moona._event(v_ev, 'granted');
end $$;

create or replace function moona.expire_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; v_n int; v_kind text := coalesce(p->>'kind','expired');
begin
  perform moona._lock();
  insert into moona.payment_events (event_id, type, outcome, received_at) values (p->>'event_id', v_kind, 'processing', v_now)
  on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders where provider_session_id = p->>'session_id';
  if not found then return moona._event(p->>'event_id', 'unknown_session'); end if;
  update moona.payment_events set order_id = o.id where event_id = p->>'event_id';
  if o.state <> 'pending' then return moona._event(p->>'event_id', 'noop'); end if;
  perform moona._release_order(o, case v_kind when 'async_failed' then 'canceled' else 'expired' end, v_now);
  return moona._event(p->>'event_id', 'released');
end $$;

create or replace function moona.revoke_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; v_n int; v_kind text := p->>'kind';
begin
  if v_kind not in ('refund_full','refund_partial','dispute') then raise exception 'moona: bad revoke kind'; end if;
  perform moona._lock();
  insert into moona.payment_events (event_id, type, outcome, received_at) values (p->>'event_id', v_kind, 'processing', v_now)
  on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders
   where provider_payment_id = nullif(p->>'payment_id','') or id = nullif(p->>'order_id','')::uuid
   order by (provider_payment_id = nullif(p->>'payment_id','')) desc nulls last limit 1;
  if not found then return moona._event(p->>'event_id', 'unknown_payment'); end if;
  update moona.payment_events set order_id = o.id where event_id = p->>'event_id';
  if v_kind = 'refund_partial' then
    update moona.orders set review_note = 'partial_refund' where id = o.id;
    return moona._event(p->>'event_id', 'partial_refund_review');
  end if;
  if o.state = 'revoked' then return moona._event(p->>'event_id', 'already'); end if;
  if o.holds then perform moona._release_order(o, 'revoked', v_now);
  else update moona.orders set state = 'revoked', closed_at = v_now where id = o.id; end if;
  update moona.lots set state = 'revoking' where order_id = o.id and state = 'open';
  if exists (select 1 from moona.lots where order_id = o.id) then perform moona._maybe_close_lot(o.id, v_now); end if;
  return moona._event(p->>'event_id', 'revoked');      -- in-flight paid requests finish; the leftover is released after the last one
end $$;

create or replace function moona.revoke_mode(p jsonb) returns jsonb    -- go-live: release/revoke all fake+test packs (owner only)
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; n int := 0;
begin
  perform moona._lock();
  for o in select * from moona.orders where mode <> 'live' and state in ('pending','paid','paid_unfunded','needs_review') loop
    if o.state = 'pending' then perform moona._release_order(o, 'canceled', v_now);
    elsif o.holds then perform moona._release_order(o, 'revoked', v_now);
    else update moona.orders set state = 'revoked', closed_at = v_now where id = o.id; end if;
    update moona.lots set state = 'revoking' where order_id = o.id and state = 'open';
    if exists (select 1 from moona.lots where order_id = o.id) then perform moona._maybe_close_lot(o.id, v_now); end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('status','ok','orders', n);
end $$;

create or replace function moona.reap(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); n int;
begin
  perform moona._lock();
  n := moona._reap_locked(v_now, coalesce((p->>'limit')::int, 200));
  delete from moona.rate_windows where window_start < v_now - interval '1 day';
  return jsonb_build_object('status','ok','reaped', n);
end $$;

create or replace function moona.purge_results(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); n int;
begin
  perform moona._lock();
  update moona.requests set result = null, result_purged = true
   where result is not null and not result_purged and result_expires_at <= v_now;
  get diagnostics n = row_count;
  return jsonb_build_object('status','ok','purged', n);
end $$;

create or replace function moona.set_flag(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p);
begin
  perform moona._lock();
  if p->>'key' = 'breaker' and p->>'value' in ('ok','tripped') then
    update moona.gate set breaker = p->>'value', breaker_reason = p->>'reason', updated_at = v_now,
           overrun_ack_micro = case when p->>'value' = 'ok' then (select overrun_micro from moona.pools where id = 'ai') else overrun_ack_micro end
     where id = 1;
  elsif p->>'key' = 'sales' and p->>'value' in ('open','closed') then
    update moona.gate set sales = p->>'value', sales_reason = p->>'reason', updated_at = v_now where id = 1;
  else raise exception 'moona: bad flag'; end if;
  return jsonb_build_object('status','ok');
end $$;

create or replace function moona.record_spend(p jsonb) returns jsonb           -- owner only (script)
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_pool text; v_amt bigint := (p->>'amount_micro')::bigint; v_n int; v_done int := 0;
begin
  perform moona._lock();
  for v_pool in select jsonb_array_elements_text(p->'pools') loop
    insert into moona.entries (entry_id, pool_id, kind, amount_micro, order_id, note, created_at)
    values (p->>'entry_id', v_pool, p->>'kind', v_amt, nullif(p->>'order_id','')::uuid, coalesce(p->>'note',''), v_now)
    on conflict (entry_id, pool_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then
      update moona.pools set spent_micro = spent_micro + v_amt,
             overrun_micro = overrun_micro + greatest(spent_micro + v_amt + held_micro - cap_micro - overrun_micro, 0)
       where id = v_pool;
      v_done := v_done + 1;
    end if;
  end loop;
  return jsonb_build_object('status', case when v_done = 0 then 'duplicate' else 'recorded' end);
end $$;

-- SYNC PLAN (owner only; never touches spent/held/overrun/calls_used/minted)
create or replace function moona.sync_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); pl jsonb := p->'plan'; x jsonb; v_ids text[]; v_bad text; v_n int;
begin
  perform moona._lock();
  v_ids := array(select e->>'id' from jsonb_array_elements(p->'pools') e);
  if not (v_ids @> array['ai','packs','hosting','reserve']) then raise exception 'moona: plan lacks base pools'; end if;
  select e->>'id' into v_bad from jsonb_array_elements(p->'pools') e join moona.pools w on w.id = e->>'id'
   where w.kind = 'window' and (e->>'starts_at')::timestamptz > v_now and (w.spent_micro + w.held_micro > 0 or w.calls_used > 0 or w.minted > 0) limit 1;
  if v_bad is not null then raise exception 'moona: window % was already used and cannot start in the future', v_bad; end if;
  for x in select * from jsonb_array_elements(p->'pools') loop
    insert into moona.pools as t (id, kind, cap_micro, calls_cap, slice_cap_micro, slice_seconds, mint_cap, starts_at, ends_at)
    values (x->>'id', x->>'kind', (x->>'cap_micro')::bigint, (x->>'calls_cap')::int, (x->>'slice_cap_micro')::bigint,
            (x->>'slice_seconds')::int, (x->>'mint_cap')::int, (x->>'starts_at')::timestamptz, (x->>'ends_at')::timestamptz)
    on conflict (id) do update set cap_micro = excluded.cap_micro, calls_cap = excluded.calls_cap, slice_cap_micro = excluded.slice_cap_micro,
       slice_seconds = excluded.slice_seconds, mint_cap = excluded.mint_cap, starts_at = excluded.starts_at, ends_at = excluded.ends_at
     where t.kind = excluded.kind;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'moona: pool % would change kind', x->>'id'; end if;
  end loop;
  delete from moona.free_quotas q using moona.pools w
   where q.window_id = w.id and w.kind = 'window' and w.starts_at > v_now and not (w.id = any (v_ids));
  delete from moona.pools w where w.kind = 'window' and w.starts_at > v_now and not (w.id = any (v_ids));
  update moona.pools set ends_at = v_now where kind = 'window' and starts_at < v_now and ends_at > v_now and not (id = any (v_ids));
  -- a live slice never drops below what it already spent and holds (audit's cap check)
  update moona.pools s set cap_micro = greatest(w.slice_cap_micro, s.spent_micro + s.held_micro - s.overrun_micro) from moona.pools w
   where s.kind = 'slice' and s.parent_id = w.id and s.ends_at > v_now and w.slice_cap_micro is not null;
  -- only windows that can still admit must not overlap: a window just closed at now may share its past with a new one
  select a.id || ' / ' || b.id into v_bad from moona.pools a join moona.pools b on a.id < b.id
   where a.kind = 'window' and b.kind = 'window' and a.ends_at > v_now and b.ends_at > v_now
     and greatest(a.starts_at, v_now) < b.ends_at and greatest(b.starts_at, v_now) < a.ends_at limit 1;
  if v_bad is not null then raise exception 'moona: windows overlap: %', v_bad; end if;
  select id into v_bad from moona.pools where kind <> 'slice' and spent_micro + held_micro > cap_micro + overrun_micro limit 1;
  if v_bad is not null then raise exception 'moona: cap of % is below spent + held', v_bad; end if;
  if (select coalesce(sum(case when ends_at > v_now then cap_micro else spent_micro + held_micro end), 0) from moona.pools where kind = 'window')
     + (select cap_micro from moona.pools where id = 'packs') > (select cap_micro from moona.pools where id = 'ai')
    then raise exception 'moona: free windows + pack pool exceed the ai cap'; end if;
  if (select sum(cap_micro) from moona.pools where id in ('ai','hosting','reserve')) > (pl->>'cash_total_micro')::bigint
    then raise exception 'moona: ai + hosting + reserve exceed the cash total'; end if;
  delete from moona.free_quotas where window_id = any (v_ids);
  insert into moona.free_quotas (window_id, purpose, per_subject, failed_cap)
  select q->>'window_id', q->>'purpose', (q->>'per_subject')::int, (q->>'failed_cap')::int from jsonb_array_elements(p->'quotas') q;
  for x in select * from jsonb_array_elements(p->'products') loop
    insert into moona.products as t (id, active, amount_cents, currency, readings, followups_per_reading, alloc_micro, fee_hold_micro, max_sold_test, max_sold_live)
    values (x->>'id', (x->>'active')::boolean, (x->>'amount_cents')::int, x->>'currency', (x->>'readings')::int, (x->>'followups_per_reading')::int,
            (x->>'alloc_micro')::bigint, (x->>'fee_hold_micro')::bigint, (x->>'max_sold_test')::int, (x->>'max_sold_live')::int)
    on conflict (id) do update set active = excluded.active, amount_cents = excluded.amount_cents, currency = excluded.currency,
       readings = excluded.readings, followups_per_reading = excluded.followups_per_reading, alloc_micro = excluded.alloc_micro,
       fee_hold_micro = excluded.fee_hold_micro, max_sold_test = excluded.max_sold_test, max_sold_live = excluded.max_sold_live;
  end loop;
  update moona.products set active = false where not (id = any (array(select e->>'id' from jsonb_array_elements(p->'products') e)));
  insert into moona.plan as t (id, plan_id, plan_hash, cash_total_micro, overrun_trip_micro, inflight_cap, subject_inflight_cap, lease_seconds,
      unknown_trip, unknown_cooldown_s, rl_trip, rl_window_s, rl_cooldown_s, mint_net_limit, mint_net_window_s, checkout_ttl_s, pack_slack_micro, synced_at)
  values (true, pl->>'plan_id', pl->>'plan_hash', (pl->>'cash_total_micro')::bigint, (pl->>'overrun_trip_micro')::bigint,
      (pl->>'inflight_cap')::int, (pl->>'subject_inflight_cap')::int, (pl->>'lease_seconds')::int, (pl->>'unknown_trip')::int,
      (pl->>'unknown_cooldown_s')::int, (pl->>'rl_trip')::int, (pl->>'rl_window_s')::int, (pl->>'rl_cooldown_s')::int,
      (pl->>'mint_net_limit')::int, (pl->>'mint_net_window_s')::int, (pl->>'checkout_ttl_s')::int, (pl->>'pack_slack_micro')::bigint, v_now)
  on conflict (id) do update set plan_id = excluded.plan_id, plan_hash = excluded.plan_hash, cash_total_micro = excluded.cash_total_micro,
      overrun_trip_micro = excluded.overrun_trip_micro, inflight_cap = excluded.inflight_cap, subject_inflight_cap = excluded.subject_inflight_cap,
      lease_seconds = excluded.lease_seconds, unknown_trip = excluded.unknown_trip, unknown_cooldown_s = excluded.unknown_cooldown_s,
      rl_trip = excluded.rl_trip, rl_window_s = excluded.rl_window_s, rl_cooldown_s = excluded.rl_cooldown_s,
      mint_net_limit = excluded.mint_net_limit, mint_net_window_s = excluded.mint_net_window_s,
      checkout_ttl_s = excluded.checkout_ttl_s, pack_slack_micro = excluded.pack_slack_micro, synced_at = excluded.synced_at;
  return jsonb_build_object('status','synced','plan_hash', pl->>'plan_hash');
end $$;

-- Read-only views (no locks)
create or replace function moona.view_order(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select moona._order_view(o) from moona.orders o where o.id = (p->>'order_id')::uuid and o.account_id = (p->>'account_id')::uuid $$;

create or replace function moona.orders_to_verify(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(v), '[]'::jsonb) from (
    select moona._order_view(o) v from moona.orders o
     where o.state = 'pending' and o.provider_session_id is not null and o.created_at <= moona._clock(p) - interval '2 minutes'
     order by o.created_at limit coalesce((p->>'limit')::int, 50)) t $$;

create or replace function moona.entitlements(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'credits', coalesce((select sum(readings_total - readings_used - readings_reserved) from moona.lots
                          where account_id = (p->>'account_id')::uuid and state = 'open'), 0),
    'readings', coalesce((select jsonb_agg(jsonb_build_object('paid_reading_id', x.id,
                  'followups_left', x.followups_total - x.followups_used - x.followups_reserved, 'lot_open', l.state = 'open') order by x.created_at)
                  from moona.paid_readings x join moona.lots l on l.order_id = x.lot_id where x.account_id = (p->>'account_id')::uuid), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(v order by c desc) from (select moona._order_view(o) v, o.created_at c from moona.orders o
                  where o.account_id = (p->>'account_id')::uuid order by o.created_at desc limit 20) t), '[]'::jsonb),
    'unservable', exists (select 1 from moona.lots l where l.account_id = (p->>'account_id')::uuid and l.state = 'open'
                  and l.alloc_micro - l.alloc_spent_micro - l.alloc_held_micro <= 0)) $$;

create or replace function moona.snapshot(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'plan', (select jsonb_build_object('plan_id', plan_id, 'plan_hash', plan_hash) from moona.plan),
    'gate', (select to_jsonb(g) from moona.gate g),
    'pools', (select jsonb_agg(to_jsonb(x) order by x.id) from moona.pools x where x.kind <> 'slice' or x.ends_at > moona._clock(p) - interval '1 day'),
    'active_window', (select id from moona.pools where kind = 'window' and starts_at <= moona._clock(p) and moona._clock(p) < ends_at order by starts_at desc limit 1),
    'sold', jsonb_build_object(
       'test', (select count(*) from moona.orders where mode <> 'live' and state in ('pending','paid','paid_unfunded','needs_review')),
       'live', (select count(*) from moona.orders where mode = 'live' and state in ('pending','paid','paid_unfunded','needs_review'))),
    'owed_readings', (select coalesce(sum(readings_total - readings_used - readings_reserved), 0) from moona.lots where state = 'open'),
    'review_orders', (select count(*) from moona.orders where state in ('paid_unfunded','needs_review') or review_note is not null)) $$;

-- AUDIT: recompute every counter from detail rows; '[]' means consistent
create or replace function moona.audit(p jsonb) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
with fr as (select * from moona.requests where mode = 'free'), pr as (select * from moona.requests where mode <> 'free'),
v(check_name, subject, expected, actual) as (
  select 'pool_held', w.id, (select coalesce(sum(fr.bound_micro),0) from fr where fr.state = 'calling' and (fr.window_id = w.id or fr.slice_id = w.id))::numeric, w.held_micro::numeric
    from moona.pools w where w.kind in ('window','slice')
  union all select 'pool_spent', w.id, (select coalesce(sum(fr.charged_micro),0) from fr where fr.window_id = w.id or fr.slice_id = w.id)
      + (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = w.id), w.spent_micro from moona.pools w where w.kind in ('window','slice')
  union all select 'pool_calls', w.id, (select count(*) from fr where (fr.window_id = w.id or fr.slice_id = w.id) and fr.billing is distinct from 'none'), w.calls_used
    from moona.pools w where w.kind in ('window','slice')
  union all select 'held', x.id,
      (case when x.id = 'ai' then (select coalesce(sum(fr.bound_micro),0) from fr where fr.state = 'calling') else 0 end)
    + (select coalesce(sum(pr.extra_micro),0) from pr where pr.state = 'calling')
    + (select coalesce(sum(l.alloc_micro - l.alloc_spent_micro),0) from moona.lots l where l.state in ('open','revoking'))
    + (select coalesce(sum(o.alloc_micro),0) from moona.orders o where o.holds), x.held_micro from moona.pools x where x.id in ('ai','packs')
  union all select 'spent', x.id, (select coalesce(sum(r.charged_micro),0) from moona.requests r where x.id = 'ai' or r.mode <> 'free')
    + (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = x.id), x.spent_micro from moona.pools x where x.id in ('ai','packs')
  union all select 'ai_calls', 'ai', (select count(*) from moona.requests r where r.billing is distinct from 'none'), x.calls_used from moona.pools x where x.id = 'ai'
  union all select 'inflight', 'gate', (select count(*) from moona.requests r where r.state = 'calling'), g.inflight from moona.gate g
  union all select 'reserve_held', 'reserve', (select coalesce(sum(o.fee_hold_micro),0) from moona.orders o where o.holds), x.held_micro from moona.pools x where x.id = 'reserve'
  union all select 'entry_spent', x.id, (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = x.id), x.spent_micro
    from moona.pools x where x.kind in ('reserve','hosting')
  union all select 'cap', x.id, x.cap_micro + x.overrun_micro, x.spent_micro + x.held_micro from moona.pools x where x.spent_micro + x.held_micro > x.cap_micro + x.overrun_micro
  union all select 'lot_reserved', l.order_id::text, (select count(*) from pr where pr.lot_id = l.order_id and pr.mode = 'paid_reading' and pr.state = 'calling'), l.readings_reserved from moona.lots l
  union all select 'lot_used', l.order_id::text, (select count(*) from pr where pr.lot_id = l.order_id and pr.mode = 'paid_reading' and pr.state = 'succeeded'), l.readings_used from moona.lots l
  union all select 'lot_paid_readings', l.order_id::text, l.readings_used, (select count(*) from moona.paid_readings x where x.lot_id = l.order_id) from moona.lots l
  union all select 'lot_alloc_held', l.order_id::text, (select coalesce(sum(pr.take_micro),0) from pr where pr.lot_id = l.order_id and pr.state = 'calling'), l.alloc_held_micro from moona.lots l
  union all select 'lot_alloc_spent', l.order_id::text, (select coalesce(sum(pr.lot_charged_micro),0) from pr where pr.lot_id = l.order_id and pr.state <> 'calling'), l.alloc_spent_micro from moona.lots l
  union all select 'followups_reserved', x.id::text, (select count(*) from pr where pr.paid_reading_id = x.id and pr.state = 'calling'), x.followups_reserved from moona.paid_readings x
  union all select 'followups_used', x.id::text, (select count(*) from pr where pr.paid_reading_id = x.id and pr.state = 'succeeded'), x.followups_used from moona.paid_readings x
  union all select 'subject_reserved', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state = 'calling' and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.reserved from moona.subject_usage u
  union all select 'subject_used', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state = 'succeeded' and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.used from moona.subject_usage u
  union all select 'subject_failed', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state in ('failed','expired') and fr.charged_micro > 0 and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.failed from moona.subject_usage u
  union all select 'lot_has_paid_order', l.order_id::text, 1, (select count(*) from moona.orders o where o.id = l.order_id and o.state in ('paid','revoked')) from moona.lots l
  union all select 'paid_order_has_lot', o.id::text, 1, (select count(*) from moona.lots l where l.order_id = o.id) from moona.orders o where o.state = 'paid'
  union all select 'fee_entry', o.id::text, o.fee_hold_micro, (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.order_id = o.id and e.kind = 'fee_estimate')
    from moona.orders o where exists (select 1 from moona.lots l where l.order_id = o.id))
select coalesce(jsonb_agg(jsonb_build_object('check', check_name, 'subject', subject, 'expected', expected, 'actual', actual) order by check_name, subject), '[]'::jsonb)
  from v where expected is distinct from actual $$;
