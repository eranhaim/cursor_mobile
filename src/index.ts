import "dotenv/config";
import { createTelegramBot } from "./adapters/telegram";
import type { TtsConfig } from "./core/tts";
import { createAgentService } from "./core/service";

function ttsConfigFromEnv(): TtsConfig | undefined {
  const webhookUrl = process.env.TTS_WEBHOOK_URL?.trim();
  const webhookBearer = process.env.TTS_WEBHOOK_BEARER?.trim();
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const elevenLabsModelId = process.env.ELEVENLABS_MODEL?.trim();
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openAiTtsVoice = process.env.OPENAI_TTS_VOICE?.trim();

  const cfg: TtsConfig = {
    webhookUrl: webhookUrl || undefined,
    webhookBearer: webhookBearer || undefined,
    elevenLabsApiKey: elevenLabsApiKey || undefined,
    elevenLabsVoiceId: elevenLabsVoiceId || undefined,
    elevenLabsModelId: elevenLabsModelId || undefined,
    openAiApiKey: openAiApiKey && openAiTtsVoice ? openAiApiKey : undefined,
    openAiTtsVoice: openAiTtsVoice || undefined,
  };

  const hasWebhook = !!cfg.webhookUrl;
  const has11 = !!(cfg.elevenLabsApiKey && cfg.elevenLabsVoiceId);
  const hasOpenAi = !!(cfg.openAiApiKey && cfg.openAiTtsVoice);
  if (hasWebhook || has11 || hasOpenAi) return cfg;
  return undefined;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v.trim();
}

async function main(): Promise<void> {
  const cursorApiKey = req("CURSOR_API_KEY");
  const telegramToken = req("TELEGRAM_BOT_TOKEN");
  const allowed = req("ALLOWED_USER_IDS")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  if (allowed.length === 0) {
    throw new Error("ALLOWED_USER_IDS must list at least one numeric Telegram user id");
  }

  const defaultRepoUrl = process.env.DEFAULT_REPO_URL?.trim() ?? "";
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const dataDir = process.env.DATA_DIR?.trim() || "./data";

  if (!defaultRepoUrl && !githubToken) {
    console.warn(
      "[env] No DEFAULT_REPO_URL or GITHUB_TOKEN — set one so the bot knows which repo to use (or pick via /repos after adding GITHUB_TOKEN).",
    );
  }

  const service = createAgentService({
    cursorApiKey,
    openAiApiKey: process.env.OPENAI_API_KEY?.trim(),
    defaultRepoUrl,
    dataDir,
  });

  await service.hydrate();

  const tts = ttsConfigFromEnv();
  if (tts) {
    console.log("[tts] Voice TLDR enabled (webhook / ElevenLabs / OpenAI — see env)");
  }

  const bot = createTelegramBot(telegramToken, service, allowed, {
    githubToken,
    tts,
  });

  bot.catch((err) => console.error("[telegram] update failed", err));

  const stop = async () => {
    await service.shutdown();
    bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start({ onStart: (info) => console.log(`[telegram] bot @${info.username}`) });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
