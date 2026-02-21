import express, { Request, Response } from "express";
import { spawn, ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { QueryRequest, HealthResponse } from "./types.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "3000", 10);

let activeProcess: ChildProcess | null = null;

app.get("/health", (_req: Request, res: Response) => {
  const response: HealthResponse = { status: "ok" };
  res.json(response);
});

app.post("/query", (req: Request, res: Response) => {
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

  // Write MCP config to temp file if mcp_server_url provided
  let mcpConfigPath: string | null = null;
  if (body.mcp_server_url) {
    const tmpDir = mkdtempSync(join(tmpdir(), "sidecar-"));
    mcpConfigPath = join(tmpDir, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          duckdb: {
            type: "sse",
            url: body.mcp_server_url,
          },
        },
      })
    );
  }

  const args = [
    "--output-format",
    "stream-json",
    "--model",
    body.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
    "--system-prompt",
    body.system_prompt,
    "--allowedTools",
    "mcp__duckdb__execute_sql",
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "20",
    ...(body.session_id ? ["--resume", body.session_id] : []),
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    "-p",
    body.message,
  ];

  const proc = spawn("claude", args, {
    env: process.env as Record<string, string>,
    stdio: ["pipe", "pipe", "pipe"],
  });

  activeProcess = proc;

  let buffer = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        res.write(`data: ${line}\n\n`);
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    console.error(`[claude stderr] ${chunk.toString()}`);
  });

  proc.on("close", (code) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      res.write(`data: ${buffer}\n\n`);
    }
    activeProcess = null;

    // Clean up MCP config temp file
    if (mcpConfigPath) {
      try {
        unlinkSync(mcpConfigPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (code !== 0) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: "error", message: `Claude CLI exited with code ${code}` })}\n\n`
      );
    }
    res.end();
  });

  proc.on("error", (err) => {
    activeProcess = null;
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", message: err.message })}\n\n`
    );
    res.end();
  });

  // Handle client disconnect
  req.on("close", () => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });
});

app.post("/stop", (_req: Request, res: Response) => {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill("SIGTERM");
    activeProcess = null;
    res.json({ status: "stopped" });
  } else {
    res.json({ status: "no_active_session" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sidecar agent server listening on port ${PORT}`);
});
