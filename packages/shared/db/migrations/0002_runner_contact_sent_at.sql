alter table users
  add column if not exists runner_contact_sent_at timestamptz;
