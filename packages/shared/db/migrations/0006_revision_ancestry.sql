-- Track revision ancestry so the server-side three-way merge can find a
-- common base when two clients edit the same file concurrently.
--
-- parent_revision_id is the immediate prior revision of the same file
-- (NULL for the first revision). merge_parent_id is non-null only on
-- revisions produced by a server-side merge — it points to the OTHER
-- side's revision id (the one we merged in), so we can audit merges later.

alter table memory_file_revisions
  add column if not exists parent_revision_id integer
    references memory_file_revisions(id) on delete set null,
  add column if not exists merge_parent_id integer
    references memory_file_revisions(id) on delete set null;

create index if not exists memory_file_revisions_parent_idx
  on memory_file_revisions (parent_revision_id);
