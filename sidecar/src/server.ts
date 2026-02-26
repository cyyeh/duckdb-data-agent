import express, { Request, Response } from "express";
import { query, AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { Langfuse } from "langfuse";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { QueryRequest, HealthResponse, AgentDefinitionPayload } from "./types.js";

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

// Per-request abort tracking — avoids a global variable whose cleanup in one
// request's `finally` block can clobber a concurrently-started request.
let nextRequestId = 0;
const activeAborts = new Map<number, AbortController>();

// How long (ms) to wait for the SDK iterator to yield a message before
// aborting.  Resets on every message so active multi-turn queries are not
// interrupted.  Covers cases where the CLI subprocess hangs on startup
// (e.g. broken session resume, unreachable MCP server).
const SDK_IDLE_TIMEOUT_MS = 60_000; // 1 minute

// Timeout (ms) for pre-flight reachability checks against MCP / API URLs.
const PREFLIGHT_TIMEOUT_MS = 10_000; // 10 seconds

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
  const requestId = nextRequestId++;
  activeAborts.set(requestId, abortController);

  // Merge per-request env overrides (e.g. Bifrost gateway URLs) with process env
  const sdkEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) sdkEnv[k] = v;
  }
  if (body.env) {
    Object.assign(sdkEnv, body.env);
  }
  // Scrub Langfuse credentials so the agent subprocess cannot read them from
  // the inherited environment — matches backend subprocess behaviour.
  // The sidecar's own Langfuse client already holds the credentials internally.
  sdkEnv["LANGFUSE_PUBLIC_KEY"] = "";
  sdkEnv["LANGFUSE_SECRET_KEY"] = "";

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
  const modelName = body.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
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

  // Collect stderr from the CLI subprocess for debugging
  const stderrLines: string[] = [];

  // Declared here so `finally` can clear it even if `try` throws early
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    // --- Pre-flight reachability checks ---
    // The CLI subprocess will hang silently if it can't reach the MCP SSE
    // server or the Bifrost LLM gateway.  Test connectivity first so we can
    // fail fast with a useful error message.
    const apiBase = sdkEnv["ANTHROPIC_BASE_URL"] || "";
    console.log(
      `[sidecar] reqId=${requestId} mcp_url=${body.mcp_server_url || "(none)"} api_base=${apiBase} session_id=${body.session_id || "(none)"}`
    );

    if (body.mcp_server_url) {
      try {
        const mcpResp = await fetch(body.mcp_server_url, {
          signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        });
        // SSE endpoints normally return 200 with text/event-stream; any
        // non-error status is fine — we just need to know the host is up.
        mcpResp.body?.cancel(); // don't consume the stream
        console.log(`[sidecar] MCP reachability OK (status=${mcpResp.status})`);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(
          `MCP server unreachable at ${body.mcp_server_url}: ${reason}. ` +
          `Check that BACKEND_BASE_URL is reachable from inside the container.`
        );
      }
    }

    if (apiBase) {
      try {
        // Just a quick TCP-level check — Bifrost will return 4xx without
        // a real API key but that still proves reachability.
        const apiResp = await fetch(`${apiBase}/v1/models`, {
          signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        });
        apiResp.body?.cancel();
        console.log(`[sidecar] Bifrost LLM gateway reachability OK (status=${apiResp.status})`);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Bifrost LLM gateway unreachable at ${apiBase}: ${reason}. ` +
          `Check that BIFROST_BASE_URL is reachable from inside the container.`
        );
      }
    }

    // Convert agents payload from the backend into SDK AgentDefinition objects.
    // The SDK only accepts 'sonnet' | 'opus' | 'haiku' | 'inherit' for model.
    // Arbitrary strings (e.g. "openai/gpt-5.2") are silently rejected, causing
    // the agent to not be registered.  Validate and fall back to "inherit".
    const VALID_AGENT_MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);
    let sdkAgents: Record<string, AgentDefinition> | undefined;
    if (body.agents) {
      sdkAgents = {};
      for (const [name, def] of Object.entries(body.agents)) {
        const model = def.model && VALID_AGENT_MODELS.has(def.model)
          ? (def.model as AgentDefinition["model"])
          : "inherit";
        sdkAgents[name] = {
          description: def.description,
          prompt: def.prompt,
          ...(def.tools ? { tools: def.tools } : {}),
          model,
        };
      }
    }

    const sdkQuery = query({
      prompt: body.message,
      options: {
        model: modelName,
        systemPrompt: body.system_prompt,
        allowedTools: ["Task", "mcp__duckdb__execute_sql"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 20,
        includePartialMessages: true,
        abortController,
        env: sdkEnv,
        stderr: (line: string) => {
          stderrLines.push(line);
          console.error(`[sidecar:cli] ${line}`);
        },
        ...(sdkAgents ? { agents: sdkAgents } : {}),
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
      `[sidecar] SDK query started model=${modelName} reqId=${requestId}`
    );

    // Idle-timeout: abort if no message arrives within SDK_IDLE_TIMEOUT_MS.
    // The timer resets on every message so long-running multi-turn queries
    // that are making progress are not interrupted.
    idleTimer = setTimeout(() => {
      console.error(`[sidecar] SDK idle timeout (${SDK_IDLE_TIMEOUT_MS}ms) reached, aborting reqId=${requestId}`);
      abortController.abort();
    }, SDK_IDLE_TIMEOUT_MS);

    for await (const message of sdkQuery) {
      // Reset idle timer on every message
      if (idleTimer) { clearTimeout(idleTimer); }
      idleTimer = setTimeout(() => {
        console.error(`[sidecar] SDK idle timeout (${SDK_IDLE_TIMEOUT_MS}ms) reached, aborting reqId=${requestId}`);
        abortController.abort();
      }, SDK_IDLE_TIMEOUT_MS);

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
    let errMsg = err instanceof Error ? err.message : String(err);
    // Append CLI stderr for context when the process crashes
    if (stderrLines.length > 0) {
      errMsg += ` | CLI stderr: ${stderrLines.slice(-5).join(" ")}`;
    }
    // Don't log abort errors — they are expected on client disconnect
    if (!(err instanceof Error && err.name === "AbortError")) {
      console.error(`[sidecar] SDK error: ${errMsg}`);
      if (!responseEnded) {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: errMsg })}\n\n`
        );
      }
      if (trace) {
        trace.update({ output: { error: errMsg } });
      }
    }
  } finally {
    if (idleTimer) { clearTimeout(idleTimer); }
    activeAborts.delete(requestId);
    responseEnded = true;
    res.end();
    // Flush Langfuse events before the response is fully closed
    if (langfuse) {
      await langfuse.flushAsync().catch(() => {});
    }
    console.log(`[sidecar] SSE stream ended reqId=${requestId}`);
  }
});

app.post("/stop", (_req: Request, res: Response) => {
  if (activeAborts.size > 0) {
    for (const [id, controller] of activeAborts) {
      controller.abort();
      activeAborts.delete(id);
    }
    res.json({ status: "stopped" });
  } else {
    res.json({ status: "no_active_session" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sidecar agent server listening on port ${PORT}`);
});
