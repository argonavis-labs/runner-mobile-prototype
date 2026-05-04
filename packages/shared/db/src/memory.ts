import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ACTIVE_TASK_STATUSES,
  extractTaskMeta,
  isTaskPath,
  mergeFile,
  type MergeOrigin,
  type TaskMeta,
  type TaskStatus,
} from "@runner-mobile/tasks";
import { pool } from "./client.ts";

const MEMORY_ENTRYPOINT = "MEMORY.md";

export type MemoryOrigin = "local" | "mobile" | "web" | "system";
export type MemoryOperation = "create" | "write" | "delete";

export type MemoryFileRecord = {
  id: number;
  replicaId: number;
  path: string;
  content: string;
  contentHash: string;
  revision: number;
  origin: string;
  deletedAt: Date | null;
  taskMeta: TaskMeta | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryRevisionRecord = {
  id: number;
  replicaId: number;
  path: string;
  content: string;
  contentHash: string;
  fileRevision: number;
  origin: string;
  operation: string;
  createdAt: Date;
};

type DbMemoryFile = {
  id: number;
  replica_id: number;
  path: string;
  content: string;
  content_hash: string;
  revision: number;
  origin: string;
  deleted_at: Date | null;
  task_meta: TaskMeta | null;
  created_at: Date;
  updated_at: Date;
};

type DbMemoryRevision = {
  id: number;
  replica_id: number;
  path: string;
  content: string;
  content_hash: string;
  file_revision: number;
  origin: string;
  operation: string;
  created_at: Date;
};

function toMemoryFile(row: DbMemoryFile): MemoryFileRecord {
  return {
    id: row.id,
    replicaId: row.replica_id,
    path: row.path,
    content: row.content,
    contentHash: row.content_hash,
    revision: row.revision,
    origin: row.origin,
    deletedAt: row.deleted_at,
    taskMeta: row.task_meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemoryRevision(row: DbMemoryRevision): MemoryRevisionRecord {
  return {
    id: row.id,
    replicaId: row.replica_id,
    path: row.path,
    content: row.content,
    contentHash: row.content_hash,
    fileRevision: row.file_revision,
    origin: row.origin,
    operation: row.operation,
    createdAt: row.created_at,
  };
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashSyncToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeMemoryPath(input: string): string {
  const path = input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path) throw new Error("memory path is required");
  if (path.includes("\0")) throw new Error("memory path cannot contain null bytes");
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("memory path cannot contain empty, '.', or '..' segments");
  }
  if (!path.endsWith(".md")) throw new Error("memory path must be a markdown file");
  return path;
}

export async function ensureMemoryReplica(args: {
  runnerUserId: string;
  workspaceId: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `
      insert into memory_replicas (runner_user_id, workspace_id)
      values ($1, $2)
      on conflict (runner_user_id, workspace_id)
      do update set updated_at = now()
      returning id
    `,
    [args.runnerUserId, args.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to ensure memory replica");
  return row.id;
}

export async function ensureMemoryEntrypoint(replicaId: number): Promise<MemoryFileRecord> {
  const existing = await readMemoryFile(replicaId, MEMORY_ENTRYPOINT, { includeDeleted: false });
  if (existing) return existing;
  return writeMemoryFile({
    replicaId,
    path: MEMORY_ENTRYPOINT,
    content: "",
    origin: "system",
  });
}

export async function getMemoryEntrypoint(replicaId: number): Promise<string> {
  const file = await ensureMemoryEntrypoint(replicaId);
  return file.content;
}

export async function listMemoryFiles(
  replicaId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<MemoryFileRecord[]> {
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where replica_id = $1
        and ($2::boolean or deleted_at is null)
      order by path asc
    `,
    [replicaId, opts.includeDeleted === true],
  );
  return result.rows.map(toMemoryFile);
}

export async function readMemoryFile(
  replicaId: number,
  rawPath: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<MemoryFileRecord | null> {
  const path = normalizeMemoryPath(rawPath);
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where replica_id = $1
        and path = $2
        and ($3::boolean or deleted_at is null)
      limit 1
    `,
    [replicaId, path, opts.includeDeleted === true],
  );
  const row = result.rows[0];
  return row ? toMemoryFile(row) : null;
}

export async function writeMemoryFile(args: {
  replicaId: number;
  path: string;
  content: string;
  origin: MemoryOrigin;
}): Promise<MemoryFileRecord> {
  const path = normalizeMemoryPath(args.path);
  const contentHash = hashContent(args.content);
  const taskMeta = extractTaskMetaSafe(path, args.content);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const currentResult = await client.query<DbMemoryFile>(
      `
        select *
        from memory_files
        where replica_id = $1 and path = $2
        for update
      `,
      [args.replicaId, path],
    );
    const current = currentResult.rows[0];
    const nextRevision = (current?.revision ?? 0) + 1;
    const operation: MemoryOperation = current ? "write" : "create";

    const fileResult = await client.query<DbMemoryFile>(
      `
        insert into memory_files (
          replica_id, path, content, content_hash, revision, origin, deleted_at, task_meta, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, null, $7::jsonb, now())
        on conflict (replica_id, path)
        do update set
          content = excluded.content,
          content_hash = excluded.content_hash,
          revision = excluded.revision,
          origin = excluded.origin,
          deleted_at = null,
          task_meta = excluded.task_meta,
          updated_at = now()
        returning *
      `,
      [
        args.replicaId,
        path,
        args.content,
        contentHash,
        nextRevision,
        args.origin,
        taskMeta ? JSON.stringify(taskMeta) : null,
      ],
    );
    const parentRevisionId = await latestRevisionIdForFile(client, args.replicaId, path);
    await client.query(
      `
        insert into memory_file_revisions (
          replica_id, path, content, content_hash, file_revision, origin, operation, parent_revision_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        args.replicaId,
        path,
        args.content,
        contentHash,
        nextRevision,
        args.origin,
        operation,
        parentRevisionId,
      ],
    );
    await client.query("commit");

    const row = fileResult.rows[0];
    if (!row) throw new Error("failed to write memory file");
    return toMemoryFile(row);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

function extractTaskMetaSafe(path: string, content: string): TaskMeta | null {
  try {
    return extractTaskMeta(path, content);
  } catch (err) {
    console.warn("task frontmatter parse failed", { path, err });
    return null;
  }
}

type DbClient = {
  query: <R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

async function latestRevisionIdForFile(
  client: DbClient,
  replicaId: number,
  path: string,
): Promise<number | null> {
  const result = await client.query<{ id: number }>(
    `
      select id from memory_file_revisions
      where replica_id = $1 and path = $2
      order by id desc
      limit 1
    `,
    [replicaId, path],
  );
  return result.rows[0]?.id ?? null;
}

export type SyncPushOutcome =
  | { kind: "fast_forward"; file: MemoryFileRecord; latestRevisionRowId: number }
  | { kind: "create"; file: MemoryFileRecord; latestRevisionRowId: number }
  | { kind: "noop"; file: MemoryFileRecord; latestRevisionRowId: number }
  | {
      kind: "merged";
      file: MemoryFileRecord;
      latestRevisionRowId: number;
      hadBodyConflict: boolean;
      hadFrontmatterConflict: boolean;
      notes: string[];
    };

/**
 * Public helper: latest memory_file_revisions.id for a file (the global row
 * counter, not the per-file counter). Used by the daemon to track its
 * lastSyncedRevisionId for the three-way merge protocol.
 */
export async function getLatestRevisionRowIdForFile(
  replicaId: number,
  path: string,
): Promise<number | null> {
  const result = await pool.query<{ id: number }>(
    `
      select id from memory_file_revisions
      where replica_id = $1 and path = $2
      order by id desc
      limit 1
    `,
    [replicaId, path],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * The bidirectional push primitive. Used by /api/memory/sync/push.
 *
 * If `baseRevisionId` is null, treats this as a create or unconditional
 * overwrite (legacy clients without ancestry).
 *
 * If `baseRevisionId` matches the current head's parent (i.e. fast-forward),
 * writes a new revision.
 *
 * If `baseRevisionId` is older than head, runs a three-way merge using the
 * base, the current head, and the incoming content. Writes the merged
 * content as a new revision with merge_parent_id set.
 */
export async function syncPushFile(args: {
  replicaId: number;
  path: string;
  content: string;
  origin: MemoryOrigin;
  baseRevisionId: number | null;
}): Promise<SyncPushOutcome> {
  const path = normalizeMemoryPath(args.path);
  const incomingHash = hashContent(args.content);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const currentResult = await client.query<DbMemoryFile>(
      `select * from memory_files where replica_id = $1 and path = $2 for update`,
      [args.replicaId, path],
    );
    const current = currentResult.rows[0];

    // No current row → first creation. Just insert.
    if (!current) {
      await client.query("commit");
      client.release();
      const file = await writeMemoryFile({
        replicaId: args.replicaId,
        path,
        content: args.content,
        origin: args.origin,
      });
      const latestRevisionRowId =
        (await getLatestRevisionRowIdForFile(args.replicaId, path)) ?? 0;
      return { kind: "create", file, latestRevisionRowId };
    }

    // Identical content already on head → noop.
    if (!current.deleted_at && current.content_hash === incomingHash) {
      await client.query("rollback");
      const headRowId = (await getLatestRevisionRowIdForFile(args.replicaId, path)) ?? 0;
      return { kind: "noop", file: toMemoryFile(current), latestRevisionRowId: headRowId };
    }

    const headRevId = await latestRevisionIdForFile(client, args.replicaId, path);

    // No base supplied → legacy / first-write behavior, fast-forward.
    if (args.baseRevisionId == null || args.baseRevisionId === headRevId) {
      await client.query("rollback");
      client.release();
      const file = await writeMemoryFile({
        replicaId: args.replicaId,
        path,
        content: args.content,
        origin: args.origin,
      });
      const latestRevisionRowId =
        (await getLatestRevisionRowIdForFile(args.replicaId, path)) ?? 0;
      return { kind: "fast_forward", file, latestRevisionRowId };
    }

    // baseRevisionId is older than head → three-way merge.
    const baseRevisionId: number = args.baseRevisionId;
    const headRevision = headRevId == null ? null : await loadRevision(client, headRevId);
    const baseRevision = await loadRevision(client, baseRevisionId);
    if (!headRevision || !baseRevision) {
      // Can't merge; fall back to fast-forward (last writer wins).
      await client.query("rollback");
      client.release();
      const file = await writeMemoryFile({
        replicaId: args.replicaId,
        path,
        content: args.content,
        origin: args.origin,
      });
      const latestRevisionRowId =
        (await getLatestRevisionRowIdForFile(args.replicaId, path)) ?? 0;
      return { kind: "fast_forward", file, latestRevisionRowId };
    }

    const merged = mergeFile({
      base: {
        content: baseRevision.content,
        origin: baseRevision.origin as MergeOrigin,
        revisionTimestamp: baseRevision.created_at,
      },
      head: {
        content: headRevision.content,
        origin: headRevision.origin as MergeOrigin,
        revisionTimestamp: headRevision.created_at,
      },
      incoming: {
        content: args.content,
        origin: args.origin as MergeOrigin,
        revisionTimestamp: new Date(),
      },
    });

    const mergedHash = hashContent(merged.mergedContent);
    const taskMeta = extractTaskMetaSafe(path, merged.mergedContent);
    const nextRevision = current.revision + 1;
    const fileResult = await client.query<DbMemoryFile>(
      `
        update memory_files
        set content = $3,
            content_hash = $4,
            revision = $5,
            origin = $6,
            deleted_at = null,
            task_meta = $7::jsonb,
            updated_at = now()
        where replica_id = $1 and path = $2
        returning *
      `,
      [
        args.replicaId,
        path,
        merged.mergedContent,
        mergedHash,
        nextRevision,
        args.origin,
        taskMeta ? JSON.stringify(taskMeta) : null,
      ],
    );
    const revInsert = await client.query<{ id: number }>(
      `
        insert into memory_file_revisions (
          replica_id, path, content, content_hash, file_revision, origin,
          operation, parent_revision_id, merge_parent_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id
      `,
      [
        args.replicaId,
        path,
        merged.mergedContent,
        mergedHash,
        nextRevision,
        args.origin,
        "write",
        headRevId,
        baseRevisionId,
      ],
    );
    await client.query("commit");
    const row = fileResult.rows[0];
    if (!row) throw new Error("failed to write merged revision");
    const latestRevisionRowId = revInsert.rows[0]?.id ?? 0;
    return {
      kind: "merged",
      file: toMemoryFile(row),
      latestRevisionRowId,
      hadBodyConflict: merged.hadBodyConflict,
      hadFrontmatterConflict: merged.hadFrontmatterConflict,
      notes: merged.notes,
    };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // ignore — connection may be released
    }
    throw err;
  } finally {
    try {
      client.release();
    } catch {
      // already released above
    }
  }
}

async function loadRevision(
  client: DbClient,
  id: number,
): Promise<DbMemoryRevision | null> {
  const result = await client.query<DbMemoryRevision>(
    `select * from memory_file_revisions where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function editMemoryFile(args: {
  replicaId: number;
  path: string;
  oldText: string;
  newText: string;
  origin: MemoryOrigin;
}): Promise<MemoryFileRecord> {
  if (!args.oldText) throw new Error("old_text is required");
  const existing = await readMemoryFile(args.replicaId, args.path);
  if (!existing) throw new Error(`memory file not found: ${normalizeMemoryPath(args.path)}`);
  if (!existing.content.includes(args.oldText)) {
    throw new Error("old_text was not found in the memory file");
  }
  return writeMemoryFile({
    replicaId: args.replicaId,
    path: args.path,
    content: existing.content.replace(args.oldText, args.newText),
    origin: args.origin,
  });
}

export async function deleteMemoryFile(args: {
  replicaId: number;
  path: string;
  origin: MemoryOrigin;
}): Promise<MemoryFileRecord> {
  const path = normalizeMemoryPath(args.path);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const currentResult = await client.query<DbMemoryFile>(
      `
        select *
        from memory_files
        where replica_id = $1 and path = $2
        for update
      `,
      [args.replicaId, path],
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error(`memory file not found: ${path}`);
    const nextRevision = current.revision + 1;

    const fileResult = await client.query<DbMemoryFile>(
      `
        update memory_files
        set revision = $3,
            origin = $4,
            deleted_at = now(),
            task_meta = null,
            updated_at = now()
        where replica_id = $1 and path = $2
        returning *
      `,
      [args.replicaId, path, nextRevision, args.origin],
    );
    await client.query(
      `
        insert into memory_file_revisions (
          replica_id, path, content, content_hash, file_revision, origin, operation
        )
        values ($1, $2, '', $3, $4, $5, 'delete')
      `,
      [args.replicaId, path, hashContent(""), nextRevision, args.origin],
    );
    await client.query("commit");

    const row = fileResult.rows[0];
    if (!row) throw new Error("failed to delete memory file");
    return toMemoryFile(row);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function searchMemoryFiles(args: {
  replicaId: number;
  query: string;
  limit?: number;
}): Promise<MemoryFileRecord[]> {
  const query = args.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const like = `%${query}%`;
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where replica_id = $1
        and deleted_at is null
        and path <> $2
        and (path ilike $3 or content ilike $3)
      order by updated_at desc
      limit $4
    `,
    [args.replicaId, MEMORY_ENTRYPOINT, like, limit],
  );
  return result.rows.map(toMemoryFile);
}

/**
 * List all task files for a replica. Includes done tasks; the caller filters
 * by completed_at for the "done today" UI cutoff.
 */
export async function listTasks(replicaId: number): Promise<MemoryFileRecord[]> {
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where replica_id = $1
        and deleted_at is null
        and task_meta is not null
      order by updated_at desc
    `,
    [replicaId],
  );
  return result.rows.map(toMemoryFile);
}

/**
 * Find tasks across ALL replicas whose next_check_in is due. Used by the cron
 * task sweep. Each row carries the replicaId so the caller can join back to
 * the user.
 */
export async function findDueTasks(now: Date): Promise<MemoryFileRecord[]> {
  const activeStatuses = ACTIVE_TASK_STATUSES.slice();
  // Compare ISO strings lexically — same ordering as timestamptz when both
  // are normalized to UTC (which our parser ensures). Lets us use the
  // expression index on (task_meta->>'nextCheckIn').
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where deleted_at is null
        and task_meta is not null
        and (task_meta->>'status') = any($1::text[])
        and (task_meta->>'nextCheckIn') is not null
        and (task_meta->>'nextCheckIn') <= $2
      order by replica_id asc, (task_meta->>'nextCheckIn') asc
    `,
    [activeStatuses as readonly string[], now.toISOString()],
  );
  return result.rows.map(toMemoryFile);
}

export type TaskStatusForQuery = TaskStatus;

/**
 * Backfill task_meta for any rows that have task-shaped paths but null cache.
 * Idempotent — safe to run repeatedly.
 */
export async function backfillTaskMeta(): Promise<{ scanned: number; updated: number }> {
  const result = await pool.query<DbMemoryFile>(
    `
      select *
      from memory_files
      where deleted_at is null
        and path like 'tasks/%.md'
    `,
  );
  let updated = 0;
  for (const row of result.rows) {
    const meta = extractTaskMetaSafe(row.path, row.content);
    if (!meta && row.task_meta == null) continue;
    const same = meta != null && row.task_meta != null && tasksEqual(meta, row.task_meta);
    if (same) continue;
    await pool.query("update memory_files set task_meta = $2::jsonb where id = $1", [
      row.id,
      meta ? JSON.stringify(meta) : null,
    ]);
    updated += 1;
  }
  return { scanned: result.rows.length, updated };
}

function tasksEqual(a: TaskMeta, b: TaskMeta): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.status === b.status &&
    a.nextStep === b.nextStep &&
    a.nextCheckIn === b.nextCheckIn &&
    a.completedAt === b.completedAt
  );
}

/** Helper used in tests — re-exposed for callers that already have a row. */
export function isTaskFile(path: string): boolean {
  return isTaskPath(path);
}

export async function pullMemoryRevisions(args: {
  replicaId: number;
  sinceRevisionId: number;
}): Promise<MemoryRevisionRecord[]> {
  const result = await pool.query<DbMemoryRevision>(
    `
      select *
      from memory_file_revisions
      where replica_id = $1 and id > $2
      order by id asc
    `,
    [args.replicaId, args.sinceRevisionId],
  );
  return result.rows.map(toMemoryRevision);
}

export async function getLatestMemoryRevisionId(replicaId: number): Promise<number> {
  const result = await pool.query<{ id: number | null }>(
    "select max(id) as id from memory_file_revisions where replica_id = $1",
    [replicaId],
  );
  return result.rows[0]?.id ?? 0;
}

export async function registerMemorySyncClient(args: {
  runnerUserId: string;
  workspaceId: string;
  label: string;
}): Promise<{ clientId: string; replicaId: number; token: string }> {
  const replicaId = await ensureMemoryReplica({
    runnerUserId: args.runnerUserId,
    workspaceId: args.workspaceId,
  });
  await ensureMemoryEntrypoint(replicaId);

  const clientId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `rmcs_${clientId}_${secret}`;
  await pool.query(
    `
      insert into memory_sync_clients (id, replica_id, label, token_hash)
      values ($1, $2, $3, $4)
    `,
    [clientId, replicaId, args.label, hashSyncToken(token)],
  );
  return { clientId, replicaId, token };
}

export async function authenticateMemorySyncToken(
  token: string,
): Promise<{ clientId: string; replicaId: number } | null> {
  const result = await pool.query<{ id: string; replica_id: number }>(
    `
      update memory_sync_clients
      set last_seen_at = now()
      where token_hash = $1 and revoked_at is null
      returning id, replica_id
    `,
    [hashSyncToken(token)],
  );
  const row = result.rows[0];
  return row ? { clientId: row.id, replicaId: row.replica_id } : null;
}

export async function revokeMemorySyncClient(clientId: string): Promise<boolean> {
  const result = await pool.query(
    `
      update memory_sync_clients
      set revoked_at = now()
      where id = $1 and revoked_at is null
    `,
    [clientId],
  );
  return (result.rowCount ?? 0) > 0;
}
