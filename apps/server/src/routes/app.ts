/**
 * Mobile web app endpoints. Auth via the user's magic-auth JWT (the same
 * token the microsite already gets from /auth/magic-auth/verify), passed as
 * `Authorization: Bearer <jwt>` plus `x-runner-workspace`, `x-runner-user-id`,
 * `x-runner-email` headers.
 *
 * All task content stays in the existing memory_files store — markdown is
 * the source of truth, structured fields come from the parsed task_meta
 * cache. Optimistic concurrency uses the file revision number as ETag.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  consumePhoneLinkCode,
  db,
  deleteMemoryFile,
  ensureMemoryEntrypoint,
  getPhoneLinkCodeStatus,
  issuePhoneLinkCode,
  listTasks,
  readMemoryFile,
  users,
  writeMemoryFile,
  type MemoryFileRecord,
  type User,
} from "@runner-mobile/db";
import {
  ACTIVE_TASK_STATUSES,
  buildTaskFile,
  isTaskPath,
  parseTaskFile,
  taskPathFromTitle,
  TASK_PATH_PREFIX,
  type TaskMeta,
  type TaskStatus,
} from "@runner-mobile/tasks";
import { resumeOrSpawnAndRun } from "@runner-mobile/managed-agents";
import { getCatalog, refreshIfExpired } from "@runner-mobile/runner-api";
import { sendOutbound, type SpectrumApp } from "@runner-mobile/spectrum";
import { requireAppAuth, type AppAuthRequest } from "./app_auth.ts";

export function makeAppRouter(getSpectrumApp: () => SpectrumApp | null): Router {
  const router = Router();

  router.use(requireAppAuth);

  // ---- /me -----------------------------------------------------------

  router.get("/me", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.runnerUserId, auth.runnerUserId))
      .limit(1);
    const user = existing[0] ?? null;
    res.json({
      email: auth.email,
      runnerUserId: auth.runnerUserId,
      workspaceId: auth.workspaceId,
      phoneNumber: user?.phoneNumber ?? null,
      assignedPhoneNumber: user?.assignedPhoneNumber ?? null,
      timeZone: user?.timeZone ?? null,
    });
  });

  // ---- Phone link ----------------------------------------------------

  router.post("/phone/start", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const refreshToken =
      typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null;
    const jwtExpiresAt =
      typeof req.body?.jwt_expires_at === "string" ? req.body.jwt_expires_at : null;
    const timeZone =
      typeof req.body?.time_zone === "string" && req.body.time_zone.trim()
        ? req.body.time_zone.trim()
        : null;
    if (!refreshToken || !jwtExpiresAt) {
      res.status(400).json({ error: "missing_auth_bundle" });
      return;
    }

    const code = await issuePhoneLinkCode({
      runnerUserId: auth.runnerUserId,
      workspaceId: auth.workspaceId,
      email: auth.email,
      jwt: auth.jwt,
      refreshToken,
      jwtExpiresAt: new Date(jwtExpiresAt),
      timeZone,
    });

    const runnerNumber = process.env.RUNNER_PUBLIC_PHONE_NUMBER ?? null;
    res.json({
      code: code.code,
      expiresAt: code.expiresAt.toISOString(),
      runnerPhoneNumber: runnerNumber,
    });
  });

  router.get("/phone/status", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      res.status(400).json({ error: "missing_code" });
      return;
    }
    const status = await getPhoneLinkCodeStatus(code);
    if (!status) {
      res.status(404).json({ error: "unknown_code" });
      return;
    }
    let phoneNumber: string | null = null;
    if (status.consumedPhone) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.runnerUserId, auth.runnerUserId))
        .limit(1);
      phoneNumber = rows[0]?.phoneNumber ?? status.consumedPhone;
    }
    res.json({
      pending: status.pending,
      expired: status.expired,
      linked: status.consumedPhone != null,
      phoneNumber,
    });
  });

  // ---- Tasks ---------------------------------------------------------

  router.get("/tasks", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const rows = await listTasks(auth.replicaId);
    res.json({ tasks: rows.map(toTaskSummary) });
  });

  router.get("/tasks/:slug", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const slug = req.params.slug;
    if (typeof slug !== "string" || !slug) {
      res.status(400).json({ error: "missing_slug" });
      return;
    }
    const path = taskPathFromSlug(slug);
    const file = await readMemoryFile(auth.replicaId, path);
    if (!file || !file.taskMeta) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ task: toTaskFull(file) });
  });

  const patchSchema = z.object({
    status: z.enum(ACTIVE_TASK_STATUSES_PLUS_DONE).optional(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    nextStep: z.string().optional(),
    nextCheckIn: z.string().nullable().optional(),
    body: z.string().optional(),
    revision: z.number().int().nonnegative(),
  });

  router.patch("/tasks/:slug", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const slug = req.params.slug;
    if (typeof slug !== "string" || !slug) {
      res.status(400).json({ error: "missing_slug" });
      return;
    }
    const path = taskPathFromSlug(slug);
    const existing = await readMemoryFile(auth.replicaId, path);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.revision !== parsed.data.revision) {
      res.status(409).json({
        error: "revision_conflict",
        current: toTaskFull(existing),
      });
      return;
    }

    const current = parseTaskFile(existing.content);
    if (!current) {
      res.status(409).json({ error: "not_a_task" });
      return;
    }

    const nextMeta: TaskMeta = {
      name: parsed.data.name ?? current.meta.name,
      description: parsed.data.description ?? current.meta.description,
      status: parsed.data.status ?? current.meta.status,
      nextStep:
        parsed.data.nextStep === undefined ? current.meta.nextStep : parsed.data.nextStep,
      nextCheckIn:
        parsed.data.nextCheckIn === undefined
          ? current.meta.nextCheckIn
          : parsed.data.nextCheckIn,
      completedAt: current.meta.completedAt,
    };
    if (nextMeta.status === "done" && !nextMeta.completedAt) {
      nextMeta.completedAt = new Date().toISOString();
    } else if (nextMeta.status !== "done" && nextMeta.completedAt) {
      nextMeta.completedAt = null;
    }

    const body = parsed.data.body ?? current.body;
    const content = buildTaskFile({ meta: nextMeta, body });
    const updated = await writeMemoryFile({
      replicaId: auth.replicaId,
      path,
      content,
      origin: "web",
    });
    res.json({ task: toTaskFull(updated) });
  });

  router.delete("/tasks/:slug", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const slug = req.params.slug;
    if (typeof slug !== "string" || !slug) {
      res.status(400).json({ error: "missing_slug" });
      return;
    }
    const path = taskPathFromSlug(slug);
    try {
      await deleteMemoryFile({ replicaId: auth.replicaId, path, origin: "web" });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: errMsg(err) });
    }
  });

  const createSchema = z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(8000).optional(),
  });

  router.post("/tasks", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const path = await uniqueTaskPath(auth.replicaId, parsed.data.title);
    const meta: TaskMeta = {
      name: parsed.data.title,
      description: null,
      status: "triage",
      nextStep: "Runner is reviewing this and will pick a next step.",
      nextCheckIn: null,
      completedAt: null,
    };
    const content = buildTaskFile({ meta, body: parsed.data.body ?? "" });
    const file = await writeMemoryFile({
      replicaId: auth.replicaId,
      path,
      content,
      origin: "web",
    });

    // Fire-and-forget: wake the agent so it processes the new triage task
    // immediately, instead of waiting for the next cron tick.
    void wakeAgentForUser({
      runnerUserId: auth.runnerUserId,
      message: `[new task] ${path}`,
      getSpectrumApp,
    }).catch((err) => console.error("wakeAgentForUser failed (new task):", err));

    res.json({ task: toTaskFull(file) });
  });

  router.post("/tasks/:slug/nudge", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    const slug = req.params.slug;
    if (typeof slug !== "string" || !slug) {
      res.status(400).json({ error: "missing_slug" });
      return;
    }
    const path = taskPathFromSlug(slug);
    const file = await readMemoryFile(auth.replicaId, path);
    if (!file) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    void wakeAgentForUser({
      runnerUserId: auth.runnerUserId,
      message: `[task check-in: ${path}] (user-nudge)`,
      getSpectrumApp,
    }).catch((err) => console.error("wakeAgentForUser failed (nudge):", err));
    res.json({ ok: true });
  });

  // Touch: keep MEMORY.md row alive on first hit so getMemoryEntrypoint
  // doesn't 404 a brand-new replica.
  router.post("/_warm", async (req: AppAuthRequest, res) => {
    const auth = req.appAuth!;
    await ensureMemoryEntrypoint(auth.replicaId);
    res.json({ ok: true });
  });

  return router;
}

const ACTIVE_TASK_STATUSES_PLUS_DONE = [
  ...ACTIVE_TASK_STATUSES,
  "done",
] as unknown as readonly [TaskStatus, ...TaskStatus[]];

function taskPathFromSlug(slug: string): string {
  // URL-decode and reattach the prefix; the route param is the bare slug
  // without the leading `tasks/` and without `.md`.
  const decoded = decodeURIComponent(slug);
  if (decoded.includes("/") || decoded.includes("..") || !decoded) {
    throw new Error("invalid_slug");
  }
  return `${TASK_PATH_PREFIX}${decoded}.md`;
}

async function uniqueTaskPath(replicaId: number, title: string): Promise<string> {
  const base = taskPathFromTitle(title);
  for (let i = 0; i < 10; i += 1) {
    const candidate = i === 0 ? base : base.replace(/\.md$/, `-${i + 1}.md`);
    const existing = await readMemoryFile(replicaId, candidate, { includeDeleted: true });
    if (!existing || existing.deletedAt) return candidate;
  }
  return base.replace(/\.md$/, `-${Date.now()}.md`);
}

type TaskSummary = {
  path: string;
  slug: string;
  revision: number;
  origin: string;
  updatedAt: string;
  meta: TaskMeta;
};

function toTaskSummary(file: MemoryFileRecord): TaskSummary {
  if (!file.taskMeta) throw new Error("listTasks returned non-task row");
  return {
    path: file.path,
    slug: file.path.replace(/^tasks\//, "").replace(/\.md$/, ""),
    revision: file.revision,
    origin: file.origin,
    updatedAt: file.updatedAt.toISOString(),
    meta: file.taskMeta,
  };
}

function toTaskFull(file: MemoryFileRecord): TaskSummary & { body: string; content: string } {
  const parsed = isTaskPath(file.path) ? parseTaskFile(file.content) : null;
  return {
    ...toTaskSummary(file),
    body: parsed?.body ?? "",
    content: file.content,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the user, refresh JWT, and run one synthetic-message turn. Used by
 * quick-capture and nudge so the agent reacts immediately.
 */
async function wakeAgentForUser(opts: {
  runnerUserId: string;
  message: string;
  getSpectrumApp: () => SpectrumApp | null;
}): Promise<void> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.runnerUserId, opts.runnerUserId))
    .limit(1);
  const user: User | undefined = rows[0];
  if (!user) return;
  const spectrumApp = opts.getSpectrumApp();
  const refreshed = await refreshIfExpired(user);
  const catalog = await getCatalog(refreshed.jwt, refreshed.workspaceId);
  const sendImessage = (msg: string) =>
    spectrumApp ? sendOutbound(spectrumApp, refreshed.phoneNumber, msg) : Promise.resolve();
  const sent = await resumeOrSpawnAndRun({
    user: refreshed,
    catalog,
    userMessage: opts.message,
    onSendIMessage: sendImessage,
  });
  if (sent) {
    await db
      .update(users)
      .set({ lastAssistantMsgAt: sql`now()` })
      .where(eq(users.phoneNumber, refreshed.phoneNumber));
  }
}
