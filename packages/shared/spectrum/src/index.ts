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

import { deflateSync } from "node:zlib";
import {
  Spectrum,
  contact,
  type SpectrumInstance,
  type Space,
  type ContentBuilder,
} from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { extractMessage } from "./message-text";
import type { ExtractedImage } from "./message-text";

export { extractMessage, extractMessageText, isAudioMimeType } from "./message-text";
export type {
  AudioTranscriber,
  AudioTranscriptionInput,
  ExtractedImage,
  ExtractedMessage,
  ExtractMessageTextOptions,
} from "./message-text";

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

export async function sendRunnerContactCard(
  app: SpectrumApp,
  phoneNumber: string,
  runnerPhoneNumber: string,
): Promise<void> {
  const space = await resolveSpace(app, phoneNumber);
  await app.send(space, runnerContactCard(runnerPhoneNumber));
}

export function runnerContactCard(runnerPhoneNumber: string): ContentBuilder {
  return contact({
    name: {
      formatted: "Runner",
      first: "Runner",
    },
    phones: [
      {
        value: runnerPhoneNumber,
        type: "mobile",
      },
    ],
    org: {
      name: "Runner",
    },
    photo: {
      mimeType: "image/png",
      read: async () => runnerLogoPng(),
    },
  });
}

export type InboundHandler = (opts: {
  phoneNumber: string;
  text: string;
  images: ExtractedImage[];
  reply: (text: string) => Promise<void>;
}) => Promise<void>;

/**
 * Consume the inbound message stream forever, calling `handler` for each
 * `[space, message]`. Each handler call is wrapped in `space.responding()`
 * so iMessage shows the typing indicator while the agent is working —
 * Spectrum starts/stops it for the duration of the wrapped function.
 *
 * Errors in the handler are caught and logged so a single bad message
 * doesn't kill the loop.
 */
export async function consumeInboundMessages(
  app: SpectrumApp,
  handler: InboundHandler,
): Promise<void> {
  for await (const [space, message] of app.messages) {
    try {
      const phoneNumber = message.sender.id;
      const extracted = await extractMessage(message);

      const reply = async (t: string) => {
        const out = await message.reply(t);
        if (!out) throw new Error("reply returned undefined");
      };

      if (!phoneNumber || (!extracted.text && extracted.images.length === 0)) {
        console.warn("inbound skipped: missing phone or content", {
          phoneNumber: phoneNumber || "<empty>",
          hasText: extracted.text.length > 0,
          imageCount: extracted.images.length,
        });
        continue;
      }

      await space.responding(async () => {
        await handler({
          phoneNumber,
          text: extracted.text,
          images: extracted.images,
          reply,
        });
      });
    } catch (err) {
      console.error("inbound handler failed:", err);
    }
  }
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

let _runnerLogoPng: Buffer | null = null;

function runnerLogoPng(): Buffer {
  if (_runnerLogoPng) return _runnerLogoPng;

  const size = 512;
  const data = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    data[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const inMark = isRunnerLogoPixel(x, y);
      data[offset] = inMark ? 255 : 14;
      data[offset + 1] = inMark ? 255 : 16;
      data[offset + 2] = inMark ? 255 : 20;
      data[offset + 3] = 255;
    }
  }

  _runnerLogoPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", pngIhdr(size, size)),
    pngChunk("IDAT", deflateSync(data)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return _runnerLogoPng;
}

function isRunnerLogoPixel(x: number, y: number): boolean {
  const stem = x >= 132 && x <= 204 && y >= 116 && y <= 396;
  const top = x >= 132 && x <= 326 && y >= 116 && y <= 184;
  const right = x >= 298 && x <= 372 && y >= 154 && y <= 258;
  const mid = x >= 132 && x <= 326 && y >= 242 && y <= 306;
  const leg = x >= 244 && x <= 326 && y >= 282 && y <= 396 && x - y >= -88;
  return stem || top || right || mid || leg;
}

function pngIhdr(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = 8;
  buf[9] = 6;
  buf[10] = 0;
  buf[11] = 0;
  buf[12] = 0;
  return buf;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  // Spectrum's docs page (api-reference/users/create-shared-user) advertises
  // POST /projects/{id}/users/shared, but that returns 404. The real endpoint
  // is POST /projects/{id}/users/ with `type: "shared"` in the body. Verified
  // by trying both against a live project.
  const res = await fetch(
    `${SPECTRUM_BASE_URL}/projects/${projectId()}/users/`,
    {
      method: "POST",
      headers: {
        authorization: basicAuth(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...opts, type: "shared" }),
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
