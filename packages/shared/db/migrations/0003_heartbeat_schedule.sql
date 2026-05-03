alter table users
  add column if not exists time_zone text,
  add column if not exists last_heartbeat_tick_at timestamptz,
  add column if not exists last_heartbeat_slot text;

create index if not exists users_last_heartbeat_tick_at_idx
  on users (last_heartbeat_tick_at);
