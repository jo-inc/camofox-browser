// camofox-browser DSH (DeepSeek Harness) host adapter
//
// Exposes the camofox-browser REST API as native DSH tools. Like the MCP server
// (mcp/server.mjs), this is a thin client over the REST server: it does not
// launch the browser, and it does not require camoufox-js, playwright-core, or
// the ~500MB engine download.
//
// Tool names, JSON-Schema parameters, REST routes, request bodies, auth, and
// response shaping come from the SAME canonical module the MCP server and the
// OpenClaw plugin use (mcp/lib/tool-contracts.mjs), so all three hosts emit
// identical traffic. Adding a host does not fork the contract.
//
// DSH differs from MCP in exactly two ways, and both are handled here:
//   1. DSH asks a plugin to *register* tools (ctx.inject(["tools"], ...)) rather
//      than answering a ListTools request.
//   2. DSH wants each tool to declare how its return value becomes content
//      blocks (output.render), so adaptResponse() is wired in as the renderer.
//
// Auth (mirrors mcp/server.mjs and lib/auth.js):
//   - CAMOFOX_ACCESS_KEY (global): forwarded as `Authorization: Bearer` on every
//     request, for REST servers exposed beyond loopback.
//   - CAMOFOX_API_KEY (cookie import only): forwarded on the cookie-import route.
//
// See dsh/README.md for install steps.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { TOOL_DEFS, runTool, adaptResponse } from "../mcp/lib/tool-contracts.mjs";

const DEFAULT_PORT = 9377;

/**
 * Host configuration. Kept deliberately close to loadMcpConfig() so that a user
 * who has already configured the MCP server sees the same env vars work here.
 */
function loadConfig() {
  const port = Number.parseInt(process.env.CAMOFOX_PORT || process.env.PORT || "", 10);
  const cookiesDir =
    process.env.CAMOFOX_COOKIES_DIR || join(homedir(), ".camofox", "cookies");
  return {
    port: Number.isNaN(port) ? DEFAULT_PORT : port,
    baseUrl: process.env.CAMOFOX_BASE_URL || `http://localhost:${Number.isNaN(port) ? DEFAULT_PORT : port}`,
    accessKey: process.env.CAMOFOX_ACCESS_KEY || "",
    apiKey: process.env.CAMOFOX_API_KEY || "",
    cookiesDir,
  };
}

/**
 * Per-host userId so one DSH install does not share a cookie/storage partition
 * with an MCP client pointed at the same REST server. Falls back to a random id,
 * matching mcp/server.mjs.
 */
const USER_ID = process.env.CAMOFOX_USER_ID || `dsh-${randomUUID()}`;
const SESSION_KEY = process.env.CAMOFOX_SESSION_KEY || "default";

/**
 * Turn one canonical tool definition into a DSH tool.
 *
 * The whole body is a call to runTool(); everything host-specific (how to route
 * `userId`, how a response becomes blocks) is pushed into the contract module so
 * this file cannot drift from the MCP server.
 */
function makeTool(def, config, callContext, requestTimeoutMs) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.inputSchema,

    output: {
      // Loose on purpose: blocks carry text, or an image block whose `data` is a
      // multi-megabyte base64 PNG. Describing that shape tightly would make DSH
      // validate/duplicate large payloads on every call for no benefit.
      schema: {
        type: "object",
        properties: { blocks: { type: "array", items: { type: "object" } } },
        required: ["blocks"],
        additionalProperties: false,
      },
      render(_args, value) {
        return (value && value.blocks) || [{ type: "text", text: "(empty response)" }];
      },
    },

    async execute(args, exec) {
      const signal =
        exec && exec.signal
          ? AbortSignal.any([exec.signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs);
      try {
        const { spec, payload } = await runTool(
          def.name,
          args || {},
          callContext,
          config.baseUrl,
          { apiKey: config.apiKey, accessKey: config.accessKey, cookiesDir: config.cookiesDir },
          signal
        );
        return { blocks: adaptResponse(spec, payload) };
      } catch (error) {
        // The most common failure by far is "REST server is not running", and
        // fetch reports that as an opaque "fetch failed". Say the useful thing.
        const message = String((error && error.message) || error);
        if (/fetch failed|ECONNREFUSED|aborted/i.test(message)) {
          throw new Error(
            `camofox REST server is not reachable at ${config.baseUrl}.\n` +
              "Start it first:  cd camofox-browser && npm start\n" +
              `(original error: ${message})`
          );
        }
        throw error;
      }
    },
  };
}

/**
 * DSH plugin entry point. DSH calls this once with the host context; tools
 * registered here are disposed automatically with the plugin.
 */
export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  const resolved = { ...loadConfig(), ...cfg };
  const userId = cfg.userId || USER_ID;
  const sessionKey = cfg.sessionKey || SESSION_KEY;
  const requestTimeoutMs = Number(cfg.requestTimeoutMs) || 90000;

  ctx.inject(["tools"], (scoped) => {
    const disposers = [];
    for (const def of TOOL_DEFS) {
      const dispose = scoped.tools.register(
        makeTool(def, resolved, { userId, sessionKey }, requestTimeoutMs)
      );
      if (typeof dispose === "function") disposers.push(dispose);
    }
    ctx.on("dispose", () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    });
  });
}

export { loadConfig, makeTool, TOOL_DEFS };
