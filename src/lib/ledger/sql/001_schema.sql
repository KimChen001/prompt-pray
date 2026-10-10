create schema if not exists moona;

create table moona.plan (
  id boolean primary key default true check (id),
  plan_id text not null, plan_hash text not null,
  cash_total_micro bigint not null check (cash_total_micro >= 0),
  overrun_trip_micro bigint not null check (overrun_trip_micro >= 0),
  inflight_cap int not null check (inflight_cap > 0),
  subject_inflight_cap int not null check (subject_inflight_cap > 0),
  lease_seconds int not null check (lease_seconds between 30 and 900),
  unknown_trip int not null check (unknown_trip > 0), unknown_cooldown_s int not null check (unknown_cooldown_s >= 0),
  rl_trip int not null check (rl_trip > 0), rl_window_s int not null check (rl_window_s > 0), rl_cooldown_s int not null check (rl_cooldown_s >= 0),
  mint_net_limit int not null check (mint_net_limit > 0), mint_net_window_s int not null check (mint_net_window_s > 0),
  checkout_ttl_s int not null check (checkout_ttl_s between 1860 and 86000),
  pack_slack_micro bigint not null check (pack_slack_micro >= 0),
  synced_at timestamptz not null);

create table moona.gate (                               -- row 1 = the global ledger mutex + provider health + flags
  id smallint primary key check (id = 1),
  inflight int not null default 0 check (inflight >= 0),
  unknown_streak int not null default 0 check (unknown_streak >= 0),
  rl_hits int not null default 0 check (rl_hits >= 0), rl_window_start timestamptz,
  cooldown_until timestamptz,
  breaker text not null default 'ok' check (breaker in ('ok','tripped')), breaker_reason text,
  overrun_ack_micro bigint not null default 0 check (overrun_ack_micro >= 0),
  sales text not null default 'open' check (sales in ('open','closed')), sales_reason text,
  updated_at timestamptz not null default now());
insert into moona.gate (id) values (1);

create table moona.pools (
  id text primary key,       -- 'ai' | 'packs' | 'hosting' | 'reserve' | 'win:<name>' | 'slice:<win>:<YYYYMMDDTHHMMZ>'
  kind text not null check (kind in ('ai','packs','hosting','reserve','window','slice')),
  parent_id text references moona.pools(id),
  cap_micro bigint not null check (cap_micro >= 0),
  spent_micro bigint not null default 0 check (spent_micro >= 0),
  held_micro bigint not null default 0 check (held_micro >= 0),
  overrun_micro bigint not null default 0 check (overrun_micro >= 0),
  calls_cap int check (calls_cap >= 0),
  calls_used int not null default 0 check (calls_used >= 0),
  slice_cap_micro bigint check (slice_cap_micro > 0),
  slice_seconds int check (slice_seconds in (3600, 86400)),
  mint_cap int check (mint_cap >= 0), minted int not null default 0 check (minted >= 0),
  starts_at timestamptz, ends_at timestamptz,
  check ((kind in ('window','slice')) = (starts_at is not null and ends_at is not null)),
  check (starts_at is null or starts_at < ends_at),
  check ((kind = 'slice') = (parent_id is not null)),
  check ((slice_cap_micro is null) = (slice_seconds is null)),
  check (kind = 'window' or (slice_cap_micro is null and mint_cap is null)));

create table moona.free_quotas (
  window_id text not null references moona.pools(id), purpose text not null,
  per_subject int not null check (per_subject >= 0), failed_cap int not null check (failed_cap >= 0),
  primary key (window_id, purpose));

create table moona.subject_usage (
  subject_key text not null,                          -- 'v:<uuid>' (signed visitor cookie); never an IP
  window_id text not null references moona.pools(id), purpose text not null,
  reserved int not null default 0 check (reserved >= 0),
  used int not null default 0 check (used >= 0),
  failed int not null default 0 check (failed >= 0),
  primary key (subject_key, window_id, purpose));

create table moona.rate_windows (key text not null, window_start timestamptz not null, count int not null check (count >= 0),
  primary key (key, window_start));                  -- 'mint:<net bucket HMAC>'

create table moona.accounts (
  id uuid primary key default gen_random_uuid(), provider text not null, subject text not null,
  created_at timestamptz not null, unique (provider, subject));

create table moona.products (
  id text primary key, active boolean not null,
  amount_cents int not null check (amount_cents > 0), currency text not null check (currency ~ '^[a-z]{3}$'),
  readings int not null check (readings > 0), followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0), fee_hold_micro bigint not null check (fee_hold_micro >= 0),
  max_sold_test int not null check (max_sold_test >= 0), max_sold_live int not null check (max_sold_live >= 0));

create table moona.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references moona.accounts(id),
  product_id text not null references moona.products(id),
  mode text not null check (mode in ('fake','test','live')),
  state text not null check (state in ('pending','paid','expired','canceled','paid_unfunded','needs_review','revoked')),
  holds boolean not null,                              -- alloc held on ai+packs and fee hold on reserve
  amount_cents int not null check (amount_cents > 0), currency text not null,
  readings int not null check (readings > 0), followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0), fee_hold_micro bigint not null check (fee_hold_micro >= 0),
  checkout_key text not null, checkout_expires_at timestamptz not null,
  provider_session_id text unique, provider_payment_id text unique, checkout_url text, review_note text,
  created_at timestamptz not null, paid_at timestamptz, closed_at timestamptz,
  unique (account_id, checkout_key),
  check (not holds or state in ('pending','needs_review')),
  check (state <> 'pending' or holds));
