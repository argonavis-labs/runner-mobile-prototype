/**
 * The core "handle one inbound message" path. Used by the Spectrum consumer
 * loop and (via cron tick) by the heartbeat job.
 *
 * Phone number is the lookup key. Users are pre-registered via the microsite
 * `/api/link/init` route — if a webhook arrives from a phone we don't know,
 * we reply with a pointer back to the microsite.
 */

import { eq, sql, isNotNull } from "drizzle-orm";
import { db, users, type User } from "@runner-mobile/db";
import { getCatalog, refreshIfExpired } from "@runner-mobile/runner-api";
import { resumeOrSpawnAndRun } from "@runner-mobile/managed-agents";
import {
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
 * Run scheduled heartbeat ticks for idle users who have actually texted us at
 * least once. The Railway cron wakes every 15 min, but each user is only
 * considered once per local-time heartbeat window.
 *
 * Newly-registered users who never sent a message do NOT receive proactive
 * texts — opt-in via first inbound is the only path to heartbeats.
 */
export async function runHeartbeatTicks(spectrumApp: SpectrumApp): Promise<{
  considered: number;
  texted: number;
}> {
  const idle = await db
    .select()
    .from(users)
    .where(
      sql`${users.lastUserMsgAt} is not null and ${users.lastUserMsgAt} < now() - interval '1 hour'`,
    );

  let considered = 0;
  let texted = 0;
  const now = new Date();
  for (const u of idle) {
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

  return { considered, texted };
}

// Re-export so we can keep the unused-import lint happy if drizzle treeshaking trips.
export { isNotNull };

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
