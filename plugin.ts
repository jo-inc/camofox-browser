/**
 * Camoufox Browser - OpenClaw Plugin
 *
 * Provides browser automation tools using the Camoufox anti-detection browser.
 * Server auto-starts when plugin loads (configurable via autoStart: false).
 */

import type { ChildProcess } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { loadConfig } from "./lib/config.js";
import { launchServer } from "./lib/launcher.js";
import { readCookieFile } from "./lib/cookies.js";

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
  content: Array<{ type: string; text: string }>;
}

interface HealthCheckResult {
  status: "ok" | "warn" | "error";
  message?: string;
  details?: Record<string, unknown>;
}

interface CliContext {
  program: {
    command: (name: string) => {
      description: (desc: string) => CliContext["program"];
      option: (flags: string, desc: string, defaultValue?: string) => CliContext["program"];
      argument: (name: string, desc: string) => CliContext["program"];
      action: (handler: (...args: unknown[]) => void | Promise<void>) => CliContext["program"];
      command: (name: string) => CliContext["program"];
    };
  };
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
    options?: { optional?: boolean }
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
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function toToolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
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

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_create_tab",
    description:
      "PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use camofox tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to navigate to" },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const sessionKey = ctx.sessionKey || "default";
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, "/tabs", {
        method: "POST",
        body: JSON.stringify({ ...params, userId, sessionKey }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_snapshot",
    description:
      "Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction. Use with camofox_create_tab.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/snapshot?userId=${userId}`);
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_click",
    description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e1)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/click`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_type",
    description: "Type text into an element in a Camoufox tab.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e2)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["tabId", "text"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/type`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_navigate",
    description:
      "Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        url: { type: "string", description: "URL to navigate to" },
        macro: {
          type: "string",
          description: "Search macro (e.g., @google_search, @youtube_search)",
          enum: [
            "@google_search",
            "@youtube_search",
            "@amazon_search",
            "@reddit_search",
            "@wikipedia_search",
            "@twitter_search",
            "@yelp_search",
            "@spotify_search",
            "@netflix_search",
            "@linkedin_search",
            "@instagram_search",
            "@tiktok_search",
            "@twitch_search",
          ],
        },
        query: { type: "string", description: "Search query (when using macro)" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/navigate`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_scroll",
    description: "Scroll a Camoufox page.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
      },
      required: ["tabId", "direction"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/scroll`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const url = `${baseUrl}/tabs/${tabId}/screenshot?userId=${userId}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_close_tab",
    description: "Close a Camoufox browser tab.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}?userId=${userId}`, {
        method: "DELETE",
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_list_tabs",
    description: "List all open Camoufox tabs for a user.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_id, _params) {
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs?userId=${userId}`);
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_import_cookies",
    description:
      "Import cookies into the current Camoufox user session (Netscape cookie file). Use to authenticate to sites like LinkedIn without interactive login.",
    parameters: {
      type: "object",
      properties: {
        cookiesPath: { type: "string", description: "Path to Netscape-format cookies.txt file" },
        domainSuffix: {
          type: "string",
          description: "Only import cookies whose domain ends with this suffix",
        },
      },
      required: ["cookiesPath"],
    },
    async execute(_id, params) {
      const { cookiesPath, domainSuffix } = params as {
        cookiesPath: string;
        domainSuffix?: string;
      };

      const userId = ctx.agentId || fallbackUserId;

      const envCfg = loadConfig();
      const cookiesDir = resolve(envCfg.cookiesDir);

      const pwCookies = await readCookieFile({
        cookiesDir,
        cookiesPath,
        domainSuffix,
      });

      if (!envCfg.apiKey) {
        throw new Error(
          "CAMOFOX_API_KEY is not set. Cookie import is disabled unless you set CAMOFOX_API_KEY for both the server and the OpenClaw plugin environment."
        );
      }

      const result = await fetchApi(baseUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${envCfg.apiKey}`,
        },
        body: JSON.stringify({ cookies: pwCookies }),
      });

      return toToolResult({ imported: pwCookies.length, userId, result });
    },
  }));

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
        const health = await fetchApi(baseUrl, "/health");
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