create unique index orders_one_pending on moona.orders (account_id) where state = 'pending';
create index orders_pending on moona.orders (created_at) where state = 'pending';

create table moona.lots (
  order_id uuid primary key references moona.orders(id),    -- at most one lot per order
  account_id uuid not null references moona.accounts(id), mode text not null,
  state text not null check (state in ('open','revoking','closed','revoked')),
  readings_total int not null check (readings_total > 0),
  readings_reserved int not null default 0 check (readings_reserved >= 0),
  readings_used int not null default 0 check (readings_used >= 0),
  followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0),
  alloc_held_micro bigint not null default 0 check (alloc_held_micro >= 0),
  alloc_spent_micro bigint not null default 0 check (alloc_spent_micro >= 0),
  created_at timestamptz not null, closed_at timestamptz,
  check (readings_reserved + readings_used <= readings_total),
  check (alloc_held_micro + alloc_spent_micro <= alloc_micro));
create index lots_open on moona.lots (account_id, created_at) where state = 'open';

create table moona.paid_readings (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references moona.lots(order_id), account_id uuid not null references moona.accounts(id),
  request_id uuid not null unique,                         -- FK added below
  reading_hash bytea not null,
  followups_total int not null check (followups_total >= 0),
  followups_reserved int not null default 0 check (followups_reserved >= 0),
  followups_used int not null default 0 check (followups_used >= 0),
  created_at timestamptz not null default now(),
  check (followups_reserved + followups_used <= followups_total));

create table moona.requests (
  id uuid primary key,
  idem_key bytea not null unique,                          -- HMAC(subject|purpose|client requestId)
  subject_key text not null check (subject_key ~ '^[va]:[0-9a-f-]{36}$'),
  account_id uuid references moona.accounts(id),
  cache_scope text not null,                               -- = subject_key, or 'shared'
  purpose text not null check (purpose in ('tarot','chat','talk','natal','horoscope')),
  mode text not null check (mode in ('free','paid_reading','paid_followup')),
  input_hash bytea not null,                               -- HMAC(canonical input + versions + provider + model + max output)
  window_id text references moona.pools(id), slice_id text references moona.pools(id),
  lot_id uuid references moona.lots(order_id), paid_reading_id uuid references moona.paid_readings(id),
  bound_micro bigint not null check (bound_micro > 0),
  take_micro bigint not null default 0 check (take_micro >= 0),     -- paid: drawn from the lot allocation
  extra_micro bigint not null default 0 check (extra_micro >= 0),   -- paid: shortfall held on packs+ai
  charged_micro bigint check (charged_micro >= 0), lot_charged_micro bigint check (lot_charged_micro >= 0),
  state text not null check (state in ('calling','succeeded','failed','expired')),
  billing text check (billing in ('known','none','unknown','bound')),
  lease_expires_at timestamptz not null,
  result jsonb, result_expires_at timestamptz, result_purged boolean not null default false,
  usage jsonb, error_code text, created_at timestamptz not null, finished_at timestamptz,
  check ((mode = 'free') = (window_id is not null)),
  check (mode = 'free' or slice_id is null),
  check ((mode = 'free') = (lot_id is null)),
  check ((mode = 'paid_followup') = (paid_reading_id is not null)),
  check (mode <> 'free' or (take_micro = 0 and extra_micro = 0)),
  check (mode = 'free' or take_micro + extra_micro = bound_micro),
  check ((state = 'calling') = (charged_micro is null)),
  check ((state = 'calling') = (finished_at is null)),
  check (mode = 'free' or state = 'calling' or lot_charged_micro is not null),
  check (state <> 'succeeded' or result is not null or result_purged));
create unique index requests_free_inflight on moona.requests (cache_scope, purpose, input_hash) where state = 'calling' and mode = 'free';
create index requests_cache on moona.requests (cache_scope, purpose, input_hash, finished_at desc) where state = 'succeeded' and mode = 'free';
create index requests_lease on moona.requests (lease_expires_at) where state = 'calling';
create index requests_subject_calling on moona.requests (subject_key) where state = 'calling';
create index requests_lot_calling on moona.requests (lot_id) where state = 'calling' and lot_id is not null;
create index requests_ttl on moona.requests (result_expires_at) where result is not null and not result_purged;
alter table moona.paid_readings add constraint paid_readings_request_fk foreign key (request_id) references moona.requests(id);

create table moona.payment_events (
  event_id text primary key,                               -- evt_..., 'sync:paid:<cs>', 'sync:expired:<cs>'
  type text not null, order_id uuid, outcome text not null, received_at timestamptz not null);

create table moona.entries (
  entry_id text not null, pool_id text not null references moona.pools(id),
  kind text not null check (kind in ('prior_spend','manual_spend','fee_estimate','dispute_fee','provider_correction')),
  amount_micro bigint not null, order_id uuid, note text not null default '', created_at timestamptz not null,
  primary key (entry_id, pool_id));

alter table moona.plan enable row level security;          alter table moona.gate enable row level security;
alter table moona.pools enable row level security;         alter table moona.free_quotas enable row level security;
alter table moona.subject_usage enable row level security; alter table moona.rate_windows enable row level security;
alter table moona.accounts enable row level security;      alter table moona.products enable row level security;
alter table moona.orders enable row level security;        alter table moona.lots enable row level security;
alter table moona.paid_readings enable row level security; alter table moona.requests enable row level security;
alter table moona.payment_events enable row level security; alter table moona.entries enable row level security;
-- No policies. The owner bypasses RLS; moona_app has no table privileges at all (003).
