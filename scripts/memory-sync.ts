/**
 * Bidirectional memory sync daemon.
 *
 * V2 protocol (PROTOCOL_VERSION = 2):
 *   - Single canonical directory: ~/.runner/memory/
 *   - Per-file state: { localHash, lastSyncedRevisionId }
 *   - Push protocol sends base_revision_id; server runs three-way merge on
 *     conflict and returns the merged content for the daemon to write back.
 *
 * V1 daemons (which used a separate ~/.codex/imported_memories mirror)
 * remain readable but the V2 daemon uses an entirely different state file
 * to avoid corrupting V1 installs in place.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROTOCOL_VERSION = 2;
const DEFAULT_SERVER_URL = "http://localhost:4001";
// Env overrides exist primarily for the e2e test harness; production
// installs leave them unset.
const STATE_DIR =
  process.env.RUNNER_MOBILE_STATE_DIR ?? join(homedir(), ".runner-mobile-memory-sync");
const STATE_PATH = join(STATE_DIR, "state-v2.json");
const MEMORY_ROOT =
  process.env.RUNNER_MOBILE_MEMORY_ROOT ?? join(homedir(), ".runner", "memory");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.runner.mobile.memory-sync.plist",
);

type FileState = {
  localHash: string;
  lastSyncedRevisionId: number | null;
};

type State = {
  protocolVersion: number;
  serverUrl: string;
  token?: string;
  replicaId?: number;
  pullCursor: number;
  files: Record<string, FileState>;
};

type LocalFile = {
  path: string; // relative to MEMORY_ROOT, posix-style
  absolutePath: string;
  content: string;
  hash: string;
};

type PushOutcome = {
  path: string;
  outcome: "create" | "fast_forward" | "merged" | "noop";
  file: { revision: number; content: string; contentHash: string };
  latestRevisionRowId: number;
  hadBodyConflict?: boolean;
  hadFrontmatterConflict?: boolean;
  notes?: string[];
};

type PushResponse = {
  changed: PushOutcome[];
  latestRevisionId: number;
};

type RemoteRevision = {
  id: number;
  path: string;
  content: string;
  contentHash: string;
  fileRevision: number;
  origin: string;
  operation: string;
  createdAt: string;
};

type PullResponse = {
  revisions: RemoteRevision[];
  latestRevisionId: number;
};

async function main() {
  const [command = "sync", ...args] = process.argv.slice(2);
  switch (command) {
    case "register":
      await register(args);
      break;
    case "sync":
      await sync();
      break;
    case "daemon:install":
      await installDaemon();
      break;
    case "daemon:start":
      await launchctl("load", PLIST_PATH);
      break;
    case "daemon:stop":
      await launchctl("unload", PLIST_PATH);
      break;
    case "daemon:status":
      await daemonStatus();
      break;
    case "daemon:uninstall":
      await uninstallDaemon();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.protocolVersion && parsed.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `state file is at protocol v${parsed.protocolVersion}; this daemon speaks v${PROTOCOL_VERSION}. ` +
          `Run \`pnpm memory:daemon:install\` to upgrade.`,
      );
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverUrl:
        parsed.serverUrl ?? process.env.RUNNER_MOBILE_SERVER_URL ?? DEFAULT_SERVER_URL,
      token: process.env.RUNNER_MOBILE_SYNC_TOKEN ?? parsed.token,
      replicaId: parsed.replicaId,
      pullCursor: parsed.pullCursor ?? 0,
      files: parsed.files ?? {},
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("protocol")) throw err;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverUrl: process.env.RUNNER_MOBILE_SERVER_URL ?? DEFAULT_SERVER_URL,
      token: process.env.RUNNER_MOBILE_SYNC_TOKEN,
      pullCursor: 0,
      files: {},
    };
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function register(args: string[]) {
  const state = await loadState();
  const serverUrl = argValue(args, "--server-url") ?? state.serverUrl;
  const accessToken =
    argValue(args, "--access-token") ?? process.env.RUNNER_MOBILE_ACCESS_TOKEN;
  const runnerUserId =
    argValue(args, "--runner-user-id") ?? process.env.RUNNER_MOBILE_RUNNER_USER_ID;
  const workspaceId = argValue(args, "--workspace-id") ?? process.env.RUNNER_MOBILE_WORKSPACE_ID;
  const label =
    argValue(args, "--label") ?? `${process.env.USER ?? "mac"}@${hostnameFallback()}`;

  if (!accessToken || !runnerUserId || !workspaceId) {
    throw new Error(
      "register requires --access-token, --runner-user-id, and --workspace-id (or matching RUNNER_MOBILE_* env vars)",
    );
  }

  const res = await fetch(`${serverUrl}/api/memory/clients/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      access_token: accessToken,
      runner_user_id: runnerUserId,
      workspace_id: workspaceId,
      label,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; replicaId: number };
  const sameReplica = state.serverUrl === serverUrl && state.replicaId === body.replicaId;
  await saveState({
    protocolVersion: PROTOCOL_VERSION,
    serverUrl,
    token: body.token,
    replicaId: body.replicaId,
    pullCursor: sameReplica ? state.pullCursor : 0,
    files: sameReplica ? state.files : {},
  });
  console.log(`registered memory sync client for replica ${body.replicaId}`);
}

async function sync() {
  const state = await loadState();
  if (!state.token) {
    throw new Error(
      "not registered; run pnpm memory:register first or set RUNNER_MOBILE_SYNC_TOKEN",
    );
  }
  await mkdir(MEMORY_ROOT, { recursive: true });

  const localFiles = await collectLocalFiles();

  // Detect locally-deleted paths up front: in state but missing on disk.
  // We exclude these from pull application so a concurrent server update
  // doesn't silently resurrect a file the user just deleted.
  const locallyDeleted = new Set<string>();
  for (const knownPath of Object.keys(state.files)) {
    if (!localFiles.has(knownPath)) locallyDeleted.add(knownPath);
  }

  // Step 1 — Pull first so subsequent push knows the right base.
  const pullSince = state.pullCursor;
  const pulled = await api<PullResponse>(state, `/api/memory/sync/pull?since=${pullSince}`);
  await applyPulledRevisions(state, pulled.revisions, localFiles, locallyDeleted);
  state.pullCursor = Math.max(state.pullCursor, pulled.latestRevisionId);

  // Re-collect after pulls may have written/deleted files.
  const refreshedLocal = await collectLocalFiles();

  // Step 2 — Push changed local files. base_revision_id is whatever we last
  // synced for that path; the server will fast-forward or three-way merge.
  const toPush: Array<{
    path: string;
    content?: string;
    deleted?: boolean;
    base_revision_id: number | null;
  }> = [];

  // Detect creates and edits
  for (const file of refreshedLocal.values()) {
    const entry = state.files[file.path];
    if (!entry) {
      toPush.push({ path: file.path, content: file.content, base_revision_id: null });
    } else if (entry.localHash !== file.hash) {
      toPush.push({
        path: file.path,
        content: file.content,
        base_revision_id: entry.lastSyncedRevisionId,
      });
    }
  }

  // Detect deletes (in state, gone from disk)
  for (const knownPath of Object.keys(state.files)) {
    if (!refreshedLocal.has(knownPath)) {
      toPush.push({
        path: knownPath,
        deleted: true,
        base_revision_id: state.files[knownPath]?.lastSyncedRevisionId ?? null,
      });
    }
  }

  if (toPush.length > 0) {
    const result = await api<PushResponse>(state, "/api/memory/sync/push", {
      method: "POST",
      body: JSON.stringify({ files: toPush, protocol_version: PROTOCOL_VERSION }),
    });
    for (const change of result.changed) {
      if (change.outcome === "merged") {
        // Server merged; write the merged content back to local so disk
        // matches the new head.
        const absolute = join(MEMORY_ROOT, change.path);
        await atomicWrite(absolute, change.file.content);
        state.files[change.path] = {
          localHash: change.file.contentHash,
          lastSyncedRevisionId: change.latestRevisionRowId,
        };
        console.log(
          `merged ${change.path}${change.hadBodyConflict ? " (body conflict)" : ""}`,
        );
      } else if (change.outcome === "fast_forward" || change.outcome === "create") {
        const expected = change.file.content;
        state.files[change.path] = {
          localHash: change.file.contentHash,
          lastSyncedRevisionId: change.latestRevisionRowId,
        };
        // Reflect the canonical content (server might have normalized).
        if (existsSync(join(MEMORY_ROOT, change.path)) && change.outcome !== "create") {
          // Only rewrite if content differs to avoid touching mtime.
          const current = await readFile(join(MEMORY_ROOT, change.path), "utf8").catch(
            () => "",
          );
          if (current !== expected) {
            await atomicWrite(join(MEMORY_ROOT, change.path), expected);
          }
        }
      } else if (change.outcome === "noop") {
        // Already in sync; just record state so we stop trying.
        state.files[change.path] = {
          localHash: change.file.contentHash,
          lastSyncedRevisionId: change.latestRevisionRowId,
        };
      }
    }

    // Drop deleted entries from state once server confirms.
    for (const change of result.changed) {
      const stillOnDisk = refreshedLocal.has(change.path);
      if (!stillOnDisk && toPush.some((p) => p.path === change.path && p.deleted)) {
        delete state.files[change.path];
      }
    }
    console.log(`pushed ${result.changed.length} memory file(s)`);
  } else {
    console.log("no local memory changes to push");
  }

  await saveState(state);
}

async function collectLocalFiles(): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  if (!existsSync(MEMORY_ROOT)) return files;
  const absolutes = await walkMarkdown(MEMORY_ROOT);
  for (const absolutePath of absolutes) {
    const path = relative(MEMORY_ROOT, absolutePath).replaceAll("\\", "/");
    const content = await readFile(absolutePath, "utf8");
    files.set(path, { path, absolutePath, content, hash: sha256(content) });
  }
  return files;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

async function applyPulledRevisions(
  state: State,
  revisions: RemoteRevision[],
  localFiles: Map<string, LocalFile>,
  locallyDeleted: Set<string>,
): Promise<void> {
  // Reduce to latest revision per path; older revisions in the same batch
  // would just be overwritten anyway.
  const latestByPath = new Map<string, RemoteRevision>();
  for (const rev of revisions) {
    const existing = latestByPath.get(rev.path);
    if (!existing || existing.id < rev.id) latestByPath.set(rev.path, rev);
  }

  for (const rev of latestByPath.values()) {
    // User-initiated local delete takes precedence — let the push step
    // upload the tombstone instead of resurrecting the file here.
    if (locallyDeleted.has(rev.path) && rev.operation !== "delete") continue;

    const absolute = join(MEMORY_ROOT, rev.path);
    const local = localFiles.get(rev.path);
    const knownState = state.files[rev.path];

    if (rev.operation === "delete") {
      if (existsSync(absolute)) {
        // Only delete if the local file matches the last we synced
        // (otherwise the user has uncommitted local edits — let the next
        // push round produce a recreate revision).
        if (!local || (knownState && local.hash === knownState.localHash)) {
          await rm(absolute, { force: true });
          delete state.files[rev.path];
        }
      } else {
        delete state.files[rev.path];
      }
      continue;
    }

    // Local matches what we'd be writing — no-op write (mtime stable).
    if (local && local.content === rev.content) {
      state.files[rev.path] = {
        localHash: local.hash,
        lastSyncedRevisionId: rev.id,
      };
      continue;
    }

    // Local had no diverged edits since last sync — straight pull.
    if (!local || (knownState && local.hash === knownState.localHash)) {
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
      await atomicWrite(absolute, rev.content);
      state.files[rev.path] = {
        localHash: sha256(rev.content),
        lastSyncedRevisionId: rev.id,
      };
      continue;
    }

    // Local diverged AND remote diverged. Skip writing locally now — the
    // push step will send our content with the prior base, and the server
    // will run the three-way merge and tell us what to write.
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(tmpdir(), `runner-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function api<T>(state: State, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${state.token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${state.serverUrl}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function installDaemon() {
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const cwd = process.cwd();
  const command = `cd ${shellQuote(cwd)} && pnpm memory:sync >> ${shellQuote(
    join(STATE_DIR, "daemon.log"),
  )} 2>&1`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.runner.mobile.memory-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(STATE_DIR, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(STATE_DIR, "launchd.err.log"))}</string>
</dict>
</plist>
`;
  await writeFile(PLIST_PATH, plist, { mode: 0o600 });
  await launchctl("unload", PLIST_PATH).catch(() => undefined);
  await launchctl("load", PLIST_PATH).catch(() =>
    launchctl("bootstrap", `gui/${process.getuid?.()}`, PLIST_PATH),
  );
  console.log(`installed launchd job at ${PLIST_PATH}`);
}

async function uninstallDaemon() {
  await launchctl("unload", PLIST_PATH).catch(() => undefined);
  await rm(PLIST_PATH, { force: true });
  console.log("uninstalled launchd job");
}

async function daemonStatus() {
  const { stdout } = await execFileAsync("launchctl", ["list"]);
  const running = stdout.includes("com.runner.mobile.memory-sync");
  console.log(running ? "memory sync daemon is loaded" : "memory sync daemon is not loaded");
}

async function launchctl(command: string, ...args: string[]) {
  await execFileAsync("launchctl", [command, ...args]);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hostnameFallback(): string {
  return process.env.HOSTNAME ?? "mac";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
