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
import { sendOutbound, type SpectrumApp } from "@runner-mobile/spectrum";

const FALLBACK_REPLY = (microsite: string) =>
  `Hi 👋 I don't recognize this number yet. Head to ${microsite} to get set up.`;
const ERROR_REPLY = "Hmm, something broke on my end. Try again in a minute.";

export async function handleInboundMessage(opts: {
  spectrumApp: SpectrumApp;
  phoneNumber: string;
  text: string;
}): Promise<void> {
  const { spectrumApp, phoneNumber, text } = opts;
  const sendImessage = (msg: string) => sendOutbound(spectrumApp, phoneNumber, msg);

  try {
    const user = await findUserByPhone(phoneNumber);
    if (!user) {
      const microsite = process.env.MICROSITE_PUBLIC_URL ?? "the Runner microsite";
      await sendImessage(FALLBACK_REPLY(microsite));
      return;
    }

    const refreshed = await refreshIfExpired(user);
    const catalog = await getCatalog(refreshed.jwt, refreshed.workspaceId);

    const sent = await resumeOrSpawnAndRun({
      user: refreshed,
      catalog,
      userMessage: text,
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
 * Run a heartbeat tick for every idle user who has actually texted us at
 * least once (last_user_msg_at is not null and older than 4h).
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

  let texted = 0;
  for (const u of idle) {
    try {
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

  return { considered: idle.length, texted };
}

// Re-export so we can keep the unused-import lint happy if drizzle treeshaking trips.
export { isNotNull };
