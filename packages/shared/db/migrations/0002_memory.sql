create table if not exists memory_replicas (
  id             serial primary key,
  runner_user_id text not null,
  workspace_id   text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists memory_replicas_runner_workspace_idx
  on memory_replicas (runner_user_id, workspace_id);

create table if not exists memory_files (
  id           serial primary key,
  replica_id   integer not null references memory_replicas(id) on delete cascade,
  path         text not null,
  content      text not null default '',
  content_hash text not null,
  revision     integer not null default 0,
  origin       text not null,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists memory_files_replica_path_idx
  on memory_files (replica_id, path);

create index if not exists memory_files_replica_updated_at_idx
  on memory_files (replica_id, updated_at);

create table if not exists memory_file_revisions (
  id            serial primary key,
  replica_id    integer not null references memory_replicas(id) on delete cascade,
  path          text not null,
  content       text not null default '',
  content_hash  text not null,
  file_revision integer not null,
  origin        text not null,
  operation     text not null,
  created_at    timestamptz not null default now()
);

create index if not exists memory_file_revisions_replica_id_idx
  on memory_file_revisions (replica_id, id);

create table if not exists memory_sync_clients (
  id           text primary key,
  replica_id   integer not null references memory_replicas(id) on delete cascade,
  label        text not null,
  token_hash   text not null,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists memory_sync_clients_token_hash_idx
  on memory_sync_clients (token_hash);
