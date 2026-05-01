/**
 * spectrum-ts wrapper for Photon iMessage.
 *
 * Spectrum is a long-running runtime — inbound messages arrive via an async
 * iterable on `app.messages`, not via webhooks. The server runs the consume
 * loop in the background; outbound is dispatched by resolving a user by phone
 * (`im.user(phoneNumber)`), opening a 1:1 space (`im.space(user)`), and
 * calling `space.send(text)`. The cron service uses outbound only.
 *
 * iMessage user `id` IS the canonical handle — for SMS/iMessage that's the
 * E.164 phone number, for an Apple-ID handle it's the email. We treat
 * `message.sender.id` as the user's address for our `users.phone_number`
 * column. (Validated against spectrum-ts 1.2 typedefs in
 * `dist/providers/imessage/index.d.ts` — the user schema is `z.object({})`,
 * extended only by the base `User = { id: string }`.)
 */

import { Spectrum, type SpectrumInstance, type Space, type Message } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

export type SpectrumApp = SpectrumInstance;

export async function createSpectrumApp(): Promise<SpectrumApp> {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    throw new Error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required");
  }
  return Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
}

const _spaceCache = new WeakMap<SpectrumApp, Map<string, Space>>();

async function resolveSpace(app: SpectrumApp, phoneNumber: string): Promise<Space> {
  let cache = _spaceCache.get(app);
  if (!cache) {
    cache = new Map();
    _spaceCache.set(app, cache);
  }
  const cached = cache.get(phoneNumber);
  if (cached) return cached;

  const im = imessage(app);
  const user = await im.user(phoneNumber);
  const space = await im.space(user);
  cache.set(phoneNumber, space);
  return space;
}

export async function sendOutbound(
  app: SpectrumApp,
  phoneNumber: string,
  text: string,
): Promise<void> {
  const space = await resolveSpace(app, phoneNumber);
  await app.send(space, text);
}

export type InboundHandler = (opts: {
  phoneNumber: string;
  text: string;
  reply: (text: string) => Promise<void>;
}) => Promise<void>;

/**
 * Consume the inbound message stream forever, calling `handler` for each
 * `[space, message]`. Errors in the handler are caught and logged so a single
 * bad message doesn't kill the loop.
 */
export async function consumeInboundMessages(
  app: SpectrumApp,
  handler: InboundHandler,
): Promise<void> {
  for await (const [, message] of app.messages) {
    try {
      const phoneNumber = message.sender.id;
      const text = extractText(message);

      const reply = async (t: string) => {
        const out = await message.reply(t);
        if (!out) throw new Error("reply returned undefined");
      };

      if (!phoneNumber || !text) {
        console.warn("inbound skipped: missing phone or text", {
          phoneNumber: phoneNumber || "<empty>",
          hasText: text.length > 0,
        });
        continue;
      }

      await handler({ phoneNumber, text, reply });
    } catch (err) {
      console.error("inbound handler failed:", err);
    }
  }
}

function extractText(message: Message): string {
  // spectrum-ts Content is a discriminated union; we want the text variant.
  const block = message.content;
  if (block.type === "text") return block.text;
  return "";
}

// ---------- REST API (cloud) ----------
//
// Spectrum SDK doesn't expose project-management endpoints (create shared
// user, redirect URL minting), so we hit the REST API directly. Auth is
// HTTP Basic with `projectId:projectSecret`.
// Docs: https://docs.photon.codes/api-reference/users/create-shared-user

const SPECTRUM_BASE_URL = "https://spectrum.photon.codes";

function basicAuth(): string {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    throw new Error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required");
  }
  return `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`;
}

function projectId(): string {
  const id = process.env.SPECTRUM_PROJECT_ID;
  if (!id) throw new Error("SPECTRUM_PROJECT_ID is required");
  return id;
}

export type SharedUser = {
  id: string;
  phoneNumber: string;
  assignedPhoneNumber: string;
};

export async function createSharedUser(opts: {
  phoneNumber: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): Promise<SharedUser> {
  const res = await fetch(
    `${SPECTRUM_BASE_URL}/projects/${projectId()}/users/shared`,
    {
      method: "POST",
      headers: {
        authorization: basicAuth(),
        "content-type": "application/json",
      },
      body: JSON.stringify(opts),
    },
  );
  const body = (await res.json()) as
    | { succeed: true; data: SharedUser }
    | { succeed: false; error?: string };
  if (!res.ok || !body.succeed) {
    throw new Error(`createSharedUser failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

/**
 * Build the public redirect URL the browser can hit to deep-link into
 * Messages with the project's assigned phone prefilled. Spectrum's redirect
 * endpoint is unauthenticated (it just looks up by user UUID).
 */
export function redirectUrl(spectrumUserId: string, prefilledMessage: string): string {
  const url = new URL(`${SPECTRUM_BASE_URL}/users/${spectrumUserId}/redirect`);
  url.searchParams.set("msg", prefilledMessage);
  return url.toString();
}
