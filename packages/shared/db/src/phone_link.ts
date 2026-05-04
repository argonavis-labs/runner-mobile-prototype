/**
 * Phone-link codes: short-lived (10 min) numeric codes the user texts from
 * their phone to the Runner number to bind their phone to their web session.
 */

import { randomInt } from "node:crypto";
import { pool } from "./client.ts";

export type PhoneLinkAuthBundle = {
  runnerUserId: string;
  workspaceId: string;
  email: string;
  jwt: string;
  refreshToken: string;
  jwtExpiresAt: Date;
  timeZone: string | null;
};

export type PhoneLinkCodeRecord = PhoneLinkAuthBundle & {
  code: string;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedPhone: string | null;
  createdAt: Date;
};

const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function issuePhoneLinkCode(bundle: PhoneLinkAuthBundle): Promise<{
  code: string;
  expiresAt: Date;
}> {
  // Loop on collision (vanishingly rare with 6 digits + 10 min TTL).
  for (let i = 0; i < 8; i += 1) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const result = await pool.query(
      `
        insert into phone_link_codes (
          code, runner_user_id, workspace_id, email, jwt, refresh_token,
          jwt_expires_at, time_zone, expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (code) do nothing
        returning code
      `,
      [
        code,
        bundle.runnerUserId,
        bundle.workspaceId,
        bundle.email,
        bundle.jwt,
        bundle.refreshToken,
        bundle.jwtExpiresAt.toISOString(),
        bundle.timeZone,
        expiresAt.toISOString(),
      ],
    );
    if ((result.rowCount ?? 0) > 0) {
      return { code, expiresAt };
    }
  }
  throw new Error("failed to allocate phone-link code");
}

type DbRow = {
  code: string;
  runner_user_id: string;
  workspace_id: string;
  email: string;
  jwt: string;
  refresh_token: string;
  jwt_expires_at: Date;
  time_zone: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_phone: string | null;
  created_at: Date;
};

function toRecord(row: DbRow): PhoneLinkCodeRecord {
  return {
    code: row.code,
    runnerUserId: row.runner_user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    jwt: row.jwt,
    refreshToken: row.refresh_token,
    jwtExpiresAt: row.jwt_expires_at,
    timeZone: row.time_zone,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedPhone: row.consumed_phone,
    createdAt: row.created_at,
  };
}

/**
 * Atomically consume a code: marks it consumed and returns the bundle if and
 * only if the code is unconsumed and unexpired. Returns null otherwise.
 */
export async function consumePhoneLinkCode(args: {
  code: string;
  phone: string;
}): Promise<PhoneLinkCodeRecord | null> {
  const result = await pool.query<DbRow>(
    `
      update phone_link_codes
      set consumed_at = now(), consumed_phone = $2
      where code = $1
        and consumed_at is null
        and expires_at > now()
      returning *
    `,
    [args.code, args.phone],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function getPhoneLinkCodeStatus(code: string): Promise<{
  pending: boolean;
  expired: boolean;
  consumedPhone: string | null;
} | null> {
  const result = await pool.query<DbRow>(
    `select * from phone_link_codes where code = $1 limit 1`,
    [code],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expired = row.expires_at.getTime() <= Date.now();
  return {
    pending: row.consumed_at == null && !expired,
    expired,
    consumedPhone: row.consumed_phone,
  };
}
