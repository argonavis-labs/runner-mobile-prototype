-- Phone-link flow: user logs into web, server hands them a Runner number +
-- 6-digit code; user texts the code from their phone; Spectrum inbound
-- consumes it and links the phone to the user. We also store email on the
-- users row so the JWT-based web session can resolve a user without
-- requiring a phone number first.

alter table users
  add column if not exists email text;

create index if not exists users_email_idx
  on users (email)
  where email is not null;

create table if not exists phone_link_codes (
  code            text primary key,
  runner_user_id  text not null,
  workspace_id    text not null,
  email           text not null,
  jwt             text not null,
  refresh_token   text not null,
  jwt_expires_at  timestamptz not null,
  time_zone       text,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  consumed_phone  text,
  created_at      timestamptz not null default now()
);

create index if not exists phone_link_codes_expires_at_idx
  on phone_link_codes (expires_at)
  where consumed_at is null;
