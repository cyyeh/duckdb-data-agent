import express, { Request, Response } from "express";
import { query, AgentDefinition, SettingSource, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { Langfuse } from "langfuse";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
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

// Skills are bind-mounted at the project-level path (/app/.claude/skills/)
// so the CLI subprocess (spawned by the SDK with cwd=/app/) discovers them.
const SKILLS_DIR = join(process.cwd(), ".claude", "skills");

function isSkillDisabled(skillPath: string): boolean {
  try {
    const text = readFileSync(skillPath, "utf-8");
    if (!text.startsWith("---")) return false;
    const end = text.indexOf("---", 3);
    if (end === -1) return false;
    const frontmatter = text.slice(3, end);
    for (const line of frontmatter.split("\n")) {
      if (line.trim().startsWith("disabled:") && line.trim().endsWith("true")) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

function discoverSkills(): Set<string> {
  if (!existsSync(SKILLS_DIR)) return new Set();
  return new Set(
    readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => {
        if (!d.isDirectory()) return false;
        const skillPath = join(SKILLS_DIR, d.name, "SKILL.md");
        return existsSync(skillPath) && !isSkillDisabled(skillPath);
      })
      .map((d) => d.name)
  );
}

// Log initial skills at startup
console.log(`[sidecar] Initial skills: ${[...discoverSkills()].join(", ") || "(none)"}`);

const skillAllowlistHook: HookCallbackMatcher = {
  matcher: "Skill",
  hooks: [
    async (input) => {
      const currentSkills = discoverSkills();
      const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown> | undefined;
      const skillName = toolInput?.skill as string | undefined;
      // Allow plugin-namespaced skills (e.g. "data:sql-queries") — the SDK's
      // plugin system handles their discovery, so we only validate local skills.
      if (skillName && skillName.includes(":")) {
        return {};
      }
      if (skillName && !currentSkills.has(skillName)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Skill "${skillName}" is not in the allowlist.`,
          },
        };
      }
      return {};
    },
  ],
};

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
const SDK_IDLE_TIMEOUT_MS = parseInt(process.env.SDK_IDLE_TIMEOUT_MS || "600000", 10);

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
  const modelName = body.model || process.env.ORCHESTRATOR_MODEL || "claude-sonnet-4-6";
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

    // Append skill restriction so the model doesn't list or suggest
    // built-in skills that the PreToolUse hook would block anyway.
    // The CLI binary injects its own system reminder listing ALL skills
    // (including built-ins like "simplify"), so we must explicitly tell
    // the model to ignore any skills not in our allowlist.
    const currentSkills = discoverSkills();
    const allowedList = [...currentSkills].join(", ");
    const pluginSkillNote = " You may also invoke any plugin-namespaced skills (skills whose name contains ':', such as 'data:sql-queries', 'data:analyze', 'data:write-query', 'data:create-viz', 'data:explore-data', 'data:build-dashboard', 'data:validate', etc.) — these are provided by installed plugins and are always allowed.";
    const skillRestriction = currentSkills.size > 0
      ? `\n\nCRITICAL SKILL RESTRICTION: The ONLY local skills you may invoke with the Skill tool are: ${allowedList}. You may see other skills (like "simplify") listed in system reminders — those are NOT available to you and MUST be ignored. When asked about available skills, list ONLY: ${allowedList} (plus any plugin-namespaced skills). Never mention, suggest, or attempt to invoke any non-plugin skill not in this list.${pluginSkillNote} NOTE: The mcp__duckdb-data-agent__create_skill tool is always available for creating NEW skills — this restriction only applies to invoking existing skills via the Skill tool.`
      : `\n\nCRITICAL SKILL RESTRICTION: You have no local skills available to invoke with the Skill tool. You may see skills listed in system reminders — those are NOT available to you and MUST be ignored. Never mention, suggest, or attempt to invoke any non-plugin skills.${pluginSkillNote} NOTE: The mcp__duckdb-data-agent__create_skill tool is always available for creating NEW skills — this restriction only applies to invoking existing skills via the Skill tool.`;

    const skillInstruction = body.skills?.length
      ? `\n\nIMPORTANT: The user has invoked the following skill(s): ${body.skills.map(s => `"/${s}"`).join(", ")}. You MUST use the Skill tool to invoke each skill (${body.skills.map(s => `"${s}"`).join(", ")}) before doing anything else.`
      : "";

    // Common SDK options (without resume/prompt — those vary on retry)
    const baseOptions = {
      model: modelName,
      systemPrompt: body.system_prompt + skillInstruction + skillRestriction,
      allowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Skill",
        "Task",
        "mcp__duckdb-data-agent__execute_sql",
        "mcp__duckdb-data-agent__ask_user_question",
        "mcp__duckdb-data-agent__render_chart",
        "mcp__duckdb-data-agent__create_skill",
        "mcp__duckdb-data-agent__save_memory",
        "mcp__duckdb-data-agent__recall_memories",
        "mcp__duckdb-data-agent__forget_memory",
      ] as string[],
      settingSources: ["project"] as SettingSource[],
      plugins: [{ type: "local" as const, path: "./plugins/data" }],
      hooks: { PreToolUse: [skillAllowlistHook] },
      permissionMode: "bypassPermissions" as const,
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
              "duckdb-data-agent": {
                type: "sse" as const,
                url: body.mcp_server_url,
              },
            },
          }
        : {}),
    };

    // Resume fallback: try with resume first. If the SDK yields a "result"
    // message with "No conversation found" (container was recreated and lost
    // the session), suppress that error and retry without resume, prepending
    // conversation history so the model has context.
    //
    // When resuming, the SDK reuses the original session's system prompt, so
    // skill changes (additions/deletions) since conversation start won't be
    // reflected.  Prepend an updated skill restriction to the user message so
    // the model always sees the current set of available skills.
    let useResume = !!body.session_id;
    let currentPrompt = useResume
      ? `${skillRestriction}\n\n${body.message}`
      : body.message;
    let retried = false;

    queryLoop: for (let attempt = 0; attempt < 2; attempt++) {
      const sdkQuery = query({
        prompt: currentPrompt,
        options: {
          ...baseOptions,
          ...(useResume ? { resume: body.session_id } : {}),
        },
      });

      console.log(
        `[sidecar] SDK query started model=${modelName} reqId=${requestId} attempt=${attempt} resume=${useResume}`
      );

      idleTimer = setTimeout(() => {
        console.error(`[sidecar] SDK idle timeout (${SDK_IDLE_TIMEOUT_MS}ms) reached, aborting reqId=${requestId}`);
        abortController.abort();
      }, SDK_IDLE_TIMEOUT_MS);

      let resumeFailedNeedsRetry = false;

      try {
        for await (const message of sdkQuery) {
          // Reset idle timer on every message
          if (idleTimer) { clearTimeout(idleTimer); }
          idleTimer = setTimeout(() => {
            console.error(`[sidecar] SDK idle timeout (${SDK_IDLE_TIMEOUT_MS}ms) reached, aborting reqId=${requestId}`);
            abortController.abort();
          }, SDK_IDLE_TIMEOUT_MS);

          if (responseEnded) break queryLoop;

          // Intercept "No conversation found" result before forwarding
          if (useResume && !retried) {
            const msg = message as Record<string, unknown>;
            if (msg.type === "result" && msg.is_error) {
              const resultText = String(msg.result || "");
              const errors = ((msg.errors as string[]) || []).join(" ");
              if ((resultText + " " + errors).includes("No conversation found")
                  && body.conversation_history && body.conversation_history.length > 0) {
                console.log(`[sidecar] Resume failed ("No conversation found"), will retry with history reqId=${requestId}`);
                resumeFailedNeedsRetry = true;
                break; // Don't forward this error to the client
              }
            }
          }

          // Forward each SDK message as an SSE data line
          res.write(`data: ${JSON.stringify(message)}\n\n`);

          // --- Create Langfuse observations from SDK messages ---
          if (!trace) continue;
          const msg = message as Record<string, unknown>;

          if (msg.type === "stream_event") {
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
            const msgObj = (msg.message as Record<string, unknown>) || {};
            const content = msgObj.content as unknown[];
            const usage =
              currentGenUsage.input !== undefined
                ? {
                    input: currentGenUsage.input || 0,
                    output: currentGenUsage.output || 0,
                    total: (currentGenUsage.input || 0) + (currentGenUsage.output || 0),
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
            accumulatedMessages.push({ role: "assistant", content });
          } else if (msg.type === "user") {
            const msgObj = (msg.message as Record<string, unknown>) || {};
            accumulatedMessages.push({ role: "user", content: msgObj.content });
          } else if (msg.type === "result") {
            const actualSessionId = (msg.session_id as string | undefined) || body.session_id;
            const traceSessionId = body.langfuse_session_id || actualSessionId;
            trace.update({
              ...(traceSessionId ? { sessionId: traceSessionId } : {}),
              output: { session_id: actualSessionId },
            });
          } else if (msg.type === "system") {
            const sessionId = msg.session_id as string | undefined;
            if (sessionId && !body.langfuse_session_id) {
              trace.update({ sessionId });
            }
          }
        } // end for-await
      } catch (innerErr: unknown) {
        // If we're retrying due to resume failure, swallow the cleanup error
        // (e.g., "Claude Code process exited with code 1" after session not found)
        if (resumeFailedNeedsRetry) {
          console.log(`[sidecar] Swallowing post-resume error during retry: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
        } else {
          throw innerErr;
        }
      }

      if (resumeFailedNeedsRetry && !retried) {
        retried = true;
        useResume = false;
        let messageWithHistory = "Previous conversation (for context):\n";
        for (const entry of body.conversation_history!) {
          const role = (entry.role || "user").charAt(0).toUpperCase() + (entry.role || "user").slice(1);
          messageWithHistory += `\n${role}: ${entry.content}\n`;
        }
        messageWithHistory += `\n---\n\nMy new message:\n${body.message}`;
        currentPrompt = messageWithHistory;
        stderrLines.length = 0;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        continue; // retry the queryLoop
      }

      break; // success or non-retryable error — exit queryLoop
    } // end queryLoop
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
