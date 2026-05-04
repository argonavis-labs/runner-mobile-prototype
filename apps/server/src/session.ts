/**
 * The core "handle one inbound message" path. Used by the Spectrum consumer
 * loop and (via cron tick) by the heartbeat job.
 *
 * Phone number is the lookup key. Users are pre-registered via the microsite
 * `/api/link/init` route — if a webhook arrives from a phone we don't know,
 * we reply with a pointer back to the microsite.
 */

import { eq, sql, isNotNull } from "drizzle-orm";
import {
  consumePhoneLinkCode,
  db,
  findDueTasks,
  users,
  type MemoryFileRecord,
  type User,
} from "@runner-mobile/db";
import { getCatalog, refreshIfExpired } from "@runner-mobile/runner-api";
import { resumeOrSpawnAndRun } from "@runner-mobile/managed-agents";
import {
  createSharedUser,
  sendOutbound,
  sendRunnerContactCard,
  type ExtractedImage,
  type SpectrumApp,
} from "@runner-mobile/spectrum";

const FALLBACK_REPLY = (microsite: string) =>
  `Hi 👋 I don't recognize this number yet. Head to ${microsite} to get set up.`;
const ERROR_REPLY = "Hmm, something broke on my end. Try again in a minute.";
const HEARTBEAT_DEFAULT_TIME_ZONE = process.env.HEARTBEAT_DEFAULT_TIME_ZONE ?? "America/Los_Angeles";
const HEARTBEAT_SLOTS = [
  { name: "start_of_day", startHour: 7, endHour: 8 },
  { name: "midday", startHour: 12, endHour: 13 },
  { name: "end_of_day", startHour: 17, endHour: 18 },
] as const;

type HeartbeatSlot = (typeof HEARTBEAT_SLOTS)[number];

export async function handleInboundMessage(opts: {
  spectrumApp: SpectrumApp;
  phoneNumber: string;
  text: string;
  images?: ExtractedImage[];
}): Promise<void> {
  const { spectrumApp, phoneNumber, text, images = [] } = opts;
  const sendImessage = (msg: string) => sendOutbound(spectrumApp, phoneNumber, msg);

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      const microsite = process.env.MICROSITE_PUBLIC_URL ?? "the Runner microsite";
      await sendImessage(FALLBACK_REPLY(microsite));
      return;
    }

    if (!user.runnerContactSentAt && user.assignedPhoneNumber) {
      try {
        await sendRunnerContactCard(spectrumApp, phoneNumber, user.assignedPhoneNumber);
        await db
          .update(users)
          .set({ runnerContactSentAt: sql`now()` })
          .where(eq(users.phoneNumber, user.phoneNumber));
      } catch (err) {
        console.error("failed to send Runner contact card:", err);
      }
    }

    const refreshed = await refreshIfExpired(user);
    const catalog = await getCatalog(refreshed.jwt, refreshed.workspaceId);

    const sent = await resumeOrSpawnAndRun({
      user: refreshed,
      catalog,
      userMessage: text,
      images,
      onSendIMessage: sendImessage,
    });

    await db
      .update(users)
      .set({
        lastUserMsgAt: sql`now()`,
        ...(sent ? { lastAssistantMsgAt: sql`now()` } : {}),
      })
      .where(eq(users.phoneNumber, refreshed.phoneNumber));
  } catch (err) {
    console.error("handleInboundMessage failed:", err);
    try {
      await sendImessage(ERROR_REPLY);
    } catch (sendErr) {
      console.error("failed to send error reply:", sendErr);
    }
  }
}

async function findUserByPhone(phoneNumber: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.phoneNumber, phoneNumber)).limit(1);
  return rows[0] ?? null;
}

/**
 * Pre-handler for inbound texts. If the message looks like a phone-link
 * verification code from a number we don't yet recognize, consume it and
 * bind the phone to the web session that issued it. Returns true when the
 * message was handled (so the caller skips agent dispatch).
 */
