import express, { Request, Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Langfuse } from "langfuse";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { QueryRequest, HealthResponse } from "./types.js";

// Claude CLI requires certain directories/files under ~/.claude to exist.
// The container uses a tmpfs mount at ~/.claude which starts empty, so we
// create the expected structure at startup.
const claudeDir = join(homedir(), ".claude");
for (const sub of ["debug", "projects"]) {
  const dir = join(claudeDir, sub);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
const settingsFile = join(claudeDir, "remote-settings.json");
if (!existsSync(settingsFile)) {
  writeFileSync(settingsFile, "{}");
}

// Initialize Langfuse if credentials are available (reads from env vars
// LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL automatically)
let langfuse: Langfuse | null = null;
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  langfuse = new Langfuse();
  console.log("[sidecar] Langfuse tracing enabled");
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "3000", 10);

let activeAbort: AbortController | null = null;

app.get("/health", (_req: Request, res: Response) => {
  const response: HealthResponse = { status: "ok" };
  res.json(response);
});

app.post("/query", async (req: Request, res: Response) => {
  const body = req.body as QueryRequest;

  if (!body.message || !body.system_prompt) {
    res.status(400).json({ error: "message and system_prompt are required" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const abortController = new AbortController();
  activeAbort = abortController;

  // Merge per-request env overrides (e.g. fresh proxy tokens) with process env
  const sdkEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) sdkEnv[k] = v;
  }
  if (body.env) {
    Object.assign(sdkEnv, body.env);
  }

  let responseEnded = false;

  // Detect client disconnect
  res.on("close", () => {
    if (!responseEnded) {
      abortController.abort();
    }
  });

  // --- Langfuse tracing setup ---
  // Mirror the backend's session ID handling:
  //   - langfuse_session_id (from frontend for edit/delete) takes priority
  //   - session_id (CLI session from previous turn) as fallback
  const modelName = body.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
  const traceMessage = body.original_message || body.message;
  const traceInput: Record<string, unknown> = {
    message: traceMessage.substring(0, 500),
  };
  if (body.conversation_history && body.conversation_history.length > 0) {
    traceInput.conversation_history = body.conversation_history;
  }
  const trace = langfuse?.trace({
    name: "agent-chat",
    sessionId: body.langfuse_session_id || body.session_id || undefined,
    input: traceInput,
    metadata: { model: modelName, mode: "container" },
  });

  // Per-turn usage tracking from stream events
  let currentGenUsage: { input?: number; output?: number } = {};
  // Accumulated messages for generation input context
  const accumulatedMessages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: body.message },
  ];

  try {
    const sdkQuery = query({
      prompt: body.message,
      options: {
        model: modelName,
        systemPrompt: body.system_prompt,
        allowedTools: ["mcp__duckdb__execute_sql"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 20,
        includePartialMessages: true,
        abortController,
        env: sdkEnv,
        ...(body.mcp_server_url
          ? {
              mcpServers: {
                duckdb: {
                  type: "sse" as const,
                  url: body.mcp_server_url,
                },
              },
            }
          : {}),
        ...(body.session_id ? { resume: body.session_id } : {}),
      },
    });

    console.log(
      `[sidecar] SDK query started model=${modelName}`
    );

    for await (const message of sdkQuery) {
      if (responseEnded) break;
      // Forward each SDK message as an SSE data line
      res.write(`data: ${JSON.stringify(message)}\n\n`);

      // --- Create Langfuse observations from SDK messages ---
      if (!trace) continue;
      const msg = message as Record<string, unknown>;

      if (msg.type === "stream_event") {
        // Capture per-turn token usage from API stream events
        const event = (msg.event as Record<string, unknown>) || {};
        const eventType = event.type as string;
        if (eventType === "message_start") {
          const msgData = (event.message as Record<string, unknown>) || {};
          const usage = (msgData.usage as Record<string, number>) || {};
          currentGenUsage = { input: usage.input_tokens || 0 };
        } else if (eventType === "message_delta") {
          const usage = (event.usage as Record<string, number>) || {};
          currentGenUsage.output = usage.output_tokens || 0;
        }
      } else if (msg.type === "assistant") {
        // Create a generation observation for each assistant turn
        const msgObj = (msg.message as Record<string, unknown>) || {};
        const content = msgObj.content as unknown[];

        const usage =
          currentGenUsage.input !== undefined
            ? {
                input: currentGenUsage.input || 0,
                output: currentGenUsage.output || 0,
                total:
                  (currentGenUsage.input || 0) +
                  (currentGenUsage.output || 0),
                unit: "TOKENS" as const,
              }
            : undefined;

        const gen = trace.generation({
          name: "claude.assistant.turn",
          model: (msgObj.model as string) || modelName,
          input: { messages: accumulatedMessages.slice(-6) },
          output: { content, role: "assistant" },
          usage,
        });
        gen.end();
        currentGenUsage = {};

        // Accumulate for next turn's input context
        accumulatedMessages.push({ role: "assistant", content });
      } else if (msg.type === "user") {
        // Accumulate tool results for next turn's input context
        const msgObj = (msg.message as Record<string, unknown>) || {};
        accumulatedMessages.push({
          role: "user",
          content: msgObj.content,
        });
      } else if (msg.type === "result") {
        // Finalize trace — mirrors backend's finally block:
        //   trace_session_id = langfuse_session_id or actual_session_id
        const actualSessionId = (msg.session_id as string | undefined) || body.session_id;
        const traceSessionId = body.langfuse_session_id || actualSessionId;
        trace.update({
          ...(traceSessionId ? { sessionId: traceSessionId } : {}),
          output: { session_id: actualSessionId },
        });
      } else if (msg.type === "system") {
        // Capture session_id early — only when no langfuse_session_id override
        // (matches backend's propagate_attributes(session_id=langfuse_session_id or session_id))
        const sessionId = msg.session_id as string | undefined;
        if (sessionId && !body.langfuse_session_id) {
          trace.update({ sessionId });
        }
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Don't log abort errors — they are expected on client disconnect
    if (!(err instanceof Error && err.name === "AbortError")) {
      console.error(`[sidecar] SDK error: ${errMsg}`);
      if (!responseEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: "error", message: errMsg })}\n\n`
        );
      }
      if (trace) {
        trace.update({ output: { error: errMsg } });
      }
    }
  } finally {
    activeAbort = null;
    responseEnded = true;
    res.end();
    // Flush Langfuse events before the response is fully closed
    if (langfuse) {
      await langfuse.flushAsync().catch(() => {});
    }
    console.log("[sidecar] SSE stream ended");
  }
});

app.post("/stop", (_req: Request, res: Response) => {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
    res.json({ status: "stopped" });
  } else {
    res.json({ status: "no_active_session" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sidecar agent server listening on port ${PORT}`);
});
