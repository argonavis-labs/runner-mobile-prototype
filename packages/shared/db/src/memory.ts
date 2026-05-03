import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pool } from "./client.ts";

const MEMORY_ENTRYPOINT = "MEMORY.md";

export type MemoryOrigin = "local" | "mobile" | "system";
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
          replica_id, path, content, content_hash, revision, origin, deleted_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, null, now())
        on conflict (replica_id, path)
        do update set
          content = excluded.content,
          content_hash = excluded.content_hash,
          revision = excluded.revision,
          origin = excluded.origin,
          deleted_at = null,
          updated_at = now()
        returning *
      `,
      [args.replicaId, path, args.content, contentHash, nextRevision, args.origin],
    );
    await client.query(
      `
        insert into memory_file_revisions (
          replica_id, path, content, content_hash, file_revision, origin, operation
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [args.replicaId, path, args.content, contentHash, nextRevision, args.origin, operation],
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
