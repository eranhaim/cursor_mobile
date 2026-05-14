import type { Run } from "@cursor/sdk";
import { CursorAgentError } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";
import type { AgentEvent } from "./types";

function summarizeToolInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  } catch {
    return String(input);
  }
}

function* mapSdkMessage(msg: SDKMessage): Generator<AgentEvent> {
  switch (msg.type) {
    case "assistant": {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text", chunk: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool",
            name: block.name,
            summary: summarizeToolInput(block.input),
          };
        }
      }
      break;
    }
    case "tool_call":
      yield {
        type: "tool",
        name: msg.name,
        summary: summarizeToolInput(msg.args),
      };
      break;
    default:
      break;
  }
}

export async function* streamRun(run: Run): AsyncGenerator<AgentEvent> {
  try {
    if (run.supports("stream")) {
      for await (const msg of run.stream()) {
        yield* mapSdkMessage(msg);
      }
    }
    const result = await run.wait();
    const prUrl = result.git?.branches?.find((b) => b.prUrl)?.prUrl;
    const terminal: "finished" | "error" =
      result.status === "finished" ? "finished" : "error";
    yield {
      type: "done",
      result: terminal,
      runId: result.id,
      agentId: run.agentId,
      prUrl,
      summary: result.result,
    };
  } catch (e) {
    if (e instanceof CursorAgentError) {
      yield {
        type: "startup_error",
        message: e.message,
        retryable: e.isRetryable,
      };
      return;
    }
    throw e;
  }
}
