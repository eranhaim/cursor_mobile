import { Bot, GrammyError, InlineKeyboard, InputFile, type Api } from "grammy";
import { createUserRepo, fetchMyRepos, type RepoSummary } from "../core/github";
import type { AgentService } from "../core/service";
import { buildVoiceSummary, synthesizeSpeech, type TtsConfig } from "../core/tts";
import type { AgentEvent } from "../core/types";
import { clipPlainForTelegram, escapeHtml } from "./telegram-format";

type RepoPickCache = { repos: RepoSummary[]; page: number; expires: number };

function rememberRepos(cache: Map<number, RepoPickCache>, userId: number, repos: RepoSummary[], page: number) {
  cache.set(userId, { repos, page, expires: Date.now() + 15 * 60 * 1000 });
}

function recallRepos(cache: Map<number, RepoPickCache>, userId: number): RepoPickCache | undefined {
  const c = cache.get(userId);
  if (!c || c.expires < Date.now()) {
    cache.delete(userId);
    return undefined;
  }
  return c;
}

async function safeEditHtml(
  api: Api,
  chatId: number,
  messageId: number,
  plain: string,
): Promise<void> {
  const html = escapeHtml(clipPlainForTelegram(plain));
  try {
    await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
  } catch (e) {
    if (e instanceof GrammyError && e.description.includes("message is not modified")) {
      return;
    }
    throw e;
  }
}

