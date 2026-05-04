/**
 * Task convention shared by server, agent prompts, and the mobile UI.
 *
 * Tasks are markdown memory files at path `tasks/<slug>.md` with YAML
 * frontmatter. Markdown remains the source of truth; this module is the
 * single parser/serializer for the structured fields, and produces the
 * `task_meta` JSONB cache stored on `memory_files` for fast querying.
 */

export const TASK_PATH_PREFIX = "tasks/";
export const TASK_TYPE = "task";

export const TASK_STATUSES = [
  "triage",
  "doing",
  "waiting_user",
  "waiting_external",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "triage",
  "doing",
  "waiting_user",
  "waiting_external",
];

export type FrontmatterMap = Record<string, string>;

export type TaskMeta = {
  name: string | null;
  description: string | null;
  status: TaskStatus;
  nextStep: string | null;
  nextCheckIn: string | null; // ISO 8601
  completedAt: string | null; // ISO 8601, set iff status === 'done'
};

export type ParsedTaskFile = {
  meta: TaskMeta;
  body: string;
  frontmatter: FrontmatterMap;
  warnings: string[];
};

const FRONTMATTER_DELIM = "---";

export function isTaskPath(path: string): boolean {
  return path.startsWith(TASK_PATH_PREFIX) && path.endsWith(".md");
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Parse a markdown file's frontmatter into a string map plus the body. Returns
 * an empty frontmatter map when no `---` block is present at the top.
 */
export function parseFrontmatter(content: string): {
  frontmatter: FrontmatterMap;
  body: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { frontmatter: {}, body: content, warnings };
  }
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { frontmatter: {}, body: content, warnings };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    warnings.push("frontmatter opening --- without matching closing ---");
    return { frontmatter: {}, body: content, warnings };
  }

  const frontmatter: FrontmatterMap = {};
  for (let i = 1; i < endIndex; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const colonAt = raw.indexOf(":");
    if (colonAt === -1) {
      warnings.push(`frontmatter line ${i + 1} has no colon: ${raw}`);
      continue;
    }
    const key = raw.slice(0, colonAt).trim();
    let value = raw.slice(colonAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { frontmatter, body, warnings };
}

export function serializeFrontmatter(frontmatter: FrontmatterMap, body: string): string {
  const orderedKeys = [
    "name",
    "description",
    "type",
    "status",
    "next_step",
    "next_check_in",
    "completed_at",
  ];
  const seen = new Set<string>();
  const lines: string[] = [FRONTMATTER_DELIM];
  for (const key of orderedKeys) {
    if (frontmatter[key] != null && frontmatter[key] !== "") {
      lines.push(`${key}: ${quoteIfNeeded(frontmatter[key]!)}`);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (seen.has(key)) continue;
    if (value == null || value === "") continue;
    lines.push(`${key}: ${quoteIfNeeded(value)}`);
  }
  lines.push(FRONTMATTER_DELIM);
  // Normalize trailing whitespace so two writes produce byte-identical output
  // for the same logical content. This is load-bearing for three-way merge —
  // without it, head and incoming bodies can diverge by a single trailing
  // newline and diff3 reports a spurious conflict.
  const cleanBody = body.replace(/^\n+/, "").replace(/\s*$/, "");
  return `${lines.join("\n")}\n\n${cleanBody}\n`;
}

function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (/[:#\n"']/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Parse a task file. Returns null if the file isn't a task (no `type: task`
 * frontmatter). Tolerant: missing required fields produce warnings + sensible
 * defaults so a malformed task still surfaces in the UI rather than vanishing.
 */
export function parseTaskFile(content: string): ParsedTaskFile | null {
  const { frontmatter, body, warnings } = parseFrontmatter(content);
  if (frontmatter.type !== TASK_TYPE) return null;

  const statusRaw = frontmatter.status;
  let status: TaskStatus;
  if (statusRaw && isTaskStatus(statusRaw)) {
    status = statusRaw;
  } else {
    if (statusRaw) warnings.push(`unknown status "${statusRaw}", defaulting to triage`);
    status = "triage";
  }

  const completedAt = normalizeIsoOrNull(frontmatter.completed_at);
  if (status === "done" && !completedAt) {
    warnings.push("task is done but completed_at is missing");
  }
  if (status !== "done" && completedAt) {
    warnings.push("completed_at set but status is not done");
  }

  const meta: TaskMeta = {
    name: frontmatter.name ?? null,
    description: frontmatter.description ?? null,
    status,
    nextStep: frontmatter.next_step ?? null,
    nextCheckIn: normalizeIsoOrNull(frontmatter.next_check_in),
    completedAt,
  };

  return { meta, body, frontmatter, warnings };
}

export function buildTaskFile(args: {
  meta: TaskMeta;
  body: string;
  extra?: FrontmatterMap;
}): string {
  const fm: FrontmatterMap = { ...(args.extra ?? {}) };
  fm.type = TASK_TYPE;
  if (args.meta.name) fm.name = args.meta.name;
  if (args.meta.description) fm.description = args.meta.description;
  fm.status = args.meta.status;
  if (args.meta.nextStep) fm.next_step = args.meta.nextStep;
  if (args.meta.nextCheckIn) fm.next_check_in = args.meta.nextCheckIn;
  if (args.meta.completedAt) fm.completed_at = args.meta.completedAt;
  return serializeFrontmatter(fm, args.body);
}

/**
 * Coerce an unknown string into an ISO 8601 timestamp, or null if it doesn't
 * parse. Lenient — agent-written values that are just `2026-05-04` get
 * promoted to start-of-day UTC.
 */
function normalizeIsoOrNull(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Extract the structured cache row to store on memory_files.task_meta.
 * Returns null for non-task files.
 */
export function extractTaskMeta(path: string, content: string): TaskMeta | null {
  if (!isTaskPath(path)) return null;
  const parsed = parseTaskFile(content);
  return parsed ? parsed.meta : null;
}

/**
 * Slugify a free-text title into a path-safe filename (without extension).
 * Used by quick-capture and the agent when picking a path for a new task.
 */
export function slugifyTitle(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return `task-${Date.now()}`;
  return cleaned.slice(0, 60);
}

export function taskPathFromTitle(title: string): string {
  return `${TASK_PATH_PREFIX}${slugifyTitle(title)}.md`;
}

export { mergeFile, isAgentOrigin, isHumanOrigin } from "./merge.ts";
export type { MergeOrigin, MergeResult, MergeSide } from "./merge.ts";
