export type TtsConfig = {
  /** POST `{ "text": "..." }` → raw audio bytes (`audio/mpeg` preferred) or JSON `{ "audio_base64": "..." }` */
  webhookUrl?: string;
  webhookBearer?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  /** e.g. `eleven_v3`, `eleven_multilingual_v2` */
  elevenLabsModelId?: string;
  /** Uses OpenAI Text-to-Speech when voice name set (same key as chat); mp3 output */
  openAiApiKey?: string;
  openAiTtsVoice?: string;
};

function compactSummary(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastPeriod = cut.lastIndexOf(". ");
  const lastBang = cut.lastIndexOf("! ");
  const lastQ = cut.lastIndexOf("? ");
  const last = Math.max(lastPeriod, lastBang, lastQ);
  if (last > maxChars * 0.4) return `${cut.slice(0, last + 1)}…`;
  return `${cut}…`;
}

/** Plain text suitable for TTS (strip noisy formatting). */
export function stripForSpeech(s: string): string {
  return s
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One spoken TLDR for this turn: prefer Cursor run summary, else assistant text only (no tool bullets).
 */
export function buildVoiceSummary(
  runSummary: string | undefined,
  assistantPlain: string,
  maxChars = 2200,
): string {
  const summary = stripForSpeech(runSummary ?? "").trim();
  const assistant = stripForSpeech(
    assistantPlain
      .split("\n")
      .filter((line) => !/^\s*•\s/.test(line))
      .join(" "),
  ).trim();

  const preferSummary =
    summary.length >= 40 && !/^run\s|^error|^failed/i.test(summary.slice(0, 80));

  const base = preferSummary ? summary : assistant.length >= 20 ? assistant : summary || assistant;

  if (!base) return "";
  return compactSummary(base, maxChars);
}

export async function synthesizeSpeech(text: string, cfg: TtsConfig): Promise<{ buffer: Buffer; filename: string }> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty text for TTS");
  }

  if (cfg.webhookUrl?.trim()) {
    return ttsViaWebhook(trimmed, cfg.webhookUrl.trim(), cfg.webhookBearer?.trim());
  }

  if (cfg.elevenLabsApiKey?.trim() && cfg.elevenLabsVoiceId?.trim()) {
    return elevenLabsTts(
      trimmed,
      cfg.elevenLabsApiKey.trim(),
      cfg.elevenLabsVoiceId.trim(),
      cfg.elevenLabsModelId?.trim() || "eleven_multilingual_v2",
    );
  }

  if (cfg.openAiApiKey?.trim() && cfg.openAiTtsVoice?.trim()) {
    return openAiSpeech(trimmed, cfg.openAiApiKey.trim(), cfg.openAiTtsVoice.trim());
  }

  throw new Error("No TTS backend configured");
}

async function ttsViaWebhook(text: string, url: string, bearer?: string): Promise<{ buffer: Buffer; filename: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "audio/mpeg, audio/*, application/octet-stream, application/json",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TTS webhook ${res.status}: ${err.slice(0, 400)}`);
  }

  const ct = res.headers.get("content-type") ?? "";

  if (ct.includes("application/json")) {
    const j = (await res.json()) as { audio_base64?: string; audio?: string; url?: string };
    if (j.audio_base64) {
      return { buffer: Buffer.from(j.audio_base64, "base64"), filename: "voice.mp3" };
    }
    if (j.audio) {
      return { buffer: Buffer.from(j.audio, "base64"), filename: "voice.mp3" };
    }
    if (j.url) {
      const r = await fetch(j.url);
      if (!r.ok) throw new Error(`TTS webhook url fetch ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return { buffer: buf, filename: guessFilename(j.url) };
    }
    throw new Error("TTS webhook JSON missing audio_base64 / audio / url");
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const filename = ct.includes("ogg") ? "voice.ogg" : "voice.mp3";
  return { buffer: buf, filename };
}

function guessFilename(audioUrl: string): string {
  try {
    const u = new URL(audioUrl);
    const base = u.pathname.split("/").pop() ?? "";
    if (base.endsWith(".mp3") || base.endsWith(".ogg")) return base;
  } catch {
    /* ignore */
  }
  return "voice.mp3";
}

async function elevenLabsTts(
  text: string,
  apiKey: string,
  voiceId: string,
  modelId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 400)}`);
  }

  return { buffer: Buffer.from(await res.arrayBuffer()), filename: "voice.mp3" };
}

async function openAiSpeech(text: string, apiKey: string, voice: string): Promise<{ buffer: Buffer; filename: string }> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: text,
      format: "mp3",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${err.slice(0, 400)}`);
  }

  return { buffer: Buffer.from(await res.arrayBuffer()), filename: "voice.mp3" };
}
