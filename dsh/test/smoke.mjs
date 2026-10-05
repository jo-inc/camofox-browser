/**
 * dsh/ adapter smoke test.
 *
 *   node dsh/test/smoke.mjs
 *
 * Two layers, deliberately separated:
 *   1. A fake DSH host (the minimal ctx surface the adapter touches) proves the
 *      11 tools get registered and that a return value renders into blocks.
 *   2. Live checks against a running REST server are SKIPPED unless one is
 *      reachable, so this runs in CI without the 500MB engine.
 */

import assert from "node:assert/strict";
import { apply } from "../index.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Minimal stand-in for the DSH host context this adapter uses. */
function fakeHost() {
  const tools = [];
  const disposers = [];
  const ctx = {
    inject(deps, fn) {
      assert.deepEqual(deps, ["tools"], "adapter should inject the tools service");
      fn({ tools: { register(def) { tools.push(def); return () => disposers.push(def.name); } } });
    },
    on(event) { assert.equal(event, "dispose"); },
    disposeHooks: disposers,
  };
  return { ctx, tools };
}

console.log("registration");

const { ctx, tools } = fakeHost();
apply(ctx, { baseUrl: "http://localhost:9377", userId: "smoke-user" });

check("registers all 11 canonical tools", () => {
  assert.equal(tools.length, 11);
});

check("tool names match the shared contract", () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "camofox_click",
    "camofox_close_tab",
    "camofox_create_tab",
    "camofox_evaluate",
    "camofox_import_cookies",
    "camofox_list_tabs",
    "camofox_navigate",
    "camofox_screenshot",
    "camofox_scroll",
    "camofox_snapshot",
    "camofox_type",
  ]);
});

check("parameters are the contract's JSON Schema, untouched", () => {
  const create = tools.find((t) => t.name === "camofox_create_tab");
  assert.equal(create.parameters.type, "object");
  assert.deepEqual(create.parameters.required, ["url"]);
});

check("every tool renders a value into content blocks", () => {
  for (const tool of tools) {
    const blocks = tool.output.render({}, { blocks: [{ type: "text", text: "x" }] });
    assert.ok(Array.isArray(blocks) && blocks[0].type === "text", `${tool.name} render`);
  }
});

check("render falls back instead of throwing on an empty value", () => {
  const blocks = tools[0].output.render({}, undefined);
  assert.equal(blocks[0].type, "text");
});

console.log("live REST (skipped when no server is running)");

const baseUrl = process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377";
let alive = false;
try {
  const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
  alive = res.ok;
} catch {
  alive = false;
}

if (!alive) {
  console.log(`  --  no REST server at ${baseUrl}; live checks skipped`);
} else {
  const createTab = tools.find((t) => t.name === "camofox_create_tab");
  const listTabs = tools.find((t) => t.name === "camofox_list_tabs");
  const closeTab = tools.find((t) => t.name === "camofox_close_tab");

  const created = await createTab.execute({ url: "https://example.com" }, {});
  const payload = JSON.parse(created.blocks[0].text);
  check("create_tab returns a tabId", () => {
    assert.ok(payload.tabId, `no tabId in ${created.blocks[0].text.slice(0, 200)}`);
  });

  const listed = await listTabs.execute({}, {});
  check("list_tabs includes the new tab", () => {
    assert.ok(listed.blocks[0].text.includes(payload.tabId));
  });

  await closeTab.execute({ tabId: payload.tabId }, {});
  check("close_tab succeeds", () => {});

  // A cancel signal must reach fetch, not be silently dropped.
  const aborted = await createTab
    .execute({ url: "https://example.com" }, { signal: AbortSignal.abort() })
    .then(() => false)
    .catch(() => true);
  check("an aborted signal actually aborts the request", () => {
    assert.equal(aborted, true);
  });
}

console.log(`\n${passed} 项通过`);