export async function tryConsumePhoneLinkCode(opts: {
  spectrumApp: SpectrumApp;
  phoneNumber: string;
  text: string;
  reply: (text: string) => Promise<void>;
}): Promise<boolean> {
  const trimmed = opts.text.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;

  // If the phone is already linked to a user, treat the digits as a normal
  // message (the agent might want to do something with them).
  const existing = await findUserByPhone(opts.phoneNumber);
  if (existing) return false;

  const consumed = await consumePhoneLinkCode({ code: trimmed, phone: opts.phoneNumber });
  if (!consumed) return false;

  // Provision a Spectrum shared user so we can route outbound + send the
  // contact card. createSharedUser is upsert-by-phone in Spectrum.
  const sharedUser = await createSharedUser({ phoneNumber: opts.phoneNumber });

  await db
    .insert(users)
    .values({
      phoneNumber: opts.phoneNumber,
      runnerUserId: consumed.runnerUserId,
      workspaceId: consumed.workspaceId,
      jwt: consumed.jwt,
      refreshToken: consumed.refreshToken,
      jwtExpiresAt: consumed.jwtExpiresAt,
      spectrumUserId: sharedUser.id,
      assignedPhoneNumber: sharedUser.assignedPhoneNumber,
      email: consumed.email,
      timeZone: consumed.timeZone,
    })
    .onConflictDoUpdate({
      target: users.phoneNumber,
      set: {
        runnerUserId: consumed.runnerUserId,
        workspaceId: consumed.workspaceId,
        jwt: consumed.jwt,
        refreshToken: consumed.refreshToken,
        jwtExpiresAt: consumed.jwtExpiresAt,
        spectrumUserId: sharedUser.id,
        assignedPhoneNumber: sharedUser.assignedPhoneNumber,
        email: consumed.email,
        ...(consumed.timeZone ? { timeZone: consumed.timeZone } : {}),
      },
    });

  try {
    await sendRunnerContactCard(
      opts.spectrumApp,
      opts.phoneNumber,
      sharedUser.assignedPhoneNumber,
    );
    await db
      .update(users)
      .set({ runnerContactSentAt: sql`now()` })
      .where(eq(users.phoneNumber, opts.phoneNumber));
  } catch (err) {
    console.error("failed to send Runner contact card after phone-link:", err);
  }

  await opts.reply(
    "You're linked. I'll text you when something needs you — and you can find your task list in the web app.",
  );
  return true;
}

/**
 * Run scheduled heartbeat ticks for idle users who have actually texted us at
 * least once. The Railway cron wakes every 15 min, but each user is only
 * considered once per local-time heartbeat window.
 *
 * Newly-registered users who never sent a message do NOT receive proactive
 * texts — opt-in via first inbound is the only path to heartbeats.
 */
export async function runHeartbeatTicks(
  spectrumApp: SpectrumApp,
  opts: { skipUsers?: ReadonlySet<string> } = {},
): Promise<{
  considered: number;
  texted: number;
  skipped: number;
}> {
  const idle = await db
    .select()
    .from(users)
    .where(
      sql`${users.lastUserMsgAt} is not null and ${users.lastUserMsgAt} < now() - interval '1 hour'`,
    );

  let considered = 0;
  let texted = 0;
  let skipped = 0;
  const now = new Date();
  for (const u of idle) {
    if (opts.skipUsers?.has(u.phoneNumber)) {
      skipped += 1;
      continue;
    }
    const slotKey = heartbeatSlotKey(now, u.timeZone);
    if (!slotKey || u.lastHeartbeatSlot === slotKey) continue;

    try {
      considered += 1;
      await db
        .update(users)
        .set({
          lastHeartbeatTickAt: sql`now()`,
          lastHeartbeatSlot: slotKey,
        })
        .where(eq(users.phoneNumber, u.phoneNumber));

      const refreshed = await refreshIfExpired(u);
      const catalog = await getCatalog(refreshed.jwt, refreshed.workspaceId);
      const sent = await resumeOrSpawnAndRun({
        user: refreshed,
        catalog,
        userMessage: "[heartbeat tick]",
        onSendIMessage: (msg) => sendOutbound(spectrumApp, refreshed.phoneNumber, msg),
      });
      if (sent) {
        texted += 1;
        await db
          .update(users)
          .set({ lastAssistantMsgAt: sql`now()` })
          .where(eq(users.phoneNumber, refreshed.phoneNumber));
      }
    } catch (err) {
      console.error(`heartbeat failed for ${u.phoneNumber}:`, err);
    }
  }

  return { considered, texted, skipped };
}

