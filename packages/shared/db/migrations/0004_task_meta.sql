-- Task convention: derived cache of parsed task frontmatter so we can
-- query by status / next_check_in without parsing every memory file.
-- Markdown content remains the source of truth; this column is rebuildable.
--
-- Note on indexing: ISO 8601 strings sort lexicographically the same as the
-- underlying timestamps when normalized to UTC (which our parser ensures).
-- We index the text value directly because casting `text::timestamptz` is
-- not IMMUTABLE (it depends on session timezone) and Postgres rejects it
-- in expression indexes.

alter table memory_files
  add column if not exists task_meta jsonb;

create index if not exists memory_files_task_status_idx
  on memory_files ((task_meta->>'status'))
  where task_meta is not null and deleted_at is null;

create index if not exists memory_files_task_next_check_in_idx
  on memory_files ((task_meta->>'nextCheckIn'))
  where task_meta is not null and deleted_at is null;
