#!/usr/bin/env node
// 단일 MCP 프로세스 안에서 도구들을 순차 호출 — 실제 Claude Code 사용(장기 프로세스,
// 고정 userId)을 시뮬레이션. 스크립트 인자로 JSON 시퀀스를 받는다.
//
// 사용: node scripts/mcp-run.mjs '[["camofox_create_tab",{"url":"..."}],["camofox_snapshot",{}]]'
// snapshot의 tabId는 이전 create_tab 결과에서 자동 치환("${tabId}").
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

// 핸드셰이크
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cli", version: "0" } } });
const init = await wait(1);
if (!init) { console.error("init failed:", stderr); proc.kill(); process.exit(1); }
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const ctx = {}; // 직전 호출 결과에서 키값 보관 (tabId 등)
for (let i = 0; i < seq.length; i++) {
  let [name, args] = seq[i];
  args = args || {};
  // ${var} 치환
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
  // 텍스트 콘텐츠에서 tabId 등 추출해 ctx에 보관
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
