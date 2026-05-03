import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type { Message } from "spectrum-ts";

type MessageContent = Message["content"];
type EffectContent = Extract<MessageContent, { type: "effect" }>["content"];
type ExtractableContent = MessageContent | EffectContent;
type AudioContent = Extract<MessageContent, { type: "attachment" | "voice" }>;

export type AudioTranscriptionInput = {
  buffer: Buffer;
  mimeType: string;
  name: string;
};

export type AudioTranscriber = (input: AudioTranscriptionInput) => Promise<string>;

export type ExtractMessageTextOptions = {
  transcribeAudio?: AudioTranscriber;
};

export type ExtractedImage = {
  data: string;
  mimeType: SupportedImageMimeType;
  name: string;
};

export type ExtractedMessage = {
  text: string;
  images: ExtractedImage[];
};

export async function extractMessageText(
  message: Pick<Message, "content">,
  opts: ExtractMessageTextOptions = {},
): Promise<string> {
  return (await extractMessage(message, opts)).text;
}

export async function extractMessage(
  message: Pick<Message, "content">,
  opts: ExtractMessageTextOptions = {},
): Promise<ExtractedMessage> {
  return extractContent(message.content, opts);
}

async function extractContent(
  content: ExtractableContent,
  opts: ExtractMessageTextOptions,
): Promise<ExtractedMessage> {
  switch (content.type) {
    case "text":
      return textOnly(content.text);
    case "voice":
      return textOnly(await transcribeAudioContent(content, opts));
    case "attachment":
      if (isAudioAttachment(content)) {
        return textOnly(await transcribeAudioContent(content, opts));
      }
      if (isImageAttachment(content)) {
        return imageContent(content);
      }
      return textOnly(`Attachment received: ${content.name} (${content.mimeType})`);
    case "effect":
      return extractContent(content.content, opts);
    case "group": {
      const parts = await Promise.all(content.items.map((item) => extractMessage(item, opts)));
      return {
        text: parts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n\n"),
        images: parts.flatMap((part) => part.images),
      };
    }
    case "contact":
      return textOnly("Contact card received.");
    case "poll":
      return textOnly(`Poll received: ${content.title}`);
    case "poll_option":
      return textOnly(
        `Poll option ${content.selected ? "selected" : "deselected"}: ${content.title}`,
      );
    case "reaction":
      return textOnly(`Reaction received: ${content.emoji}`);
    case "richlink":
      return textOnly(`Link received: ${content.url.toString()}`);
    case "custom":
      return textOnly("Unsupported message content received.");
  }
}

function textOnly(text: string): ExtractedMessage {
  return { text, images: [] };
}

async function transcribeAudioContent(
  content: AudioContent,
  opts: ExtractMessageTextOptions,
): Promise<string> {
  const name = content.type === "voice" ? (content.name ?? "voice.m4a") : content.name;

  try {
    const transcriber = opts.transcribeAudio ?? transcribeWithOpenAI;
    const rawAudio = {
      buffer: await content.read(),
      mimeType: content.mimeType,
      name,
    };
    const audio = opts.transcribeAudio ? rawAudio : await normalizeAudioForOpenAI(rawAudio);
    const transcript = (await transcriber(audio)).trim();
    if (!transcript) return "Voice note received, but no speech was detected.";
    return `Voice note transcript: ${transcript}`;
  } catch (err) {
    console.error("audio transcription failed:", err);
    return "Voice note received, but transcription failed on our side.";
  }
}

export function isAudioMimeType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized.startsWith("audio/") || normalized === "application/ogg";
}

function isAudioAttachment(content: Extract<MessageContent, { type: "attachment" }>): boolean {
  return isAudioMimeType(content.mimeType) || isAudioFileName(content.name);
}

function isAudioFileName(name: string): boolean {
  return AUDIO_FILE_EXTENSIONS.has(fileExtension(name));
}

function isImageAttachment(content: Extract<MessageContent, { type: "attachment" }>): boolean {
  return isImageMimeType(content.mimeType) || isImageFileName(content.name);
}

function isImageMimeType(mimeType: string): boolean {
  return normalizeMimeType(mimeType).startsWith("image/");
}

function isImageFileName(name: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(fileExtension(name));
}

const AUDIO_FILE_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".amr",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

const OPENAI_AUDIO_FILE_EXTENSIONS = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
]);

const OPENAI_AUDIO_MIME_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

