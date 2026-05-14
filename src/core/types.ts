export type AgentEvent =
  | { type: "text"; chunk: string }
  | { type: "tool"; name: string; summary: string }
  | {
      type: "done";
      result: "finished" | "error";
      runId: string;
      agentId: string;
      prUrl?: string;
      summary?: string;
    }
  | { type: "startup_error"; message: string; retryable: boolean };

export type UserRecord = {
  repoUrl: string;
  agentId?: string;
  sessionStartedAt?: string;
};

export type SessionsFile = Record<string, UserRecord>;