// Re-export so we can keep the unused-import lint happy if drizzle treeshaking trips.
export { isNotNull };

/**
 * Sweep tasks whose next_check_in is due and synthesize a check-in message
 * to the owning user's session. Batches all due tasks per user into a single
 * message so the agent processes them in one turn.
 *
 * Returns the set of phone numbers we ran a turn for; the heartbeat sweep
 * uses this to avoid double-firing.
 */
export async function runTaskCheckInTicks(spectrumApp: SpectrumApp): Promise<{
  considered: number;
  usersServiced: number;
  texted: number;
  runForPhones: Set<string>;
}> {
  const now = new Date();
  const due: MemoryFileRecord[] = await findDueTasks(now);
  const runForPhones = new Set<string>();
  if (due.length === 0) return { considered: 0, usersServiced: 0, texted: 0, runForPhones };

  // Group by replicaId, then resolve to user.
  const byReplica = new Map<number, MemoryFileRecord[]>();
  for (const task of due) {
    const arr = byReplica.get(task.replicaId) ?? [];
    arr.push(task);
    byReplica.set(task.replicaId, arr);
  }

  // Resolve replicaId → user via runner_user_id + workspace_id from
  // memory_replicas. We do this in one query to keep the cron tick cheap.
  const replicaIds = [...byReplica.keys()];
  const replicaRows = await db.execute<{
    id: number;
    runner_user_id: string;
    workspace_id: string;
  }>(sql`
    select id, runner_user_id, workspace_id
    from memory_replicas
    where id = any(${replicaIds}::int[])
  `);
  const userByReplica = new Map<number, User>();
  for (const row of replicaRows.rows) {
    const matches = await db
      .select()
      .from(users)
      .where(eq(users.runnerUserId, row.runner_user_id))
      .limit(1);
    const u = matches[0];
    if (u && u.workspaceId === row.workspace_id) {
      userByReplica.set(row.id, u);
    }
  }

  let usersServiced = 0;
  let texted = 0;
  for (const [replicaId, tasks] of byReplica) {
    const user = userByReplica.get(replicaId);
    if (!user) continue;
    runForPhones.add(user.phoneNumber);
    usersServiced += 1;
    try {
      const refreshed = await refreshIfExpired(user);
      const catalog = await getCatalog(refreshed.jwt, refreshed.workspaceId);
      const paths = tasks.map((t) => t.path);
      const message = `[task check-in] paths: ${paths.join(", ")}`;
      const sent = await resumeOrSpawnAndRun({
        user: refreshed,
        catalog,
        userMessage: message,
        onSendIMessage: (msg) => sendOutbound(spectrumApp, refreshed.phoneNumber, msg),
      });
      if (sent) {
        texted += 1;
        await db
          .update(users)
          .set({ lastAssistantMsgAt: sql`now()` })
          .where(eq(users.phoneNumber, refreshed.phoneNumber));
      }
    } catch (err) {
      console.error(`task check-in failed for ${user.phoneNumber}:`, err);
    }
  }

  return { considered: due.length, usersServiced, texted, runForPhones };
}

function heartbeatSlotKey(now: Date, userTimeZone: string | null): string | null {
  const timeZone = validTimeZone(userTimeZone) ?? validTimeZone(HEARTBEAT_DEFAULT_TIME_ZONE);
  if (!timeZone) return null;

  const local = localDateHour(now, timeZone);
  if (!local) return null;

  const slot = HEARTBEAT_SLOTS.find((candidate) => inSlot(local.hour, candidate));
  if (!slot) return null;

  return `${local.date}:${slot.name}`;
}

function inSlot(hour: number, slot: HeartbeatSlot): boolean {
  return hour >= slot.startHour && hour < slot.endHour;
}

function validTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return null;
  }
}

function localDateHour(now: Date, timeZone: string): { date: string; hour: number } | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  if (!year || !month || !day || !hour) return null;

  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}
