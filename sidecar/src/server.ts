import express, { Request, Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
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

  try {
    const sdkQuery = query({
      prompt: body.message,
      options: {
        model: body.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
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
      `[sidecar] SDK query started model=${body.model || "default"}`
    );

    for await (const message of sdkQuery) {
      if (responseEnded) break;
      // Forward each SDK message as an SSE data line
      res.write(`data: ${JSON.stringify(message)}\n\n`);
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
    }
  } finally {
    activeAbort = null;
    responseEnded = true;
    res.end();
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
