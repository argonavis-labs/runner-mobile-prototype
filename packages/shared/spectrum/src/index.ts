/**
 * spectrum-ts wrapper for Photon iMessage.
 *
 * Spectrum is a long-running runtime — inbound messages arrive via an async
 * iterable (`app.messages`), not via webhooks. The server runs the consume
 * loop in the background; outbound is dispatched by resolving a user by phone
 * and calling `space.send(...)`. The cron service uses outbound only.
 *
 * The exact accessor for "sender's phone number" is provider-specific and the
 * public docs are vague. We try the iMessage-typed `im.phoneNumber(user)`
 * helper first; if that doesn't exist, fall back to `sender.id`. Verify
 * against a real inbound message during smoke testing — see TODO below.
 */

// Types in the published package are partial; we wrap loosely and verify at runtime.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

export type SpectrumApp = {
  messages: AsyncIterable<[unknown, unknown]>;
  shutdown?: () => Promise<void>;
};

export async function createSpectrumApp(): Promise<SpectrumApp> {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    throw new Error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required");
  }
  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  return app as SpectrumApp;
}

/**
 * Resolve an iMessage user by phone (E.164) and return their 1:1 space.
 * Cached per-process to avoid repeated lookups for the same number.
 */
const _spaceCache = new WeakMap<object, Map<string, unknown>>();

async function resolveSpace(app: SpectrumApp, phoneNumber: string): Promise<unknown> {
  let cache = _spaceCache.get(app as object);
  if (!cache) {
    cache = new Map();
    _spaceCache.set(app as object, cache);
  }
  const cached = cache.get(phoneNumber);
  if (cached) return cached;

  const im = imessage(app as never);
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
  const space = (await resolveSpace(app, phoneNumber)) as { send: (t: string) => Promise<void> };
  await space.send(text);
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
  for await (const [space, message] of app.messages as AsyncIterable<[
    { send: (t: string) => Promise<void> },
    {
      sender?: { id?: string };
      content?: unknown;
      reply?: (t: string) => Promise<void>;
    },
  ]>) {
    try {
      // TODO: verify against a real inbound payload — try im.phoneNumber(message.sender)
      // first if available, fall back to sender.id otherwise.
      const phoneNumber = message.sender?.id ?? "";
      const text = extractText(message.content);

      const reply = message.reply
        ? message.reply.bind(message)
        : async (t: string) => {
            await space.send(t);
          };

      if (!phoneNumber || !text) {
        console.warn("inbound message missing phone or text", { phoneNumber, text });
        continue;
      }

      await handler({ phoneNumber, text, reply });
    } catch (err) {
      console.error("inbound handler failed:", err);
    }
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}
