#!/usr/bin/env node
// Self-contained smoke test for mcp/server.mjs — no Jest, no REST server.
// Verifies: handshake completes, all 11 tools are listed with valid schemas,
// and an unknown tool call returns isError. Tool *execution* (which needs the
// camofox REST server) is out of scope here.
//
// Run: node scripts/test-mcp.mjs   (or `npm run test:mcp`)
// Exits non-zero on any failure.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SERVER = resolve(ROOT, "mcp", "server.mjs");

const EXPECTED_TOOLS = [
  "camofox_create_tab",
  "camofox_snapshot",
  "camofox_click",
  "camofox_type",
  "camofox_navigate",
  "camofox_scroll",
  "camofox_screenshot",
  "camofox_close_tab",
  "camofox_evaluate",
  "camofox_list_tabs",
  "camofox_import_cookies",
];

const proc = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  // Whitelist only what the server needs (CONTRIBUTING.md: never spread process.env).
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    NODE_OPTIONS: process.env.NODE_OPTIONS || "",
    CAMOFOX_BASE_URL: "http://localhost:1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let buf = "";
let failures = 0;
let stderr = "";

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg);
      }
    } catch {
      /* ignore non-JSON */
    }
  }
});
proc.stderr.on("data", (c) => {
  stderr += c.toString();
});

let nextId = 1;
function call(method, params, timeoutMs = 15000) {
  return new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`timeout: ${method} id=${id}\nstderr:\n${stderr}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveP, reject: rejectP, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${detail}`);
    failures++;
  }
}

async function main() {
  console.log("mcp/server.mjs smoke test");

  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  check("handshake returns server name", init.result.serverInfo.name === "camofox-browser", `got ${init.result.serverInfo?.name}`);
  notify("notifications/initialized");

  const list = await call("tools/list", {});
  const tools = list.result.tools;
  const names = tools.map((t) => t.name).sort();
  check("lists exactly 11 tools", tools.length === 11, `got ${tools.length}`);
  check("tool names match expected", names.join(",") === [...EXPECTED_TOOLS].sort().join(","), `got: ${names.join(",")}`);

  for (const t of tools) {
    check(`"${t.name}" has description`, typeof t.description === "string" && t.description.length > 0);
    check(`"${t.name}" has inputSchema.object`, t.inputSchema?.type === "object" && t.inputSchema.properties !== undefined);
  }

  const nav = tools.find((t) => t.name === "camofox_navigate");
  const macros = nav.inputSchema.properties.macro.enum;
  check("navigate exposes google + reddit macros", macros.includes("@google_search") && macros.includes("@reddit_search"), `got ${macros.length} macros`);
  check("navigate has >=13 macros", macros.length >= 13, `got ${macros.length}`);

  const unknown = await call("tools/call", { name: "does_not_exist", arguments: {} });
  check("unknown tool returns isError", unknown.result.isError === true, `got isError=${unknown.result.isError}`);
  check("unknown tool mentions Unknown tool", /Unknown tool/.test(unknown.result.content[0].text));

  proc.kill();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  proc.kill();
  process.exit(1);
});
