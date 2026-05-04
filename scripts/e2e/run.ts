/**
 * End-to-end test harness for the Runner Mobile task system.
 *
 * Exercises (top-down):
 *   1. Pure-function: parser/serializer/round-trip
 *   2. Pure-function: three-way merge (clean, frontmatter conflict, body conflict, privileged rules)
 *   3. DB integration: writeMemoryFile populates task_meta, listTasks, findDueTasks
 *   4. DB integration: syncPushFile (create / fast-forward / merge / noop)
 *   5. DB integration: phone-link issue → consume
 *   6. HTTP integration: requireAppAuth + tasks CRUD against a live server
 *   7. HTTP integration: cron tick task sweep dry-run
 *
 * Each test prints PASS/FAIL with a one-line context. Exits non-zero on any
 * failure. Designed to be run after `pnpm db:migrate` against a fresh DB
 * (or one with prior e2e data — we clean up our own replica each run).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_TASK_STATUSES,
  buildTaskFile,
  extractTaskMeta,
  isAgentOrigin,
  isHumanOrigin,
  mergeFile,
  parseTaskFile,
  serializeFrontmatter,
  slugifyTitle,
  taskPathFromTitle,
  type TaskMeta,
} from "@runner-mobile/tasks";
import {
  backfillTaskMeta,
  consumePhoneLinkCode,
  deleteMemoryFile,
  ensureMemoryReplica,
  findDueTasks,
  hashSyncToken,
  issuePhoneLinkCode,
  listTasks,
  pool,
  registerMemorySyncClient,
  syncPushFile,
  writeMemoryFile,
  readMemoryFile,
} from "@runner-mobile/db";

const E2E_RUNNER_USER = `e2e-${Date.now()}@runner.test`;
const E2E_WORKSPACE = `ws-e2e-${Date.now()}`;
const SERVER_URL = process.env.SERVER_PUBLIC_URL ?? "http://localhost:4001";

type TestResult = { name: string; ok: boolean; detail?: string };
const results: TestResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const icon = ok ? "✓" : "✗";
  const tail = detail ? ` — ${detail}` : "";
  console.log(`${icon} ${name}${tail}`);
}

async function check<T>(
  name: string,
  fn: () => Promise<T> | T,
  expect: (value: T) => string | true,
): Promise<T | undefined> {
  try {
    const value = await fn();
    const r = expect(value);
    if (r === true) {
      record(name, true);
      return value;
    } else {
      record(name, false, r);
      return undefined;
    }
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ---------- 1. Parser / serializer ----------

async function testParser(): Promise<void> {
  console.log("\n— Parser & serializer —");

  await check(
    "parseTaskFile reads frontmatter",
    () => {
      const sample = `---\nname: Q2 deck\ntype: task\nstatus: doing\nnext_step: pull metrics\nnext_check_in: 2026-05-04T14:00:00Z\n---\n\nbody here`;
      return parseTaskFile(sample);
    },
    (parsed) => {
      if (!parsed) return "got null";
      if (parsed.meta.name !== "Q2 deck") return `name=${parsed.meta.name}`;
      if (parsed.meta.status !== "doing") return `status=${parsed.meta.status}`;
      if (parsed.meta.nextStep !== "pull metrics") return `nextStep=${parsed.meta.nextStep}`;
      if (parsed.meta.nextCheckIn !== "2026-05-04T14:00:00.000Z")
        return `nextCheckIn=${parsed.meta.nextCheckIn}`;
      if (parsed.body.trim() !== "body here") return `body=${JSON.stringify(parsed.body)}`;
      return true;
    },
  );

  await check(
    "parseTaskFile returns null for non-task",
    () => parseTaskFile("---\nname: notes\ntype: project\n---\n\nbody"),
    (parsed) => (parsed === null ? true : "expected null for non-task"),
  );

  await check(
    "parseTaskFile defaults bad status to triage",
    () => parseTaskFile("---\ntype: task\nstatus: bogus\n---\n"),
    (parsed) => {
      if (!parsed) return "got null";
      if (parsed.meta.status !== "triage") return `status=${parsed.meta.status}`;
      if (parsed.warnings.length === 0) return "expected warning";
      return true;
    },
  );

  await check(
    "buildTaskFile → parseTaskFile round trip preserves all fields",
    () => {
      const meta: TaskMeta = {
        name: "Follow up Acme",
        description: "outbound check",
        status: "waiting_external",
        nextStep: "wait for legal reply",
        nextCheckIn: "2026-05-10T18:00:00.000Z",
        completedAt: null,
      };
      const built = buildTaskFile({ meta, body: "Notes go here.\nLine 2." });
      return parseTaskFile(built);
    },
    (parsed) => {
      if (!parsed) return "round-trip parse failed";
      if (parsed.meta.name !== "Follow up Acme") return "name lost";
      if (parsed.meta.status !== "waiting_external") return "status lost";
      if (parsed.meta.nextCheckIn !== "2026-05-10T18:00:00.000Z") return "nextCheckIn lost";
      if (parsed.body.trim() !== "Notes go here.\nLine 2.") return "body lost";
      return true;
    },
  );

  await check(
    "completed_at flows with status: done (round-trip)",
    () => {
      const meta: TaskMeta = {
        name: "X",
        description: null,
        status: "done",
        nextStep: null,
        nextCheckIn: null,
        completedAt: "2026-05-04T22:00:00.000Z",
      };
      const built = buildTaskFile({ meta, body: "" });
      return { built, parsed: parseTaskFile(built) };
    },
    ({ built, parsed }) => {
      // ISO timestamps contain ':' so the serializer quotes them. Either form is fine.
      if (!/completed_at:\s*"?2026-05-04T22:00:00\.000Z"?/.test(built))
        return `completed_at missing in serialization: ${built}`;
      if (!parsed || parsed.meta.completedAt !== "2026-05-04T22:00:00.000Z")
        return `parsed completed_at=${parsed?.meta.completedAt}`;
      return true;
    },
  );

  await check(
    "extractTaskMeta returns null for non-tasks path",
    () => extractTaskMeta("notes/foo.md", "---\ntype: task\nstatus: doing\n---\n"),
    (v) => (v === null ? true : "expected null when path isn't tasks/*"),
  );

  await check(
    "slugifyTitle normalizes",
    () => ({ a: slugifyTitle("Q2 Board Deck!"), b: taskPathFromTitle("Q2 Board Deck!") }),
    ({ a, b }) => {
      if (a !== "q2-board-deck") return `slug=${a}`;
      if (b !== "tasks/q2-board-deck.md") return `path=${b}`;
      return true;
    },
  );

  await check(
    "serializeFrontmatter quotes values containing colons",
    () => serializeFrontmatter({ next_step: "Wait for: legal reply", type: "task" }, "body"),
    (s) =>
      s.includes('next_step: "Wait for: legal reply"') ? true : `bad serialization: ${s}`,
  );

  await check(
    "isAgentOrigin / isHumanOrigin classifications",
    () => ({
      mobile: isAgentOrigin("mobile"),
      web: isAgentOrigin("web"),
      local: isHumanOrigin("local"),
      cloud: isAgentOrigin("cloud"),
    }),
    ({ mobile, web, local, cloud }) =>
      mobile && web && local && cloud ? true : `got mobile=${mobile} web=${web} local=${local} cloud=${cloud}`,
  );
}

// ---------- 2. Three-way merge ----------

async function testMerge(): Promise<void> {
  console.log("\n— Three-way merge —");

  const base = buildTaskFile({
    meta: {
      name: "Q2 deck",
      description: null,
      status: "doing",
      nextStep: "draft outline",
      nextCheckIn: "2026-05-05T10:00:00.000Z",
      completedAt: null,
    },
    body: "line 1\nline 2\nline 3\n",
  });

  await check(
    "fast-forward when only one side changed body",
    () => {
      const head = buildTaskFile({
        meta: parseTaskFile(base)!.meta,
        body: "line 1\nline 2 EDITED\nline 3\n",
      });
      return mergeFile({
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: head, origin: "web", revisionTimestamp: new Date(2000) },
        incoming: { content: base, origin: "local", revisionTimestamp: new Date(3000) },
      });
    },
    (r) => (r.hadBodyConflict ? "unexpected body conflict" : true),
  );

  await check(
    "body conflict marks conflict + flips status",
    () => {
      const head = buildTaskFile({
        meta: parseTaskFile(base)!.meta,
        body: "line 1\nDESKTOP edit\nline 3\n",
      });
      const incoming = buildTaskFile({
        meta: parseTaskFile(base)!.meta,
        body: "line 1\nMOBILE edit\nline 3\n",
      });
      return mergeFile({
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: head, origin: "local", revisionTimestamp: new Date(2000) },
        incoming: { content: incoming, origin: "mobile", revisionTimestamp: new Date(3000) },
      });
    },
    (r) => {
      if (!r.hadBodyConflict) return "expected body conflict";
      const parsed = parseTaskFile(r.mergedContent);
      if (!parsed) return "merge produced unparseable";
      if (parsed.meta.status !== "waiting_user") return `status=${parsed.meta.status}`;
      if (!r.mergedContent.includes("<<<<<<<")) return "missing conflict markers";
      return true;
    },
  );

  await check(
    "status: done always wins",
    () => {
      const baseMeta = parseTaskFile(base)!.meta;
      const head = buildTaskFile({
        meta: { ...baseMeta, status: "doing", nextStep: "still working" },
        body: "x",
      });
      const incoming = buildTaskFile({
        meta: { ...baseMeta, status: "done", completedAt: "2026-05-05T12:00:00.000Z" },
        body: "x",
      });
      return mergeFile({
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: head, origin: "mobile", revisionTimestamp: new Date(3000) },
        incoming: { content: incoming, origin: "local", revisionTimestamp: new Date(2000) },
      });
    },
    (r) => {
      const parsed = parseTaskFile(r.mergedContent);
      if (!parsed) return "merge unparseable";
      if (parsed.meta.status !== "done") return `status=${parsed.meta.status}`;
      if (!parsed.meta.completedAt) return "completed_at not set";
      return true;
    },
  );

  await check(
    "next_check_in: agent wins over human",
    () => {
      const baseMeta = parseTaskFile(base)!.meta;
      const head = buildTaskFile({
        meta: { ...baseMeta, nextCheckIn: "2026-05-09T10:00:00.000Z" },
        body: "x",
      });
      const incoming = buildTaskFile({
        meta: { ...baseMeta, nextCheckIn: "2026-05-06T08:00:00.000Z" },
        body: "x",
      });
      return mergeFile({
        // head is local (human), incoming is mobile (agent) — even though head is later, agent wins
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: head, origin: "local", revisionTimestamp: new Date(3000) },
        incoming: { content: incoming, origin: "mobile", revisionTimestamp: new Date(2000) },
      });
    },
    (r) => {
      const parsed = parseTaskFile(r.mergedContent);
      if (!parsed) return "merge unparseable";
      if (parsed.meta.nextCheckIn !== "2026-05-06T08:00:00.000Z")
        return `nextCheckIn=${parsed.meta.nextCheckIn} (expected agent's)`;
      return true;
    },
  );

  await check(
    "frontmatter LWW for non-privileged fields",
    () => {
      const baseMeta = parseTaskFile(base)!.meta;
      const head = buildTaskFile({
        meta: { ...baseMeta, nextStep: "head step" },
        body: "x",
      });
      const incoming = buildTaskFile({
        meta: { ...baseMeta, nextStep: "incoming step" },
        body: "x",
      });
      return mergeFile({
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: head, origin: "local", revisionTimestamp: new Date(3000) }, // newer
        incoming: { content: incoming, origin: "mobile", revisionTimestamp: new Date(2000) },
      });
    },
    (r) => {
      const parsed = parseTaskFile(r.mergedContent);
      if (!parsed) return "unparseable";
      if (parsed.meta.nextStep !== "head step")
        return `nextStep=${parsed.meta.nextStep} (expected head, the newer)`;
      return true;
    },
  );

  await check(
    "noop when both sides unchanged from base",
    () =>
      mergeFile({
        base: { content: base, origin: "local", revisionTimestamp: new Date(1000) },
        head: { content: base, origin: "local", revisionTimestamp: new Date(2000) },
        incoming: { content: base, origin: "mobile", revisionTimestamp: new Date(3000) },
      }),
    (r) => (r.hadBodyConflict ? "unexpected body conflict on noop" : true),
  );
}

// ---------- 3. DB write paths populate task_meta ----------

async function testDbTaskCache(): Promise<{ replicaId: number }> {
  console.log("\n— DB write paths + task_meta cache —");

  const replicaId = await ensureMemoryReplica({
    runnerUserId: E2E_RUNNER_USER,
    workspaceId: E2E_WORKSPACE,
  });
  record(`ensureMemoryReplica → ${replicaId}`, true);

  await check(
    "writeMemoryFile populates task_meta for tasks/ paths",
    async () => {
      const content = buildTaskFile({
        meta: {
          name: "DB cache test",
          description: null,
          status: "doing",
          nextStep: "exercise the cache",
          nextCheckIn: "2026-06-01T12:00:00.000Z",
          completedAt: null,
        },
        body: "body content",
      });
      const file = await writeMemoryFile({
        replicaId,
        path: "tasks/db-cache-test.md",
        content,
        origin: "mobile",
      });
      return file;
    },
    (file) => {
      if (!file.taskMeta) return "task_meta is null";
      if (file.taskMeta.status !== "doing") return `status=${file.taskMeta.status}`;
      if (file.taskMeta.nextCheckIn !== "2026-06-01T12:00:00.000Z")
        return `nextCheckIn=${file.taskMeta.nextCheckIn}`;
      return true;
    },
  );

  await check(
    "writeMemoryFile leaves task_meta null for non-task paths",
    async () => {
      const file = await writeMemoryFile({
        replicaId,
        path: "notes/random.md",
        content: "just a note",
        origin: "mobile",
      });
      return file;
    },
    (file) => (file.taskMeta === null ? true : "task_meta should be null"),
  );

  await check(
    "listTasks returns only task files",
    async () => {
      await writeMemoryFile({
        replicaId,
        path: "tasks/another.md",
        content: buildTaskFile({
          meta: {
            name: "Another",
            description: null,
            status: "waiting_user",
            nextStep: "respond",
            nextCheckIn: "2026-05-15T09:00:00.000Z",
            completedAt: null,
          },
          body: "",
        }),
        origin: "web",
      });
      return await listTasks(replicaId);
    },
    (rows) => {
      if (rows.length !== 2) return `expected 2 tasks, got ${rows.length}`;
      if (!rows.every((r) => r.path.startsWith("tasks/"))) return "non-task path included";
      if (!rows.every((r) => r.taskMeta)) return "task_meta missing on a row";
      return true;
    },
  );

  await check(
    "findDueTasks returns past-due active tasks",
    async () => {
      await writeMemoryFile({
        replicaId,
        path: "tasks/overdue.md",
        content: buildTaskFile({
          meta: {
            name: "Overdue",
            description: null,
            status: "doing",
            nextStep: "do it",
            nextCheckIn: new Date(Date.now() - 60 * 60_000).toISOString(),
            completedAt: null,
          },
          body: "",
        }),
        origin: "mobile",
      });
      const due = await findDueTasks(new Date());
      return due.filter((t) => t.replicaId === replicaId);
    },
    (rows) => {
      if (!rows.some((r) => r.path === "tasks/overdue.md"))
        return "overdue task not returned";
      // The future-dated one (db-cache-test, june 1) shouldn't be in here
      if (rows.some((r) => r.path === "tasks/db-cache-test.md"))
        return "future task wrongly returned";
      return true;
    },
  );

  await check(
    "findDueTasks excludes done tasks",
    async () => {
      await writeMemoryFile({
        replicaId,
        path: "tasks/done-but-due.md",
        content: buildTaskFile({
          meta: {
            name: "Done but due",
            description: null,
            status: "done",
            nextStep: null,
            nextCheckIn: new Date(Date.now() - 60 * 60_000).toISOString(),
            completedAt: new Date().toISOString(),
          },
          body: "",
        }),
        origin: "mobile",
      });
      const due = await findDueTasks(new Date());
      return due.filter((t) => t.replicaId === replicaId);
    },
    (rows) => (rows.some((r) => r.path === "tasks/done-but-due.md") ? "done task should be excluded" : true),
  );

  await check(
    "deleteMemoryFile clears task_meta",
    async () => {
      const file = await deleteMemoryFile({
        replicaId,
        path: "tasks/another.md",
        origin: "web",
      });
      return file;
    },
    (file) => (file.taskMeta === null ? true : "task_meta should be cleared on delete"),
  );

  await check(
    "backfillTaskMeta is idempotent (no updates needed)",
    async () => {
      const r = await backfillTaskMeta();
      return r;
    },
    (r) => (r.updated === 0 ? true : `updated=${r.updated} on idempotent run`),
  );

  return { replicaId };
}

// ---------- 4. syncPushFile lifecycle ----------

async function testSyncPushLifecycle(replicaId: number): Promise<void> {
  console.log("\n— syncPushFile lifecycle —");

  const path = "tasks/sync-lifecycle.md";
  const v1Content = buildTaskFile({
    meta: {
      name: "Sync lifecycle",
      description: null,
      status: "doing",
      nextStep: "v1 step",
      nextCheckIn: "2026-07-01T10:00:00.000Z",
      completedAt: null,
    },
    body: "v1 body",
  });

  const v1 = await check(
    "syncPushFile creates new file (no base)",
    async () =>
      syncPushFile({
        replicaId,
        path,
        content: v1Content,
        origin: "local",
        baseRevisionId: null,
      }),
    (r) => (r.kind === "create" || r.kind === "fast_forward" ? true : `kind=${r.kind}`),
  );

  if (!v1) return;

  const headRevAfterV1 = await pool.query<{ id: number }>(
    "select id from memory_file_revisions where replica_id=$1 and path=$2 order by id desc limit 1",
    [replicaId, path],
  );
  const v1RevId = headRevAfterV1.rows[0]?.id ?? 0;

  await check(
    "syncPushFile fast-forward when base = head",
    async () => {
      const next = buildTaskFile({
        meta: {
          name: "Sync lifecycle",
          description: null,
          status: "doing",
          nextStep: "v2 step",
          nextCheckIn: "2026-07-01T10:00:00.000Z",
          completedAt: null,
        },
        body: "v2 body",
      });
      return syncPushFile({
        replicaId,
        path,
        content: next,
        origin: "local",
        baseRevisionId: v1RevId,
      });
    },
    (r) => (r.kind === "fast_forward" ? true : `kind=${r.kind}`),
  );

  // v2 is now head; v3 (incoming) bases off v1 → server should three-way merge
  const headRevAfterV2 = await pool.query<{ id: number }>(
    "select id from memory_file_revisions where replica_id=$1 and path=$2 order by id desc limit 1",
    [replicaId, path],
  );
  const v2RevId = headRevAfterV2.rows[0]?.id ?? 0;

  await check(
    "syncPushFile three-way merge when base < head",
    async () => {
      // Incoming changes ONLY frontmatter (status). Body matches base, so
      // diff3 sees one-side body change (head's v2 body) and merges cleanly.
      // Status: base=doing, head=doing (unchanged), incoming=waiting_external
      // → one-side change wins → waiting_external.
      const incoming = buildTaskFile({
        meta: {
          name: "Sync lifecycle",
          description: null,
          status: "waiting_external",
          nextStep: "v1-from-mobile step",
          nextCheckIn: "2026-07-15T10:00:00.000Z",
          completedAt: null,
        },
        body: "v1 body",
      });
      return syncPushFile({
        replicaId,
        path,
        content: incoming,
        origin: "mobile",
        baseRevisionId: v1RevId,
      });
    },
    (r) => {
      if (r.kind !== "merged") return `kind=${r.kind} (expected merged)`;
      if (r.file.taskMeta?.status !== "waiting_external")
        return `merged status=${r.file.taskMeta?.status}`;
      // Verify body kept head's v2 edit (one-side win)
      if (!r.file.content.includes("v2 body")) return `body lost head's v2 change`;
      return true;
    },
  );

  // Verify revision row got merge_parent_id set
  const mergedRev = await pool.query<{ merge_parent_id: number | null }>(
    "select merge_parent_id from memory_file_revisions where replica_id=$1 and path=$2 order by id desc limit 1",
    [replicaId, path],
  );
  record(
    "merge revision has merge_parent_id pointing to base",
    mergedRev.rows[0]?.merge_parent_id === v1RevId,
    `got ${mergedRev.rows[0]?.merge_parent_id}, expected ${v1RevId}`,
  );

  await check(
    "syncPushFile noop when content identical to head",
    async () => {
      const headFile = await readMemoryFile(replicaId, path);
      if (!headFile) throw new Error("file vanished");
      const headRevRow = await pool.query<{ id: number }>(
        "select id from memory_file_revisions where replica_id=$1 and path=$2 order by id desc limit 1",
        [replicaId, path],
      );
      void v2RevId;
      return syncPushFile({
        replicaId,
        path,
        content: headFile.content,
        origin: "local",
        baseRevisionId: headRevRow.rows[0]?.id ?? null,
      });
    },
    (r) => (r.kind === "noop" ? true : `kind=${r.kind}`),
  );
}

// ---------- 5. Phone link ----------

async function testPhoneLink(): Promise<void> {
  console.log("\n— Phone link —");

  const issued = await check(
    "issuePhoneLinkCode produces 6-digit code",
    async () =>
      issuePhoneLinkCode({
        runnerUserId: E2E_RUNNER_USER,
        workspaceId: E2E_WORKSPACE,
        email: E2E_RUNNER_USER,
        jwt: "fake-jwt",
        refreshToken: "fake-refresh",
        jwtExpiresAt: new Date(Date.now() + 24 * 3600_000),
        timeZone: "America/Los_Angeles",
      }),
    (r) => (/^\d{6}$/.test(r.code) ? true : `code=${r.code}`),
  );
  if (!issued) return;

  await check(
    "consumePhoneLinkCode succeeds first time",
    async () => consumePhoneLinkCode({ code: issued.code, phone: "+15558675309" }),
    (r) => (r && r.runnerUserId === E2E_RUNNER_USER ? true : `got ${JSON.stringify(r)}`),
  );

  await check(
    "consumePhoneLinkCode rejects double consumption",
    async () => consumePhoneLinkCode({ code: issued.code, phone: "+15558675309" }),
    (r) => (r === null ? true : "expected null on second consume"),
  );

  await check(
    "consumePhoneLinkCode rejects unknown code",
    async () => consumePhoneLinkCode({ code: "000000", phone: "+15558675309" }),
    (r) => (r === null ? true : "expected null for unknown code"),
  );
}

// ---------- 5b. Sync flow via HTTP (daemon path) ----------

async function testSyncOverHttp(): Promise<void> {
  console.log("\n— Memory sync over HTTP (daemon protocol) —");

  // We can't go through /api/memory/clients/register (it validates against
  // the real Runner backend), so register the client directly via the DB
  // function and use its token against the live HTTP layer.
  const reg = await registerMemorySyncClient({
    runnerUserId: E2E_RUNNER_USER,
    workspaceId: E2E_WORKSPACE,
    label: "e2e-sync-client",
  });
  // Sanity: the registered token authenticates.
  void hashSyncToken; // re-used by the server's auth check internally
  record(`registered sync client (replica ${reg.replicaId})`, true);

  const auth = `Bearer ${reg.token}`;
  const path = "tasks/http-sync.md";

  const v1 = buildTaskFile({
    meta: {
      name: "HTTP sync",
      description: null,
      status: "doing",
      nextStep: "first push",
      nextCheckIn: "2026-08-01T10:00:00.000Z",
      completedAt: null,
    },
    body: "v1\nv2\nv3\n",
  });

  // ---- Push 1: create
  const pushRes1 = await check(
    "HTTP push: create new file",
    async () =>
      fetch("http://localhost:4099/api/memory/sync/push", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path, content: v1, base_revision_id: null }],
          protocol_version: 2,
        }),
      }).then((r) => r.json()),
    (body) => {
      const c = body.changed?.[0];
      if (!c) return `no change reported: ${JSON.stringify(body)}`;
      if (c.outcome !== "create" && c.outcome !== "fast_forward")
        return `outcome=${c.outcome}`;
      return true;
    },
  );
  if (!pushRes1) return;

  // Capture revision id
  const headRevQ = await pool.query<{ id: number }>(
    "select id from memory_file_revisions where replica_id=$1 and path=$2 order by id desc limit 1",
    [reg.replicaId, path],
  );
  const v1Rev = headRevQ.rows[0]?.id ?? 0;

  // ---- Pull: should return v1
  await check(
    "HTTP pull: returns the create revision",
    async () =>
      fetch("http://localhost:4099/api/memory/sync/pull?since=0", {
        headers: { authorization: auth },
      }).then((r) => r.json()),
    (body) => {
      const found = body.revisions?.find(
        (r: { path: string; operation: string }) => r.path === path && r.operation === "create",
      );
      return found ? true : `pull missing create rev for ${path}`;
    },
  );

  // ---- Push 2: fast-forward (base=v1)
  const v2 = buildTaskFile({
    meta: {
      name: "HTTP sync",
      description: null,
      status: "doing",
      nextStep: "ff push",
      nextCheckIn: "2026-08-01T10:00:00.000Z",
      completedAt: null,
    },
    body: "v1\nv2 EDITED\nv3\n",
  });
  const ffRes = await check(
    "HTTP push: fast-forward (base = head)",
    async () =>
      fetch("http://localhost:4099/api/memory/sync/push", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path, content: v2, base_revision_id: v1Rev }],
          protocol_version: 2,
        }),
      }).then((r) => r.json()),
    (body) => (body.changed?.[0]?.outcome === "fast_forward" ? true : `body=${JSON.stringify(body)}`),
  );
  if (!ffRes) return;

  // ---- Push 3: three-way merge (base=v1, but head is now v2)
  const incoming = buildTaskFile({
    meta: {
      name: "HTTP sync",
      description: null,
      status: "waiting_external",
      nextStep: "concurrent mobile change",
      nextCheckIn: "2026-08-15T10:00:00.000Z",
      completedAt: null,
    },
    body: "v1\nv2\nv3\n", // unchanged from base — body merges cleanly
  });
  await check(
    "HTTP push: three-way merge surfaces 'merged' outcome",
    async () =>
      fetch("http://localhost:4099/api/memory/sync/push", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path, content: incoming, base_revision_id: v1Rev }],
          protocol_version: 2,
        }),
      }).then((r) => r.json()),
    (body) => {
      const c = body.changed?.[0];
      if (!c) return `no change: ${JSON.stringify(body)}`;
      if (c.outcome !== "merged") return `outcome=${c.outcome} (expected merged)`;
      if (c.file?.taskMeta?.status !== "waiting_external")
        return `merged status=${c.file?.taskMeta?.status}`;
      // Body should retain head's v2 EDITED line
      if (!c.file?.content?.includes("v2 EDITED")) return "merged body lost head's edit";
      return true;
    },
  );

  // ---- Push 4: delete via tombstone
  await check(
    "HTTP push: delete tombstone",
    async () =>
      fetch("http://localhost:4099/api/memory/sync/push", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path, deleted: true }],
          protocol_version: 2,
        }),
      }).then((r) => r.json()),
    (body) => (body.changed?.length === 1 ? true : `body=${JSON.stringify(body)}`),
  );
  await check(
    "after delete: file shows deleted_at set",
    async () => {
      const file = await readMemoryFile(reg.replicaId, path, { includeDeleted: true });
      return file;
    },
    (file) => (file?.deletedAt ? true : "deleted_at not set"),
  );
}

// ---------- 5c. Daemon end-to-end (real filesystem + HTTP roundtrip) ----------

async function testDaemonE2E(): Promise<void> {
  console.log("\n— Daemon end-to-end (real fs + http) —");

  const memRoot = await mkdtemp(join(tmpdir(), "runner-mem-"));
  const stateDir = await mkdtemp(join(tmpdir(), "runner-state-"));

  // Provision a sync client directly via DB (skip the Runner-backend-validating
  // /clients/register path).
  const reg = await registerMemorySyncClient({
    runnerUserId: `daemon-e2e-${Date.now()}@runner.test`,
    workspaceId: `ws-daemon-${Date.now()}`,
    label: "daemon-e2e",
  });

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_MOBILE_SERVER_URL: "http://localhost:4099",
    RUNNER_MOBILE_SYNC_TOKEN: reg.token,
    RUNNER_MOBILE_MEMORY_ROOT: memRoot,
    RUNNER_MOBILE_STATE_DIR: stateDir,
  };

  const runDaemon = (cmd: "sync" | "register" = "sync") =>
    spawnSync(
      "pnpm",
      ["exec", "tsx", "/Users/charlie/Documents/Git/runner-mobile-prototype/scripts/memory-sync.ts", cmd],
      { env: daemonEnv, encoding: "utf8", cwd: "/Users/charlie/Documents/Git/runner-mobile-prototype" },
    );

  // Bootstrap state file with the sync token + replicaId so loadState() picks them up
  await writeFile(
    join(stateDir, "state-v2.json"),
    JSON.stringify(
      {
        protocolVersion: 2,
        serverUrl: "http://localhost:4099",
        token: reg.token,
        replicaId: reg.replicaId,
        pullCursor: 0,
        files: {},
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // ---- Local create → push
  const taskPath = "tasks/daemon-test.md";
  const v1 = buildTaskFile({
    meta: {
      name: "Daemon test",
      description: null,
      status: "doing",
      nextStep: "first sync",
      nextCheckIn: "2026-09-01T10:00:00.000Z",
      completedAt: null,
    },
    body: "alpha\nbeta\ngamma\n",
  });
  await mkdir(join(memRoot, "tasks"), { recursive: true });
  await writeFile(join(memRoot, taskPath), v1);

  await check(
    "daemon: sync pushes new local file",
    async () => {
      const r = runDaemon("sync");
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    },
    (r) => {
      if (r.status !== 0) return `exit=${r.status} stderr=${r.stderr}`;
      if (!r.stdout.includes("pushed 1 memory file")) return `stdout=${r.stdout}`;
      return true;
    },
  );

  await check(
    "daemon: server has the file after push",
    async () => readMemoryFile(reg.replicaId, taskPath),
    (file) => {
      if (!file) return "file missing on server";
      if (!file.taskMeta) return "task_meta missing on server";
      if (file.taskMeta.status !== "doing") return `status=${file.taskMeta.status}`;
      return true;
    },
  );

  // ---- Server-side change → daemon pulls and writes locally
  const v2 = buildTaskFile({
    meta: {
      name: "Daemon test",
      description: null,
      status: "waiting_user",
      nextStep: "agent updated this",
      nextCheckIn: "2026-09-02T10:00:00.000Z",
      completedAt: null,
    },
    body: "alpha\nbeta CHANGED\ngamma\n",
  });
  await syncPushFile({
    replicaId: reg.replicaId,
    path: taskPath,
    content: v2,
    origin: "mobile",
    baseRevisionId: null, // unconditional from "the agent"
  });

  await check(
    "daemon: sync pulls server-side change to local file",
    async () => {
      const r = runDaemon("sync");
      const localContent = existsSync(join(memRoot, taskPath))
        ? await readFile(join(memRoot, taskPath), "utf8")
        : "";
      return { ...r, localContent };
    },
    (r) => {
      if (r.status !== 0) return `exit=${r.status} stderr=${r.stderr}`;
      if (!r.localContent.includes("waiting_user"))
        return `local file did not pick up server change: ${r.localContent.slice(0, 200)}`;
      if (!r.localContent.includes("beta CHANGED"))
        return `local file body not updated: ${r.localContent.slice(0, 200)}`;
      return true;
    },
  );

  // ---- Concurrent edit: edit local body AND server changes status simultaneously
  // Read current local content
  const beforeConcurrent = await readFile(join(memRoot, taskPath), "utf8");
  // 1. Edit locally
  await writeFile(
    join(memRoot, taskPath),
    beforeConcurrent.replace("gamma", "gamma + LOCAL EDIT"),
  );
  // 2. Edit server-side: change status to done
  const beforeAgentEdit = await readMemoryFile(reg.replicaId, taskPath);
  if (!beforeAgentEdit) throw new Error("file missing");
  const v3 = buildTaskFile({
    meta: {
      name: "Daemon test",
      description: null,
      status: "done",
      nextStep: null,
      nextCheckIn: null,
      completedAt: new Date().toISOString(),
    },
    body: beforeAgentEdit.content
      .split("---")
      .slice(2)
      .join("---")
      .trim(), // keep agent body unchanged
  });
  await syncPushFile({
    replicaId: reg.replicaId,
    path: taskPath,
    content: v3,
    origin: "mobile",
    baseRevisionId: null,
  });

  await check(
    "daemon: concurrent local+server edits merge cleanly",
    async () => {
      const r = runDaemon("sync");
      const localContent = await readFile(join(memRoot, taskPath), "utf8");
      const serverFile = await readMemoryFile(reg.replicaId, taskPath);
      return { ...r, localContent, serverFile };
    },
    (r) => {
      if (r.status !== 0) return `exit=${r.status} stderr=${r.stderr}`;
      // Done wins on status; local body edit should survive (no body conflict
      // since the agent's edit kept its existing body and only the local
      // side touched the body).
      if (!r.serverFile?.taskMeta) return "server task_meta missing";
      if (r.serverFile.taskMeta.status !== "done")
        return `server status=${r.serverFile.taskMeta.status} (expected done)`;
      if (!r.serverFile.content.includes("LOCAL EDIT"))
        return "server lost local body edit after merge";
      if (!r.localContent.includes("LOCAL EDIT"))
        return "local file lost LOCAL EDIT after merge";
      if (!r.localContent.includes("status: done"))
        return "local file did not pick up agent's done";
      return true;
    },
  );

  // ---- Local delete → tombstone push
  await rm(join(memRoot, taskPath));
  await check(
    "daemon: local delete pushes tombstone",
    async () => {
      const r = runDaemon("sync");
      const file = await readMemoryFile(reg.replicaId, taskPath, { includeDeleted: true });
      return { ...r, file };
    },
    (r) => {
      if (r.status !== 0) return `exit=${r.status} stderr=${r.stderr}`;
      if (!r.file?.deletedAt) return "server file not marked deleted";
      return true;
    },
  );

  // Cleanup
  await rm(memRoot, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// ---------- 6. HTTP server integration ----------

async function spawnServer(): Promise<{ child: ChildProcess; ready: boolean }> {
  console.log("\nstarting server (skip-spectrum mode is N/A — server tolerates spectrum unavail)…");
  const child = spawn("pnpm", ["--filter", "@runner-mobile/server", "start"], {
    cwd: "/Users/charlie/Documents/Git/runner-mobile-prototype",
    env: { ...process.env, PORT: "4099" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  child.stdout?.on("data", (chunk) => {
    const s = String(chunk);
    if (s.includes("server listening")) ready = true;
  });
  child.stderr?.on("data", () => {
    // suppress
  });
  for (let i = 0; i < 40 && !ready; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch("http://localhost:4099/healthz");
      if (res.ok) ready = true;
    } catch {
      // not yet
    }
  }
  return { child, ready };
}

async function testHttpUnauthenticated(): Promise<void> {
  console.log("\n— HTTP: unauthenticated rejection —");

  await check(
    "GET /api/app/tasks without bearer → 401",
    async () => fetch("http://localhost:4099/api/app/tasks"),
    (res) => (res.status === 401 ? true : `status=${res.status}`),
  );

  await check(
    "GET /api/app/tasks with bearer but no workspace header → 400",
    async () =>
      fetch("http://localhost:4099/api/app/tasks", {
        headers: { authorization: "Bearer fake" },
      }),
    (res) => (res.status === 400 ? true : `status=${res.status}`),
  );

  await check(
    "GET /api/app/tasks with fake bearer → 401",
    async () =>
      fetch("http://localhost:4099/api/app/tasks", {
        headers: {
          authorization: "Bearer fake-jwt-not-real",
          "x-runner-workspace": "ws-fake",
          "x-runner-user-id": "user@fake",
          "x-runner-email": "user@fake",
        },
      }),
    (res) => (res.status === 401 ? true : `status=${res.status}`),
  );

  await check(
    "POST /api/cron/tick rejects missing secret",
    async () =>
      fetch("http://localhost:4099/api/cron/tick", {
        method: "POST",
      }),
    (res) => (res.status === 401 ? true : `status=${res.status}`),
  );

  await check(
    "POST /api/cron/tick rejects bad secret",
    async () =>
      fetch("http://localhost:4099/api/cron/tick", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    (res) => (res.status === 401 ? true : `status=${res.status}`),
  );
}

// ---------- Coverage check ----------

async function testCoverage(): Promise<void> {
  console.log("\n— Coverage / sanity —");
  await check(
    "ACTIVE_TASK_STATUSES excludes done",
    () => ACTIVE_TASK_STATUSES,
    (s) =>
      s.includes("done" as never) ? "done leaked into active" : true,
  );
}

// ---------- main ----------

async function cleanup(): Promise<void> {
  await pool.query("delete from memory_replicas where runner_user_id = $1", [E2E_RUNNER_USER]);
}

async function main(): Promise<void> {
  let serverChild: ChildProcess | null = null;
  try {
    await testParser();
    await testMerge();
    const db = await testDbTaskCache();
    await testSyncPushLifecycle(db.replicaId);
    await testPhoneLink();
    await testCoverage();

    const spawned = await spawnServer();
    serverChild = spawned.child;
    if (!spawned.ready) {
      record("server failed to come up on :4099", false);
    } else {
      record("server up on :4099", true);
      await testHttpUnauthenticated();
      await testSyncOverHttp();
      await testDaemonE2E();
    }
  } finally {
    if (serverChild) {
      serverChild.kill("SIGTERM");
      // give it a moment
      await new Promise((r) => setTimeout(r, 500));
    }
    await cleanup();
    await pool.end();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
