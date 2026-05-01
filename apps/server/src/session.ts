/**
 * The core "handle one inbound message" path. Used by the Spectrum consumer
 * loop and (via cron tick) by the heartbeat job.
 */

import { eq, sql } from "drizzle-orm";
import { db, users, linkTokens, type User } from "@runner-mobile/db";
import { getCatalog, refreshIfExpired } from "@runner-mobile/runner-api";
import { resumeOrSpawnAndRun } from "@runner-mobile/managed-agents";
import { sendOutbound, type SpectrumApp } from "@runner-mobile/spectrum";

const LINK_TOKEN_RE = /\[link:([A-Za-z0-9_-]+)\]/;
const FALLBACK_REPLY =
  "Hi 👋 I don't recognize this number yet. Head to " +
  (process.env.MICROSITE_PUBLIC_URL ?? "the Runner microsite") +
  " to get set up.";
const ERROR_REPLY = "Hmm, something broke on my end. Try again in a minute.";

export async function handleInboundMessage(opts: {
  spectrumApp: SpectrumApp;
  phoneNumber: string;
  text: string;
}): Promise<void> {
  const { spectrumApp, phoneNumber, text } = opts;
  const sendImessage = (msg: string) => sendOutbound(spectrumApp, phoneNumber, msg);

  try {
    let user = await findUserByPhone(phoneNumber);
    let messageText = text;

    if (!user) {
      const match = LINK_TOKEN_RE.exec(text);
      if (!match) {
        await sendImessage(FALLBACK_REPLY);
        return;
      }
      const tokenStr = match[1];
      if (!tokenStr) {
        await sendImessage(FALLBACK_REPLY);
        return;
      }
      const consumed = await consumeLinkToken(tokenStr, phoneNumber);
      if (!consumed) {
        await sendImessage(FALLBACK_REPLY);
        return;
      }
      user = consumed;
      messageText = text.replace(LINK_TOKEN_RE, "").trim();
      if (!messageText) messageText = "hi";
    }

    user = await refreshIfExpired(user);
    const catalog = await getCatalog(user.jwt, user.workspaceId);

    const sent = await resumeOrSpawnAndRun({
      user,
      catalog,
      userMessage: messageText,
      onSendIMessage: sendImessage,
    });

    await db
      .update(users)
      .set({
        lastUserMsgAt: sql`now()`,
        ...(sent ? { lastAssistantMsgAt: sql`now()` } : {}),
      })
      .where(eq(users.phoneNumber, user.phoneNumber));
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

async function consumeLinkToken(token: string, phoneNumber: string): Promise<User | null> {
  const tokenRows = await db
    .select()
    .from(linkTokens)
    .where(eq(linkTokens.token, token))
    .limit(1);

  const t = tokenRows[0];
  if (!t) return null;
  if (t.consumedAt) return null;
  if (t.expiresAt.getTime() < Date.now()) return null;

  // Insert user row if it doesn't already exist (race-tolerant). If a user with
  // this phone number arrives via a second link token, the second one no-ops.
  const inserted = await db
    .insert(users)
    .values({
      phoneNumber,
      runnerUserId: t.runnerUserId,
      workspaceId: t.workspaceId,
      jwt: t.jwt,
      refreshToken: t.refreshToken,
      jwtExpiresAt: t.jwtExpiresAt,
    })
    .onConflictDoNothing({ target: users.phoneNumber })
    .returning();

  await db
    .update(linkTokens)
    .set({ consumedAt: sql`now()` })
    .where(eq(linkTokens.token, token));

  if (inserted[0]) return inserted[0];
  // race: someone else inserted first — re-read
  return findUserByPhone(phoneNumber);
}

/**
 * Run a heartbeat tick for every idle user. Used by the cron tick endpoint.
 */
export async function runHeartbeatTicks(spectrumApp: SpectrumApp): Promise<{
  considered: number;
  texted: number;
}> {
  const idle = await db
    .select()
    .from(users)
    .where(
      sql`${users.lastUserMsgAt} < now() - interval '4 hours' or ${users.lastUserMsgAt} is null`,
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