async function streamAgentEventsToChat(
  api: Api,
  chatId: number,
  seedMessageId: number,
  events: AsyncIterable<AgentEvent>,
  opts?: { debounceMs?: number; tts?: TtsConfig },
): Promise<void> {
  const debounceMs = opts?.debounceMs ?? 1500;
  const tts = opts?.tts;
  let plain = "";
  let assistantPlain = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flushSoon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void safeEditHtml(api, chatId, seedMessageId, plain).catch(console.error);
    }, debounceMs);
  };

  const flushNow = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await safeEditHtml(api, chatId, seedMessageId, plain);
  };

  for await (const ev of events) {
    if (ev.type === "text") {
      plain += ev.chunk;
      assistantPlain += ev.chunk;
      if (plain.length > 12000) {
        plain = `${plain.slice(0, 12000)}\n…(truncated)`;
      }
      if (assistantPlain.length > 12000) {
        assistantPlain = assistantPlain.slice(0, 12000);
      }
      flushSoon();
    } else if (ev.type === "tool") {
      plain += `\n• ${ev.name}: ${ev.summary.slice(0, 200)}\n`;
      flushSoon();
    } else if (ev.type === "startup_error") {
      if (timer) clearTimeout(timer);
      await api.sendMessage(
        chatId,
        `❌ ${escapeHtml(ev.message)}\n<i>retryable: ${ev.retryable}</i>`,
        { parse_mode: "HTML" },
      );
      return;
    } else if (ev.type === "done") {
      await flushNow();
      let tail =
        ev.result === "finished"
          ? "✓ Done"
          : "✗ Run ended with an error or cancellation";
      if (ev.summary) {
        tail += `\n\n${escapeHtml(ev.summary.slice(0, 2000))}`;
      }
      if (ev.prUrl) {
        tail += `\n\nPR: ${escapeHtml(ev.prUrl)}`;
      }
      tail += `\n\n<code>${escapeHtml(ev.runId)}</code> · <code>${escapeHtml(ev.agentId)}</code>`;
      await api.sendMessage(chatId, tail, { parse_mode: "HTML" });

      const voiceScript = buildVoiceSummary(ev.summary, assistantPlain);
      if (tts && voiceScript) {
        await api.sendChatAction(chatId, "upload_document");
        try {
          const { buffer, filename } = await synthesizeSpeech(voiceScript, tts);
          await api.sendAudio(chatId, new InputFile(buffer, filename), {
            caption: "🔊 TLDR (voice)",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await api.sendMessage(chatId, `Voice TLDR failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
        }
      }
      return;
    }
  }
}

export function createTelegramBot(
  token: string,
  service: AgentService,
  allowedUserIds: number[],
  opts?: { githubToken?: string; tts?: TtsConfig },
): Bot {
  const bot = new Bot(token);
  const githubToken = opts?.githubToken?.trim();
  const tts = opts?.tts;
  const repoPickCache = new Map<number, RepoPickCache>();

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowedUserIds.includes(id)) {
      await ctx.reply("Access denied.");
      return;
    }
    await next();
  });

  const tails = new Map<number, Promise<void>>();

  function enqueue(userId: number, task: () => Promise<void>): void {
    const prev = tails.get(userId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((e) => console.error("[telegram] handler error", e));
    tails.set(userId, next);
  }

  bot.command("start", async (ctx) => {
    const uid = String(ctx.from!.id);
    const st = await service.getStatus(uid);
    await ctx.reply(
      [
        "Text me what you want Cursor Cloud Agent to do.",
        "Voice replies after each Cursor turn if TTS env is set (see README).",
        "",
        "/repo — paste GitHub repo URL",
        "/repos — pick from your GitHub (needs GITHUB_TOKEN)",
        "/repocreate — new repo on your account",
        "/status — session info",
        "/end — stop current agent",
        "",
        `Repo: ${escapeHtml(st.repoUrl ?? "not set")}`,
        `Active: ${st.active ? "yes" : "no"}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("repo", async (ctx) => {
    const uid = String(ctx.from!.id);
    const text = ctx.message?.text;
    if (!text) return;
    const arg = text.trim().split(/\s+/).slice(1).join(" ").trim();
    if (!arg) {
      await ctx.reply("Usage: /repo https://github.com/org/repo");
      return;
    }
    if (!arg.includes("github.com")) {
      await ctx.reply("Send a full GitHub HTTPS URL.");
      return;
    }
    await service.endSession(uid);
    await service.setRepo(uid, arg);
    await ctx.reply(`Repo saved:\n<code>${escapeHtml(arg)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("repos", async (ctx) => {
    if (!githubToken) {
      await ctx.reply("Add GITHUB_TOKEN to .env (GitHub PAT with repo scope) to list repos.");
      return;
    }
    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/);
    let page = 1;
    if (parts.length >= 2 && /^\d+$/.test(parts[1]!)) {
      page = Math.max(1, Number(parts[1]));
    }

    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    try {
      const { repos, hasNext } = await fetchMyRepos(githubToken, { page, perPage: 12 });
      rememberRepos(repoPickCache, ctx.from!.id, repos, page);

      if (repos.length === 0) {
        await ctx.reply("No repos on this page.");
        return;
      }

      const lines = repos.map((r, i) => `${i + 1}. ${r.full_name}`).join("\n");
      const footer = [
        "",
        hasNext ? `Next page: /repos ${page + 1}` : "End of list.",
        "Tap a button to switch repo.",
      ].join("\n");

      const kb = new InlineKeyboard();
      for (let i = 0; i < repos.length; i++) {
        const full = repos[i]!.full_name;
        const label = full.length > 52 ? `${full.slice(0, 49)}…` : full;
        kb.text(label, `rp:${i}`).row();
      }

      await ctx.reply(escapeHtml(`${lines}${footer}`), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    } catch (e) {
      await ctx.reply(
        escapeHtml(e instanceof Error ? e.message : String(e)),
        { parse_mode: "HTML" },
      );
    }
  });

  bot.callbackQuery(/^rp:(\d+)$/, async (ctx) => {
    if (!githubToken) {
      await ctx.answerCallbackQuery({ text: "GitHub not configured." });
      return;
    }
    const uid = String(ctx.from!.id);
    const idx = Number(ctx.match![1]);
    const cache = recallRepos(repoPickCache, ctx.from!.id);
    await ctx.answerCallbackQuery();
    if (!cache?.repos[idx]) {
      await ctx.reply("That picker expired — run /repos again.");
      return;
    }
    const url = cache.repos[idx]!.clone_url;
    await service.endSession(uid);
    await service.setRepo(uid, url);
    await ctx.reply(`Repo saved:\n<code>${escapeHtml(url)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("repocreate", async (ctx) => {
    if (!githubToken) {
      await ctx.reply("Add GITHUB_TOKEN to .env first.");
      return;
    }
    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      await ctx.reply("Usage: /repocreate my-repo-name [public]");
      return;
    }
    let isPublic = false;
    let nameParts = parts;
    if (parts[parts.length - 1]?.toLowerCase() === "public") {
      isPublic = true;
      nameParts = parts.slice(0, -1);
    }
    const name = nameParts.join("-").replace(/\s+/g, "-");
    if (!name) {
      await ctx.reply("Missing repo name.");
      return;
    }

    enqueue(ctx.from!.id, async () => {
      try {
        await ctx.reply(`Creating <code>${escapeHtml(name)}</code>…`, { parse_mode: "HTML" });
        const repo = await createUserRepo(githubToken, name, { privateRepo: !isPublic });
        const uid = String(ctx.from!.id);
        await service.endSession(uid);
        await service.setRepo(uid, repo.clone_url);
        await ctx.reply(
          [
            "Created & selected:",
            `<code>${escapeHtml(repo.clone_url)}</code>`,
            `<code>${escapeHtml(repo.html_url)}</code>`,
          ].join("\n"),
          { parse_mode: "HTML" },
        );
      } catch (e) {
        await ctx.reply(
          escapeHtml(e instanceof Error ? e.message : String(e)),
          { parse_mode: "HTML" },
        );
      }
    });
  });

  bot.command("status", async (ctx) => {
    const uid = String(ctx.from!.id);
    const st = await service.getStatus(uid);
    await ctx.reply(
      [
        `Active: ${st.active ? "yes" : "no"}`,
        `Repo: ${escapeHtml(st.repoUrl ?? "")}`,
        `Agent: ${escapeHtml(st.agentId ?? "—")}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("end", async (ctx) => {
    const uid = String(ctx.from!.id);
    await service.endSession(uid);
    await ctx.reply("Session ended.");
  });

  async function handlePrompt(uid: string, chatId: number, prompt: string): Promise<void> {
    const repoUrl = await service.resolveRepo(uid);
    if (!repoUrl) {
      await bot.api.sendMessage(
        chatId,
        "Pick a GitHub repo first: /repos or /repo https://github.com/org/repo",
      );
      return;
    }
    const st = await service.getStatus(uid);

    const seed = await bot.api.sendMessage(chatId, "Working…");

    const out = st.active
      ? await service.continueSession(uid, prompt)
      : await service.startSession(uid, prompt, { repoUrl });

    await streamAgentEventsToChat(bot.api, chatId, seed.message_id, out.events, { tts });
  }

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const uid = String(ctx.from!.id);
    const chatId = ctx.chat!.id;
    enqueue(ctx.from!.id, async () => {
      await handlePrompt(uid, chatId, text);
    });
  });

  bot.on("message:voice", async (ctx) => {
    const uid = String(ctx.from!.id);
    const chatId = ctx.chat!.id;
    enqueue(ctx.from!.id, async () => {
      const voice = ctx.message.voice;
      const file = await ctx.getFile();
      const path = file.file_path;
      if (!path) {
        await ctx.reply("Could not download voice note.");
        return;
      }
      const url = `https://api.telegram.org/file/bot${ctx.api.token}/${path}`;
      const res = await fetch(url);
      if (!res.ok) {
        await ctx.reply("Voice download failed.");
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = voice.mime_type ?? "audio/ogg";
      let heard: string;
      try {
        heard = await service.transcribeVoice(buf, mime);
      } catch (e) {
        await ctx.reply(
          `Voice failed: ${escapeHtml(e instanceof Error ? e.message : String(e))}`,
          { parse_mode: "HTML" },
        );
        return;
      }
      await ctx.reply(`Heard:\n<i>${escapeHtml(heard)}</i>`, { parse_mode: "HTML" });
      await handlePrompt(uid, chatId, heard);
    });
  });

  return bot;
}
