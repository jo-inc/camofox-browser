/**
 * Camoufox Browser - OpenClaw Plugin
 *
 * Provides browser automation tools using the Camoufox anti-detection browser.
 * Server auto-starts when plugin loads (configurable via autoStart: false).
 */

import type { ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { loadConfig } from "./lib/config.js";
import { launchServer } from "./lib/launcher.js";
// Shared tool contracts — the single source of truth also used by mcp/server.mjs.
// OpenClaw and MCP expose identical tool schemas, REST routes, auth, and response
// shaping, so they cannot drift.
import { TOOL_DEFS, runTool, adaptResponse } from "./lib/mcp-tool-contracts.mjs";

// Get plugin directory - works in both ESM and CJS contexts
const getPluginDir = (): string => {
  try {
    // ESM context
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS context
    return __dirname;
  }
};

interface PluginConfig {
  url?: string;
  autoStart?: boolean;
  port?: number;
  maxSessions?: number;
  maxTabsPerSession?: number;
  sessionTimeoutMs?: number;
  browserIdleTimeoutMs?: number;
  maxOldSpaceSize?: number;
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

interface HealthCheckResult {
  status: "ok" | "warn" | "error";
  message?: string;
  details?: Record<string, unknown>;
}

interface CliCommand {
  description: (desc: string) => CliCommand;
  option: (flags: string, desc: string, defaultValue?: string) => CliCommand;
  argument: (name: string, desc: string) => CliCommand;
  action: (handler: (...args: unknown[]) => void | Promise<void>) => CliCommand;
  command: (name: string) => CliCommand;
}

interface CliContext {
  program: CliCommand;
  config: PluginConfig;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface ToolContext {
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
}

type ToolDefinition = {
  name: string;
  description: string;
  parameters: object;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

type ToolFactory = (ctx: ToolContext) => ToolDefinition | ToolDefinition[] | null | undefined;

interface PluginApi {
  registerTool: (
    tool: ToolDefinition | ToolFactory,
    options?: { name?: string; names?: string[]; optional?: boolean }
  ) => void;
  registerCommand: (cmd: {
    name: string;
    description: string;
    handler: (args: string[]) => Promise<void>;
  }) => void;
  registerCli?: (
    registrar: (ctx: CliContext) => void | Promise<void>,
    opts?: { commands?: string[] }
  ) => void;
  registerRpc?: (
    name: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ) => void;
  registerHealthCheck?: (
    name: string,
    check: () => Promise<HealthCheckResult>
  ) => void;
  config: Record<string, unknown>;
  pluginConfig?: PluginConfig;
  log: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

let serverProcess: ChildProcess | null = null;

async function startServer(
  pluginDir: string,
  port: number,
  log: PluginApi["log"],
  pluginCfg?: PluginConfig
): Promise<ChildProcess> {
  const cfg = loadConfig();
  const env: Record<string, string> = { ...cfg.serverEnv };
  if (pluginCfg?.maxSessions != null) env.MAX_SESSIONS = String(pluginCfg.maxSessions);
  if (pluginCfg?.maxTabsPerSession != null) env.MAX_TABS_PER_SESSION = String(pluginCfg.maxTabsPerSession);
  if (pluginCfg?.sessionTimeoutMs != null) env.SESSION_TIMEOUT_MS = String(pluginCfg.sessionTimeoutMs);
  if (pluginCfg?.browserIdleTimeoutMs != null) env.BROWSER_IDLE_TIMEOUT_MS = String(pluginCfg.browserIdleTimeoutMs);
  const proc = launchServer({ pluginDir, port, env, log, nodeArgs: pluginCfg?.maxOldSpaceSize != null ? [`--max-old-space-size=${pluginCfg.maxOldSpaceSize}`] : undefined });

  proc.on("error", (err: Error) => {
    log?.error?.(`Server process error: ${err.message}`);
    serverProcess = null;
  });

  proc.on("exit", (code: number | null) => {
    if (code !== 0 && code !== null) {
      log?.error?.(`Server exited with code ${code}`);
    }
    serverProcess = null;
  });

  // Wait for server to be ready
  const baseUrl = `http://localhost:${port}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        log.info(`Camoufox server ready on port ${port}`);
        return proc;
      }
    } catch {
      // Server not ready yet
    }
  }
  proc.kill();
  throw new Error("Server failed to start within 15 seconds");
}

async function checkServerRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchApi(
  baseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  // Forward the global access key so plugin traffic is accepted by REST servers
  // gated with CAMOFOX_ACCESS_KEY. /health is exempt server-side, so attaching
  // the header to health checks is harmless.
  const cfg = loadConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (cfg.accessKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${cfg.accessKey}`;
  }
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export default function register(api: PluginApi) {
  const cfg = api.pluginConfig ?? (api.config as unknown as PluginConfig);
  const port = cfg.port || 9377;
  const baseUrl = cfg.url || `http://localhost:${port}`;
  const autoStart = cfg.autoStart !== false; // default true
  const pluginDir = getPluginDir();
  const fallbackUserId = `camofox-${randomUUID()}`;

  // Auto-start server if configured (default: true)
  if (autoStart) {
    (async () => {
      const alreadyRunning = await checkServerRunning(baseUrl);
      if (alreadyRunning) {
        api.log?.info?.(`Camoufox server already running at ${baseUrl}`);
      } else {
        try {
          serverProcess = await startServer(pluginDir, port, api.log, cfg);
        } catch (err) {
          api.log?.error?.(`Failed to auto-start server: ${(err as Error).message}`);
        }
      }
    })();
  }

  // --- Tool registration -----------------------------------------------------
  // Schemas, REST routes, auth, and response shaping come from the shared
  // contract module (lib/mcp-tool-contracts.mjs) — the same source mcp/server.mjs
  // imports — so the OpenClaw plugin and the MCP server behave identically and
  // cannot drift. Only the userId/sessionKey source (OpenClaw ctx) differs.
  for (const def of TOOL_DEFS) {
    api.registerTool((ctx: ToolContext) => ({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
      async execute(_id, params) {
        const userId = ctx.agentId || fallbackUserId;
        const cfg = loadConfig();
        const { spec, payload } = await runTool(
          def.name,
          params as Record<string, unknown>,
          { userId, sessionKey: ctx.sessionKey },
          baseUrl,
          cfg
        );
        return { content: adaptResponse(spec, payload) };
      },
    }), { name: def.name });
  }


  api.registerCommand({
    name: "camofox",
    description: "Camoufox browser server control (status, start, stop)",
    handler: async (args) => {
      const subcommand = args[0] || "status";
      switch (subcommand) {
        case "status":
          try {
            const health = await fetchApi(baseUrl, "/health");
            api.log?.info?.(`Camoufox server at ${baseUrl}: ${JSON.stringify(health)}`);
          } catch {
            api.log?.error?.(`Camoufox server at ${baseUrl}: not reachable`);
          }
          break;
        case "start":
          if (serverProcess) {
            api.log?.info?.("Camoufox server already running (managed)");
            return;
          }
          if (await checkServerRunning(baseUrl)) {
            api.log?.info?.(`Camoufox server already running at ${baseUrl}`);
            return;
          }
          try {
            serverProcess = await startServer(pluginDir, port, api.log, cfg);
          } catch (err) {
            api.log?.error?.(`Failed to start server: ${(err as Error).message}`);
          }
          break;
        case "stop":
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
            api.log?.info?.("Stopped camofox-browser server");
          } else {
            api.log?.info?.("No managed server process running");
          }
          break;
        default:
          api.log?.error?.(`Unknown subcommand: ${subcommand}. Use: status, start, stop`);
      }
    },
  });

  // Register health check for openclaw doctor/status
  if (api.registerHealthCheck) {
    api.registerHealthCheck("camofox-browser", async () => {
      try {
        const health = (await fetchApi(baseUrl, "/health")) as {
          status: string;
          engine?: string;
          activeTabs?: number;
        };
        return {
          status: "ok",
          message: `Server running (${health.engine || "camoufox"})`,
          details: {
            url: baseUrl,
            engine: health.engine,
            activeTabs: health.activeTabs,
            managed: serverProcess !== null,
          },
        };
      } catch {
        return {
          status: serverProcess ? "warn" : "error",
          message: serverProcess
            ? "Server starting..."
            : `Server not reachable at ${baseUrl}`,
          details: {
            url: baseUrl,
            managed: serverProcess !== null,
            hint: "Run: openclaw camofox start",
          },
        };
      }
    });
  }

  // Register RPC methods for gateway integration
  if (api.registerRpc) {
    api.registerRpc("camofox.health", async () => {
      try {
        const health = (await fetchApi(baseUrl, "/health")) as Record<string, unknown>;
        return { status: "ok", ...health };
      } catch (err) {
        return { status: "error", error: (err as Error).message };
      }
    });

    api.registerRpc("camofox.status", async () => {
      const running = await checkServerRunning(baseUrl);
      return {
        running,
        managed: serverProcess !== null,
        pid: serverProcess?.pid || null,
        url: baseUrl,
        port,
      };
    });
  }

  // Register CLI subcommands (openclaw camofox ...)
  if (api.registerCli) {
    api.registerCli(
      ({ program }) => {
        const camofox = program
          .command("camofox")
          .description("Camoufox anti-detection browser automation");

        camofox
          .command("status")
          .description("Show server status")
          .action(async () => {
            try {
              const health = (await fetchApi(baseUrl, "/health")) as {
                status: string;
                engine?: string;
                activeTabs?: number;
              };
              console.log(`Camoufox server: ${health.status}`);
              console.log(`  URL: ${baseUrl}`);
              console.log(`  Engine: ${health.engine || "camoufox"}`);
              console.log(`  Active tabs: ${health.activeTabs ?? 0}`);
              console.log(`  Managed: ${serverProcess !== null}`);
            } catch {
              console.log(`Camoufox server: not reachable`);
              console.log(`  URL: ${baseUrl}`);
              console.log(`  Managed: ${serverProcess !== null}`);
              console.log(`  Hint: Run 'openclaw camofox start' to start the server`);
            }
          });

        camofox
          .command("start")
          .description("Start the camofox server")
          .action(async () => {
            if (serverProcess) {
              console.log("Camoufox server already running (managed by plugin)");
              return;
            }
            if (await checkServerRunning(baseUrl)) {
              console.log(`Camoufox server already running at ${baseUrl}`);
              return;
            }
            try {
              console.log(`Starting camofox server on port ${port}...`);
              serverProcess = await startServer(pluginDir, port, api.log, cfg);
              console.log(`Camoufox server started at ${baseUrl}`);
            } catch (err) {
              console.error(`Failed to start server: ${(err as Error).message}`);
              process.exit(1);
            }
          });

        camofox
          .command("stop")
          .description("Stop the camofox server")
          .action(async () => {
            if (serverProcess) {
              serverProcess.kill();
              serverProcess = null;
              console.log("Stopped camofox server");
            } else {
              console.log("No managed server process running");
            }
          });

        camofox
          .command("configure")
          .description("Configure camofox plugin settings")
          .action(async () => {
            console.log("Camoufox Browser Configuration");
            console.log("================================");
            console.log("");
            console.log("Current settings:");
            console.log(`  Server URL: ${baseUrl}`);
            console.log(`  Port: ${port}`);
            console.log(`  Auto-start: ${autoStart}`);
            console.log("");
            console.log("Plugin config (openclaw.json):");
            console.log("");
            console.log("  plugins:");
            console.log("    entries:");
            console.log("      camofox-browser:");
            console.log("        enabled: true");
            console.log("        config:");
            console.log("          port: 9377");
            console.log("          autoStart: true");
            console.log("");
            console.log("To use camofox as the ONLY browser tool, disable the built-in:");
            console.log("");
            console.log("  tools:");
            console.log('    deny: ["browser"]');
            console.log("");
            console.log("This removes OpenClaw's built-in browser tool, leaving camofox tools.");
          });

        camofox
          .command("tabs")
          .description("List active browser tabs")
          .option("--user <userId>", "Filter by user ID")
          .action(async (opts: { user?: string }) => {
            try {
              const endpoint = opts.user ? `/tabs?userId=${opts.user}` : "/tabs";
              const tabs = (await fetchApi(baseUrl, endpoint)) as Array<{
                tabId: string;
                userId: string;
                url: string;
                title: string;
              }>;
              if (tabs.length === 0) {
                console.log("No active tabs");
                return;
              }
              console.log(`Active tabs (${tabs.length}):`);
              for (const tab of tabs) {
                console.log(`  ${tab.tabId} [${tab.userId}] ${tab.title || tab.url}`);
              }
            } catch (err) {
              console.error(`Failed to list tabs: ${(err as Error).message}`);
            }
          });
      },
      { commands: ["camofox"] }
    );
  }
}
