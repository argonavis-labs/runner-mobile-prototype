create table if not exists users (
  phone_number              text primary key,
  runner_user_id            text not null unique,
  workspace_id              text not null,
  jwt                       text not null,
  refresh_token             text not null,
  jwt_expires_at            timestamptz not null,
  spectrum_user_id          text not null,
  assigned_phone_number     text,
  managed_agent_id          text,
  managed_agent_version     integer,
  managed_agent_vault_id    text,
  managed_agents_session_id text,
  last_user_msg_at          timestamptz,
  last_assistant_msg_at     timestamptz,
  created_at                timestamptz not null default now()
);

create index if not exists users_last_user_msg_at_idx on users (last_user_msg_at);
