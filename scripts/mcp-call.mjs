#!/usr/bin/env node
// MCP tool-call helper — invoke one tool (e.g. create_tab/snapshot) and print
// the result as JSON.
// Usage: node scripts/mcp-call.mjs <tool_name> '<json-args>'
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SERVER = resolve(ROOT, "mcp", "server.mjs");

const [toolName, argsJson] = process.argv.slice(2);
if (!toolName) {
  console.error("usage: mcp-call.mjs <tool> '<json-args>'");
  process.exit(2);
}
let args = {};
if (argsJson) {
  try { args = JSON.parse(argsJson); }
  catch (e) { console.error("bad json:", e.message); process.exit(2); }
}

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
    try { const m = JSON.parse(line); if (m.id != null) results.set(m.id, m); }
    catch {}
  }
});
let stderr = "";
proc.stderr.on("data", (c) => (stderr += c.toString()));

await new Promise((r) => setTimeout(r, 300));
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cli", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: toolName, arguments: args } });

// wait for id:2
const deadline = Date.now() + 90000;
while (!results.has(2) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
proc.kill();

const res = results.get(2);
if (!res) {
  console.error("NO RESPONSE (timeout)\nstderr:", stderr);
  process.exit(1);
}
if (res.result?.isError) {
  console.error("TOOL ERROR:", res.result.content[0]?.text);
  process.exit(1);
}
// Emit the result (for image content, only show the data length).
const out = res.result.content.map((c) => {
  if (c.type === "image") return `[image: ${c.mimeType}, ${c.data.length} chars base64]`;
  if (c.type === "text") {
    // Pretty-print if the text is JSON, otherwise leave it as-is.
    try { return JSON.stringify(JSON.parse(c.text), null, 2); }
    catch { return c.text; }
  }
  return c;
});
console.log(out.join("\n"));
