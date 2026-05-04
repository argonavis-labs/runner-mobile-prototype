/**
 * Three-way merge for task files. Used server-side when two clients push
 * concurrent edits against the same file revision.
 *
 * Frontmatter — per-key resolution with these privileged rules:
 *   - status: "done" always wins (closing a loop is privileged).
 *   - completed_at: travels with status: done (set/clear together).
 *   - next_check_in: agent's value wins (origin in mobile|web|cloud) over local.
 *   - everything else: most recent revision's value wins.
 *
 * Body — line-level diff3. Clean merges go through. Overlapping conflicts
 * emit standard <<<<<<< / ======= / >>>>>>> markers, and the caller flips
 * the task to status: waiting_user with a "Runner found a conflict" next_step.
 */

import { mergeDiff3 } from "node-diff3";
import {
  buildTaskFile,
  parseTaskFile,
  type TaskMeta,
  type TaskStatus,
} from "./index.ts";

export type MergeOrigin = "local" | "mobile" | "web" | "system" | "cloud";

export type MergeSide = {
  content: string;
  origin: MergeOrigin;
  revisionTimestamp: Date;
};

export type MergeResult = {
  mergedContent: string;
  hadBodyConflict: boolean;
  hadFrontmatterConflict: boolean;
  notes: string[];
};

const AGENT_ORIGINS: MergeOrigin[] = ["mobile", "web", "cloud", "system"];
const HUMAN_ORIGINS: MergeOrigin[] = ["local"];

export function isAgentOrigin(origin: MergeOrigin): boolean {
  return AGENT_ORIGINS.includes(origin);
}
export function isHumanOrigin(origin: MergeOrigin): boolean {
  return HUMAN_ORIGINS.includes(origin);
}

/**
 * Merge `head` (the current canonical) and `incoming` (the new push) using
 * `base` (the common ancestor) as the diff baseline. If the file isn't a
 * task, we fall back to a generic line-level body merge with no frontmatter
 * smarts.
 */
export function mergeFile(args: {
  base: MergeSide;
  head: MergeSide;
  incoming: MergeSide;
}): MergeResult {
  const baseTask = parseTaskFile(args.base.content);
  const headTask = parseTaskFile(args.head.content);
  const incomingTask = parseTaskFile(args.incoming.content);

  if (baseTask && headTask && incomingTask) {
    return mergeTaskFile({
      base: { ...args.base, parsed: baseTask },
      head: { ...args.head, parsed: headTask },
      incoming: { ...args.incoming, parsed: incomingTask },
    });
  }

  // Generic body-only merge for non-task files.
  const body = mergeBody(args.base.content, args.head.content, args.incoming.content);
  return {
    mergedContent: body.merged,
    hadBodyConflict: body.conflict,
    hadFrontmatterConflict: false,
    notes: body.conflict ? ["non-task body conflict — markers in content"] : [],
  };
}

type ParsedSide = MergeSide & { parsed: NonNullable<ReturnType<typeof parseTaskFile>> };

function mergeTaskFile(args: {
  base: ParsedSide;
  head: ParsedSide;
  incoming: ParsedSide;
}): MergeResult {
  const notes: string[] = [];
  const fmMerge = mergeFrontmatter({
    base: args.base,
    head: args.head,
    incoming: args.incoming,
  });
  for (const note of fmMerge.notes) notes.push(note);

  const bodyMerge = mergeBody(
    args.base.parsed.body,
    args.head.parsed.body,
    args.incoming.parsed.body,
  );

  let meta: TaskMeta = fmMerge.meta;
  if (bodyMerge.conflict) {
    notes.push("body conflict — markers in body, status forced to waiting_user");
    meta = {
      ...meta,
      status: "waiting_user",
      nextStep: "Runner resolved a sync conflict — please confirm the merged content.",
    };
    if (meta.completedAt) {
      meta.completedAt = null;
    }
  }

  const merged = buildTaskFile({ meta, body: bodyMerge.merged });
  return {
    mergedContent: merged,
    hadBodyConflict: bodyMerge.conflict,
    hadFrontmatterConflict: fmMerge.hadConflict,
    notes,
  };
}

