import { Agent, CursorAgentError, type SDKAgent } from "@cursor/sdk";
import { streamRun } from "./cursor";
import { SessionsStore } from "./sessions";
import { transcribeVoice as whisperTranscribe } from "./transcribe";
import type { AgentEvent } from "./types";

export type AgentServiceConfig = {
  cursorApiKey: string;
  openAiApiKey?: string;
  /** Fallback when user has not chosen a repo; may be empty if you rely on /repos only. */
  defaultRepoUrl: string;
  dataDir: string;
};

type LiveSession = {
  agent: SDKAgent;
  repoUrl: string;
};

async function* startupError(
  message: string,
  retryable: boolean,
): AsyncGenerator<AgentEvent> {
  yield { type: "startup_error", message, retryable };
}

export function createAgentService(config: AgentServiceConfig) {
  const store = new SessionsStore(config.dataDir);
  const live = new Map<string, LiveSession>();
  const apiKey = config.cursorApiKey;

  async function hydrate(): Promise<void> {
    const all = await store.loadAll();
    for (const [userId, rec] of Object.entries(all)) {
      if (!rec.agentId) continue;
      try {
        const agent = await Agent.resume(rec.agentId, {
          apiKey,
          cloud: {
            repos: [{ url: rec.repoUrl }],
            autoCreatePR: true,
            skipReviewerRequest: true,
          },
        });
        live.set(userId, { agent, repoUrl: rec.repoUrl });
      } catch (e) {
        console.error(`[sessions] resume failed for ${userId}`, e);
        await store.clearAgent(userId);
      }
    }
  }

  return {
    hydrate,

    async transcribeVoice(audio: Buffer, mimeType: string): Promise<string> {
      const key = config.openAiApiKey;
      if (!key) {
        throw new Error("OPENAI_API_KEY is not set (needed for voice)");
      }
      return whisperTranscribe(key, audio, mimeType);
    },

    async getStatus(userId: string): Promise<{
      active: boolean;
      repoUrl?: string;
      agentId?: string;
    }> {
      const l = live.get(userId);
      const rec = await store.get(userId);
      return {
        active: !!l,
        repoUrl: rec?.repoUrl ?? config.defaultRepoUrl,
        agentId: l?.agent.agentId ?? rec?.agentId,
      };
    },

    async setRepo(userId: string, repoUrl: string): Promise<void> {
      await store.setRepo(userId, repoUrl);
    },

    async endSession(userId: string): Promise<void> {
      const l = live.get(userId);
      if (l) {
        try {
          await l.agent[Symbol.asyncDispose]();
        } catch (e) {
          console.error("[sessions] dispose failed", e);
        }
        live.delete(userId);
      }
      await store.clearAgent(userId);
    },

    async startSession(
      userId: string,
      prompt: string,
      opts: { repoUrl: string },
    ): Promise<{
      sessionId: string;
      agentId: string;
      runId: string;
      events: AsyncIterable<AgentEvent>;
    }> {
      const existing = live.get(userId);
      if (existing) {
        try {
          await existing.agent[Symbol.asyncDispose]();
        } catch (e) {
          console.error("[sessions] dispose before restart", e);
        }
        live.delete(userId);
        await store.clearAgent(userId);
      }

      let agent: SDKAgent;
      try {
        agent = await Agent.create({
          apiKey,
          cloud: {
            repos: [{ url: opts.repoUrl }],
            autoCreatePR: true,
            skipReviewerRequest: true,
          },
        });
      } catch (e) {
        if (e instanceof CursorAgentError) {
          return {
            sessionId: userId,
            agentId: "none",
            runId: "none",
            events: startupError(e.message, e.isRetryable),
          };
        }
        throw e;
      }

      await store.setAgent(userId, agent.agentId, opts.repoUrl);
      live.set(userId, { agent, repoUrl: opts.repoUrl });

      let run;
      try {
        run = await agent.send(prompt);
      } catch (e) {
        if (e instanceof CursorAgentError) {
          await store.clearAgent(userId);
          live.delete(userId);
          try {
            await agent[Symbol.asyncDispose]();
          } catch {
            /* ignore */
          }
          return {
            sessionId: userId,
            agentId: agent.agentId,
            runId: "none",
            events: startupError(e.message, e.isRetryable),
          };
        }
        throw e;
      }

      console.log(`[cursor] run=${run.id} agent=${agent.agentId}`);
      return {
        sessionId: userId,
        agentId: agent.agentId,
        runId: run.id,
        events: streamRun(run),
      };
    },

    async continueSession(
      userId: string,
      prompt: string,
    ): Promise<{ runId: string; events: AsyncIterable<AgentEvent> }> {
      const session = live.get(userId);
      if (!session) {
        return {
          runId: "none",
          events: startupError(
            "No active session — send a message to start, or use /repo first.",
            false,
          ),
        };
      }

      let run;
      try {
        run = await session.agent.send(prompt);
      } catch (e) {
        if (e instanceof CursorAgentError) {
          return {
            runId: "none",
            events: startupError(e.message, e.isRetryable),
          };
        }
        throw e;
      }

      console.log(`[cursor] run=${run.id} agent=${session.agent.agentId}`);
      return { runId: run.id, events: streamRun(run) };
    },

    async resolveRepo(userId: string): Promise<string> {
      const rec = await store.get(userId);
      if (rec?.repoUrl?.trim()) return rec.repoUrl.trim();
      return config.defaultRepoUrl.trim();
    },

    async shutdown(): Promise<void> {
      for (const [uid, { agent }] of live) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch (e) {
          console.error(`[shutdown] dispose ${uid}`, e);
        }
        await store.clearAgent(uid);
      }
      live.clear();
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
