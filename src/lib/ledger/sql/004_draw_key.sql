-- 004_draw_key.sql: one pack reading per draw. A pack reading carries a key for the draw it reads:
-- HMAC(account | the saved reading's own random id), never the draw's content. A second request
-- for the same draw (a slow tap, another tab, a changed clock) gets that one back instead of a second
-- charge (reserve, 002). Immutable once applied, like 001.
alter table moona.requests add column if not exists draw_key bytea;
-- At most one live pack reading per account and draw: calling, or succeeded with its text still kept.
-- A failed or expired one (its credit came back), or one whose text is gone, leaves the index, so
-- that draw can be bought again. reserve checks first; this index only backs it up.
create unique index if not exists requests_one_per_draw on moona.requests (account_id, draw_key)
  where mode = 'paid_reading' and draw_key is not null and (state = 'calling' or (state = 'succeeded' and not result_purged));