function mergeFrontmatter(args: {
  base: ParsedSide;
  head: ParsedSide;
  incoming: ParsedSide;
}): { meta: TaskMeta; hadConflict: boolean; notes: string[] } {
  const base = args.base.parsed.meta;
  const head = args.head.parsed.meta;
  const incoming = args.incoming.parsed.meta;
  const notes: string[] = [];
  let hadConflict = false;

  // Privileged: any side flipping to done wins; pin completed_at along with it.
  let status: TaskStatus;
  let completedAt: string | null;
  const headDone = head.status === "done" && incoming.status !== "done";
  const incomingDone = incoming.status === "done" && head.status !== "done";
  if (headDone && incomingDone) {
    // both done — pick most recent
    const winner = pickByTimestamp(args.head, args.incoming);
    status = "done";
    completedAt = winner === args.head ? head.completedAt : incoming.completedAt;
  } else if (headDone) {
    status = "done";
    completedAt = head.completedAt ?? new Date().toISOString();
  } else if (incomingDone) {
    status = "done";
    completedAt = incoming.completedAt ?? new Date().toISOString();
  } else {
    const headChanged = head.status !== base.status;
    const incChanged = incoming.status !== base.status;
    if (headChanged && incChanged && head.status !== incoming.status) {
      hadConflict = true;
      notes.push(`status conflict: head=${head.status} incoming=${incoming.status}`);
      const winner = pickByTimestamp(args.head, args.incoming);
      status = winner === args.head ? head.status : incoming.status;
    } else if (headChanged) {
      status = head.status;
    } else if (incChanged) {
      status = incoming.status;
    } else {
      status = head.status;
    }
    // completed_at follows status: done. Clear when not done.
    if (status === "done") {
      completedAt =
        head.status === "done"
          ? head.completedAt
          : incoming.status === "done"
            ? incoming.completedAt
            : (head.completedAt ?? incoming.completedAt ?? new Date().toISOString());
    } else {
      completedAt = null;
    }
  }

  // next_check_in: agent wins over human if both changed.
  const headCheckChanged = head.nextCheckIn !== base.nextCheckIn;
  const incCheckChanged = incoming.nextCheckIn !== base.nextCheckIn;
  let nextCheckIn: string | null;
  if (headCheckChanged && incCheckChanged && head.nextCheckIn !== incoming.nextCheckIn) {
    const headIsAgent = isAgentOrigin(args.head.origin);
    const incIsAgent = isAgentOrigin(args.incoming.origin);
    if (headIsAgent && !incIsAgent) {
      nextCheckIn = head.nextCheckIn;
    } else if (incIsAgent && !headIsAgent) {
      nextCheckIn = incoming.nextCheckIn;
    } else {
      const winner = pickByTimestamp(args.head, args.incoming);
      nextCheckIn = winner === args.head ? head.nextCheckIn : incoming.nextCheckIn;
    }
    notes.push(`next_check_in conflict: agent-priority resolved`);
    hadConflict = true;
  } else if (headCheckChanged) {
    nextCheckIn = head.nextCheckIn;
  } else if (incCheckChanged) {
    nextCheckIn = incoming.nextCheckIn;
  } else {
    nextCheckIn = head.nextCheckIn;
  }

  // Generic LWW for the rest.
  const name = mergeStringField(args, base.name, head.name, incoming.name);
  const description = mergeStringField(
    args,
    base.description,
    head.description,
    incoming.description,
  );
  const nextStep = mergeStringField(args, base.nextStep, head.nextStep, incoming.nextStep);

  return {
    meta: {
      name: name.value,
      description: description.value,
      status,
      nextStep: nextStep.value,
      nextCheckIn,
      completedAt,
    },
    hadConflict: hadConflict || name.conflict || description.conflict || nextStep.conflict,
    notes,
  };
}

function mergeStringField(
  sides: { head: ParsedSide; incoming: ParsedSide },
  base: string | null,
  head: string | null,
  incoming: string | null,
): { value: string | null; conflict: boolean } {
  const headChanged = head !== base;
  const incChanged = incoming !== base;
  if (headChanged && incChanged && head !== incoming) {
    const winner = pickByTimestamp(sides.head, sides.incoming);
    return { value: winner === sides.head ? head : incoming, conflict: true };
  }
  if (headChanged) return { value: head, conflict: false };
  if (incChanged) return { value: incoming, conflict: false };
  return { value: head, conflict: false };
}

function pickByTimestamp(a: MergeSide, b: MergeSide): MergeSide {
  return a.revisionTimestamp.getTime() >= b.revisionTimestamp.getTime() ? a : b;
}

function mergeBody(
  base: string,
  head: string,
  incoming: string,
): { merged: string; conflict: boolean } {
  if (head === incoming) return { merged: head, conflict: false };
  if (head === base) return { merged: incoming, conflict: false };
  if (incoming === base) return { merged: head, conflict: false };

  const result = mergeDiff3(head, base, incoming, {
    stringSeparator: "\n",
    label: { a: "head", o: "base", b: "incoming" },
  });
  return { merged: result.result.join("\n"), conflict: result.conflict };
}
