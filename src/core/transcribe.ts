export async function transcribeVoice(
  apiKey: string,
  audio: Buffer,
  mimeType: string,
  filename = "voice",
): Promise<string> {
  const ext =
    mimeType.includes("ogg") || mimeType.includes("opus")
      ? "ogg"
      : mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("wav")
          ? "wav"
          : mimeType.includes("m4a")
            ? "m4a"
            : "bin";

  const name = `${filename}.${ext}`;

  const form = new FormData();
  form.append("model", "whisper-1");
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType || "application/octet-stream" }),
    name,
  );

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const body = (await res.json()) as { text?: string };
  const text = body.text?.trim() ?? "";
  if (!text) {
    throw new Error("Whisper returned empty text");
  }
  return text;
}
