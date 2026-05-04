import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_SERVER_URL = "http://localhost:4001";
const STATE_DIR = join(homedir(), ".runner-mobile-memory-sync");
const STATE_PATH = join(STATE_DIR, "state.json");
const PULL_TARGET = join(homedir(), ".codex", "imported_memories", "runner-mobile-cloud");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.runner.mobile.memory-sync.plist",
);

type State = {
  serverUrl: string;
  token?: string;
  replicaId?: number;
  pullCursor: number;
  pushed: Record<string, string>;
};

type LocalFile = {
  path: string;
  content: string;
  hash: string;
};

type RemoteFile = {
  path: string;
  content: string;
  contentHash: string;
  revision: number;
  origin: string;
  deletedAt: string | null;
  updatedAt: string;
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

const SOURCES = [
  {
    key: "runner-memory",
    label: "Runner memory",
    dir: join(homedir(), ".runner", "memory"),
    hook: "synced Runner memory directory",
  },
] as const;

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
    return {
      serverUrl: parsed.serverUrl ?? process.env.RUNNER_MOBILE_SERVER_URL ?? DEFAULT_SERVER_URL,
      token: process.env.RUNNER_MOBILE_SYNC_TOKEN ?? parsed.token,
      replicaId: parsed.replicaId,
      pullCursor: parsed.pullCursor ?? 0,
      pushed: parsed.pushed ?? {},
    };
  } catch {
    return {
      serverUrl: process.env.RUNNER_MOBILE_SERVER_URL ?? DEFAULT_SERVER_URL,
      token: process.env.RUNNER_MOBILE_SYNC_TOKEN,
      pullCursor: 0,
      pushed: {},
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
  const accessToken = argValue(args, "--access-token") ?? process.env.RUNNER_MOBILE_ACCESS_TOKEN;
  const runnerUserId =
    argValue(args, "--runner-user-id") ?? process.env.RUNNER_MOBILE_RUNNER_USER_ID;
  const workspaceId = argValue(args, "--workspace-id") ?? process.env.RUNNER_MOBILE_WORKSPACE_ID;
  const label = argValue(args, "--label") ?? `${process.env.USER ?? "mac"}@${hostnameFallback()}`;

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
    ...state,
    serverUrl,
    token: body.token,
    replicaId: body.replicaId,
    pullCursor: sameReplica ? state.pullCursor : 0,
    pushed: sameReplica ? state.pushed : {},
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
  const pullSince = state.pullCursor;

  const localFiles = await collectLocalFiles();
  const index = await buildMergedEntrypoint(state, localFiles);
  localFiles.set("MEMORY.md", {
    path: "MEMORY.md",
    content: index.content,
    hash: index.hash,
  });
  if (!index.changedRemote) {
    state.pushed["MEMORY.md"] = index.hash;
  }

  const changed = [...localFiles.values()].filter((file) => state.pushed[file.path] !== file.hash);
  if (changed.length > 0) {
    await api<{ latestRevisionId: number }>(state, "/api/memory/sync/push", {
      method: "POST",
      body: JSON.stringify({
        files: changed.map((file) => ({ path: file.path, content: file.content })),
      }),
    });
    for (const file of changed) state.pushed[file.path] = file.hash;
    console.log(`pushed ${changed.length} memory file(s)`);
  } else {
    console.log("no local memory changes to push");
  }

  const pulled = await api<{ revisions: RemoteRevision[]; latestRevisionId: number }>(
    state,
    `/api/memory/sync/pull?since=${pullSince}`,
  );
  const mobileRevisions = pulled.revisions.filter((rev) => rev.origin !== "local");
  await applyPulledRevisions(mobileRevisions);
  state.pullCursor = Math.max(state.pullCursor, pulled.latestRevisionId);
  await saveState(state);
  console.log(`pulled ${mobileRevisions.length} mobile/cloud revision(s)`);
}

async function collectLocalFiles(): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    const sourceFiles = await walkMarkdown(source.dir);
    for (const absolutePath of sourceFiles) {
      if (absolutePath.startsWith(PULL_TARGET)) continue;
      const rel = relative(source.dir, absolutePath).replaceAll("\\", "/");
      if (rel.split("/").includes("runner-mobile-cloud")) continue;
      const path = `local/${source.key}/${rel}`;
      const content = await readFile(absolutePath, "utf8");
      files.set(path, { path, content, hash: sha256(content) });
    }
  }
  return files;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

async function buildMergedEntrypoint(
  state: State,
  localFiles: Map<string, LocalFile>,
): Promise<LocalFile & { changedRemote: boolean }> {
  const existing = await api<{ file: RemoteFile }>(state, "/api/memory/file?path=MEMORY.md").catch(
    () => null,
  );
  const runnerIndex = localFiles.get("local/runner-memory/MEMORY.md");
  const baseContent = runnerIndex ? rewriteRunnerMemoryLinks(runnerIndex.content) : "";
  const baseLines = new Set(
    baseContent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const existingLines = existing?.file.content.trim() ? existing.file.content.trim().split("\n") : [];
  const preservedLines = existingLines.filter(
    (line) =>
      line.trim().length > 0 &&
      line.trim() !== "## Mobile-created memories" &&
      !baseLines.has(line.trim()) &&
      !line.includes("](local/runner-memory/MEMORY.md)"),
  );
  const preserved = preservedLines.length > 0 ? `\n\n## Mobile-created memories\n${preservedLines.join("\n")}\n` : "";
  const content = `${baseContent.trim()}${preserved}`.trim();
  const finalContent = content ? `${content}\n` : "";
  const changedRemote = existing?.file.content !== finalContent;
  return {
    path: "MEMORY.md",
    content: finalContent,
    hash: sha256(finalContent),
    changedRemote,
  };
}

function rewriteRunnerMemoryLinks(content: string): string {
  return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, href: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
    if (href.startsWith("local/runner-memory/")) return match;
    return `[${label}](local/runner-memory/${href})`;
  });
}

async function applyPulledRevisions(revisions: RemoteRevision[]): Promise<void> {
  for (const rev of revisions) {
    const target = join(PULL_TARGET, rev.path);
    if (rev.operation === "delete") {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, rev.content, { mode: 0o600 });
  }
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
