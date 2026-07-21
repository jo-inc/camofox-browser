#!/usr/bin/env node
// Run a sequence of tool calls inside a single MCP process — simulates real
// Claude Code usage (long-lived process, fixed userId). Takes a JSON sequence
// as a CLI argument.
//
// Usage: node scripts/mcp-run.mjs '[["camofox_create_tab",{"url":"..."}],["camofox_snapshot",{}]]'
// A snapshot's tabId is auto-substituted from the prior create_tab result ("${tabId}").
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SERVER = resolve(ROOT, "mcp", "server.mjs");

const seq = JSON.parse(process.argv[2]);
const proc = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
    NODE_OPTIONS: process.env.NODE_OPTIONS || "",
    CAMOFOX_BASE_URL: process.env.CAMOFOX_BASE_URL || "http://localhost:9377",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
let buf = "";
const results = new Map();
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id != null) results.set(m.id, m); } catch {}
  }
});
let stderr = "";
proc.stderr.on("data", (c) => (stderr += c.toString()));
const wait = async (id, ms = 60000) => {
  const dl = Date.now() + ms;
  while (!results.has(id) && Date.now() < dl) await new Promise((r) => setTimeout(r, 150));
  return results.get(id);
};

// Handshake.
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cli", version: "0" } } });
const init = await wait(1);
if (!init) { console.error("init failed:", stderr); proc.kill(); process.exit(1); }
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const ctx = {}; // carries key values (e.g. tabId) from the previous call
for (let i = 0; i < seq.length; i++) {
  let [name, args] = seq[i];
  args = args || {};
  // Substitute ${var} placeholders.
  const subst = (v) => typeof v === "string"
    ? v.replace(/\$\{(\w+)\}/g, (_, k) => (k in ctx ? String(ctx[k]) : `\${${k}}`))
    : v;
  args = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, subst(v)]));

  const id = 10 + i;
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const res = await wait(id);
  if (!res) { console.log(`\n[${i}] ${name}: NO RESPONSE`); continue; }

  if (res.result?.isError) {
    console.log(`\n[${i}] ${name} → ERROR\n  ${res.result.content[0]?.text}`);
    continue;
  }
  // Pull tabId (and similar) out of text content and stash it in ctx.
  for (const c of res.result.content) {
    if (c.type === "text") {
      try {
        const parsed = JSON.parse(c.text);
        if (parsed.tabId) ctx.tabId = parsed.tabId;
        const summary = JSON.stringify(parsed).slice(0, 400);
        console.log(`\n[${i}] ${name} → OK\n  ${summary}`);
      } catch {
        console.log(`\n[${i}] ${name} → OK (text)\n  ${c.text.slice(0, 400)}`);
      }
    } else if (c.type === "image") {
      console.log(`\n[${i}] ${name} → OK (image ${c.mimeType}, ${c.data.length}b64)`);
    }
  }
}
proc.kill();
