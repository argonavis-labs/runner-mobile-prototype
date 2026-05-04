import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  authenticateMemorySyncToken,
  deleteMemoryFile,
  editMemoryFile,
  ensureMemoryEntrypoint,
  getLatestMemoryRevisionId,
  getLatestRevisionRowIdForFile,
  listMemoryFiles,
  pullMemoryRevisions,
  readMemoryFile,
  registerMemorySyncClient,
  revokeMemorySyncClient,
  searchMemoryFiles,
  syncPushFile,
  writeMemoryFile,
  type SyncPushOutcome,
} from "@runner-mobile/db";
import { listWorkspaces } from "@runner-mobile/runner-api";

type MemoryRequest = Request & {
  memoryAuth?: {
    clientId: string;
    replicaId: number;
  };
};

const registerSchema = z.object({
  access_token: z.string().min(1),
  runner_user_id: z.string().min(1),
  workspace_id: z.string().min(1),
  label: z.string().min(1).max(120).default("Mac sync client"),
});

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const editSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
});

const pushSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string().optional(),
      deleted: z.boolean().optional(),
      base_revision_id: z.number().int().nonnegative().nullable().optional(),
    }),
  ),
  protocol_version: z.number().int().optional(),
});

function bearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

async function requireMemoryAuth(req: MemoryRequest, res: Response, next: () => void) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: "missing_token" });
    return;
  }

  const auth = await authenticateMemorySyncToken(token);
  if (!auth) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  req.memoryAuth = auth;
  next();
}

function replicaId(req: MemoryRequest): number {
  const id = req.memoryAuth?.replicaId;
  if (!id) throw new Error("memory auth missing");
  return id;
}

function pathFromQuery(req: Request): string {
  const value = req.query.path;
  if (typeof value !== "string") throw new Error("path query parameter is required");
  return value;
}

export const memoryRouter: Router = Router();

memoryRouter.post("/clients/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  try {
    const workspaces = await listWorkspaces(parsed.data.access_token);
    const ownsWorkspace = workspaces.some((w) => w.id === parsed.data.workspace_id);
    if (!ownsWorkspace) {
      res.status(403).json({ error: "workspace_not_owned" });
      return;
    }

    const registered = await registerMemorySyncClient({
      runnerUserId: parsed.data.runner_user_id,
      workspaceId: parsed.data.workspace_id,
      label: parsed.data.label,
    });
    res.json(registered);
  } catch (err) {
    console.error("memory client registration failed:", err);
    res.status(500).json({ error: "registration_failed" });
  }
});

memoryRouter.use(requireMemoryAuth);

memoryRouter.get("/files", async (req: MemoryRequest, res) => {
  const includeDeleted = req.query.includeDeleted === "true";
  const files = await listMemoryFiles(replicaId(req), { includeDeleted });
  res.json({ files, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
});

memoryRouter.get("/file", async (req: MemoryRequest, res) => {
  try {
    const file = await readMemoryFile(replicaId(req), pathFromQuery(req));
    if (!file) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ file });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "bad_request" });
  }
});

memoryRouter.put("/file", async (req: MemoryRequest, res) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  try {
    const file = await writeMemoryFile({
      replicaId: replicaId(req),
      path: parsed.data.path,
      content: parsed.data.content,
      origin: "local",
    });
    res.json({ file, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "bad_request" });
  }
});

memoryRouter.patch("/file", async (req: MemoryRequest, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  try {
    const file = await editMemoryFile({
      replicaId: replicaId(req),
      path: parsed.data.path,
      oldText: parsed.data.old_text,
      newText: parsed.data.new_text,
      origin: "local",
    });
    res.json({ file, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "bad_request" });
  }
});

memoryRouter.delete("/file", async (req: MemoryRequest, res) => {
  try {
    const file = await deleteMemoryFile({
      replicaId: replicaId(req),
      path: pathFromQuery(req),
      origin: "local",
    });
    res.json({ file, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "bad_request" });
  }
});

memoryRouter.get("/search", async (req: MemoryRequest, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const files = await searchMemoryFiles({ replicaId: replicaId(req), query, limit });
  res.json({ files });
});

memoryRouter.post("/sync/push", async (req: MemoryRequest, res) => {
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const changed: Array<{
    path: string;
    outcome: SyncPushOutcome["kind"];
    file: SyncPushOutcome["file"];
    latestRevisionRowId: number;
    hadBodyConflict?: boolean;
    hadFrontmatterConflict?: boolean;
    notes?: string[];
  }> = [];
  for (const incoming of parsed.data.files) {
    try {
      if (incoming.deleted) {
        const existing = await readMemoryFile(replicaId(req), incoming.path, {
          includeDeleted: true,
        });
        if (existing && !existing.deletedAt) {
          const file = await deleteMemoryFile({
            replicaId: replicaId(req),
            path: incoming.path,
            origin: "local",
          });
          const latestRevisionRowId =
            (await getLatestRevisionRowIdForFile(replicaId(req), incoming.path)) ?? 0;
          changed.push({
            path: incoming.path,
            outcome: "fast_forward",
            file,
            latestRevisionRowId,
          });
        }
        continue;
      }

      const content = incoming.content ?? "";
      const result = await syncPushFile({
        replicaId: replicaId(req),
        path: incoming.path,
        content,
        origin: "local",
        baseRevisionId: incoming.base_revision_id ?? null,
      });
      const entry: (typeof changed)[number] = {
        path: incoming.path,
        outcome: result.kind,
        file: result.file,
        latestRevisionRowId: result.latestRevisionRowId,
      };
      if (result.kind === "merged") {
        entry.hadBodyConflict = result.hadBodyConflict;
        entry.hadFrontmatterConflict = result.hadFrontmatterConflict;
        entry.notes = result.notes;
      }
      changed.push(entry);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "bad_request",
        path: incoming.path,
      });
      return;
    }
  }

  res.json({ changed, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
});

memoryRouter.get("/sync/pull", async (req: MemoryRequest, res) => {
  const since = typeof req.query.since === "string" ? Number(req.query.since) : 0;
  if (!Number.isFinite(since) || since < 0) {
    res.status(400).json({ error: "invalid_since" });
    return;
  }
  await ensureMemoryEntrypoint(replicaId(req));
  const revisions = await pullMemoryRevisions({
    replicaId: replicaId(req),
    sinceRevisionId: since,
  });
  res.json({ revisions, latestRevisionId: await getLatestMemoryRevisionId(replicaId(req)) });
});

memoryRouter.post("/clients/revoke", async (req: MemoryRequest, res) => {
  const clientId =
    typeof req.body?.client_id === "string" ? req.body.client_id : req.memoryAuth?.clientId;
  if (!clientId) {
    res.status(400).json({ error: "client_id_required" });
    return;
  }
  res.json({ revoked: await revokeMemorySyncClient(clientId) });
});