const OPENAI_AUDIO_MIME_BY_EXTENSION = new Map([
  [".flac", "audio/flac"],
  [".m4a", "audio/m4a"],
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpga"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

const OPENAI_AUDIO_EXTENSION_BY_MIME = new Map(
  [...OPENAI_AUDIO_MIME_BY_EXTENSION].map(([ext, mimeType]) => [mimeType, ext]),
);

const IMAGE_FILE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const);

type SupportedImageMimeType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

const IMAGE_MIME_BY_EXTENSION = new Map<string, SupportedImageMimeType>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

function fileExtension(name: string): string {
  return extname(name).toLowerCase();
}

async function normalizeAudioForOpenAI(
  input: AudioTranscriptionInput,
): Promise<AudioTranscriptionInput> {
  const ext = fileExtension(input.name);
  const mimeType = normalizeMimeType(input.mimeType);
  if (OPENAI_AUDIO_FILE_EXTENSIONS.has(ext)) {
    return {
      ...input,
      mimeType: OPENAI_AUDIO_MIME_BY_EXTENSION.get(ext) ?? input.mimeType,
    };
  }

  if (!ext && OPENAI_AUDIO_MIME_TYPES.has(mimeType)) {
    const inferredExt = OPENAI_AUDIO_EXTENSION_BY_MIME.get(mimeType) ?? ".m4a";
    return {
      ...input,
      name: `${input.name || "voice"}${inferredExt}`,
    };
  }

  console.warn("converting inbound audio before transcription", {
    name: input.name,
    mimeType: input.mimeType,
  });
  return convertAudioToWav(input);
}

async function convertAudioToWav(input: AudioTranscriptionInput): Promise<AudioTranscriptionInput> {
  const dir = await mkdtemp(join(tmpdir(), "runner-audio-"));
  const inputExt = fileExtension(input.name) || ".audio";
  const inputPath = join(dir, `input${inputExt}`);
  const outputPath = join(dir, "output.wav");

  try {
    await writeFile(inputPath, input.buffer);
    await execFileAsync(ffmpeg.path, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      outputPath,
    ]);
    const converted = await readFile(outputPath);
    return {
      buffer: converted,
      mimeType: "audio/wav",
      name: `${basename(input.name, inputExt) || "voice"}.wav`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function imageContent(
  content: Extract<MessageContent, { type: "attachment" }>,
): Promise<ExtractedMessage> {
  try {
    const rawImage = {
      buffer: await content.read(),
      mimeType: content.mimeType,
      name: content.name,
    };
    const image = await normalizeImageForManagedAgents(rawImage);
    return {
      text: `Image received: ${image.name}`,
      images: [
        {
          data: image.buffer.toString("base64"),
          mimeType: image.mimeType,
          name: image.name,
        },
      ],
    };
  } catch (err) {
    console.error("image attachment processing failed:", err);
    return textOnly("Image received, but I couldn't process it on our side.");
  }
}

async function normalizeImageForManagedAgents(input: {
  buffer: Buffer;
  mimeType: string;
  name: string;
}): Promise<{ buffer: Buffer; mimeType: SupportedImageMimeType; name: string }> {
  const ext = fileExtension(input.name);
  const mimeType = normalizeMimeType(input.mimeType);
  if (isSupportedImageMimeType(mimeType)) {
    return { ...input, mimeType };
  }

  const inferredMimeType = IMAGE_MIME_BY_EXTENSION.get(ext);
  if (inferredMimeType) {
    return { ...input, mimeType: inferredMimeType };
  }

  console.warn("converting inbound image before managed-agent handoff", {
    name: input.name,
    mimeType: input.mimeType,
  });
  return convertImageToPng(input);
}

function isSupportedImageMimeType(mimeType: string): mimeType is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType as SupportedImageMimeType);
}

async function convertImageToPng(input: {
  buffer: Buffer;
  name: string;
  mimeType: string;
}): Promise<{ buffer: Buffer; mimeType: "image/png"; name: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-image-"));
  const inputExt = fileExtension(input.name) || ".image";
  const inputPath = join(dir, `input${inputExt}`);
  const outputPath = join(dir, "output.png");

  try {
    await writeFile(inputPath, input.buffer);
    await execFileAsync(ffmpeg.path, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      outputPath,
    ]);
    const converted = await readFile(outputPath);
    return {
      buffer: converted,
      mimeType: "image/png",
      name: `${basename(input.name, inputExt) || "image"}.png`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function execFileAsync(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });
}

async function transcribeWithOpenAI(input: AudioTranscriptionInput): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for voice note transcription");

  const model = process.env.OPENAI_AUDIO_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
  const fallbackModels = process.env.OPENAI_AUDIO_TRANSCRIPTION_MODEL ? [] : ["whisper-1"];
  const models = [model, ...fallbackModels];
  let lastErr: unknown;

  for (const candidate of models) {
    try {
      return await transcribeWithOpenAIModel(input, apiKey, candidate);
    } catch (err) {
      lastErr = err;
      console.warn(`OpenAI transcription failed with ${candidate}:`, err);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function transcribeWithOpenAIModel(
  input: AudioTranscriptionInput,
  apiKey: string,
  model: string,
): Promise<string> {
  const form = new FormData();
  const audioBytes = new Uint8Array(input.buffer.length);
  audioBytes.set(input.buffer);
  form.set("model", model);
  form.set("file", new File([audioBytes], input.name, { type: input.mimeType }));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const body = (await res.json()) as { text?: unknown; error?: unknown };
  if (!res.ok) {
    throw new Error(`OpenAI transcription failed: ${res.status} ${JSON.stringify(body)}`);
  }
  if (typeof body.text !== "string") {
    throw new Error(`OpenAI transcription returned no text: ${JSON.stringify(body)}`);
  }
  return body.text;
}
