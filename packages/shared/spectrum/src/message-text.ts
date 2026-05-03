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

export async function extractMessageText(
  message: Pick<Message, "content">,
  opts: ExtractMessageTextOptions = {},
): Promise<string> {
  return extractContentText(message.content, opts);
}

async function extractContentText(
  content: ExtractableContent,
  opts: ExtractMessageTextOptions,
): Promise<string> {
  switch (content.type) {
    case "text":
      return content.text;
    case "voice":
      return transcribeAudioContent(content, opts);
    case "attachment":
      if (isAudioAttachment(content)) {
        return transcribeAudioContent(content, opts);
      }
      return `Attachment received: ${content.name} (${content.mimeType})`;
    case "effect":
      return extractContentText(content.content, opts);
    case "group": {
      const parts = await Promise.all(
        content.items.map((item) => extractMessageText(item, opts)),
      );
      return parts.filter(Boolean).join("\n\n");
    }
    case "contact":
      return "Contact card received.";
    case "poll":
      return `Poll received: ${content.title}`;
    case "poll_option":
      return `Poll option ${content.selected ? "selected" : "deselected"}: ${content.title}`;
    case "reaction":
      return `Reaction received: ${content.emoji}`;
    case "richlink":
      return `Link received: ${content.url.toString()}`;
    case "custom":
      return "Unsupported message content received.";
  }
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
