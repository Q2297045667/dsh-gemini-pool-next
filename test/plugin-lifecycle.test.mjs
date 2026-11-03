import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, doctorText } from "../lib/index.js";
import { VISION_BRIDGE_EVENT } from "../lib/vision-bridge.js";

function createHost() {
  const effects = [];
  const disposers = [];
  const tools = [];
  const commands = new Map();
  const routes = new Set();
  const adapters = [];
  const hooks = {};
  const ctx = {
    llm: {
      registerAdapter(providers, adapter) { adapters.push({ providers, adapter }); },
      async resolveModelInfo(provider, id) { return { provider, id, inputModalities: ["text"] }; },
    },
    tools: { register: (tool) => { tools.push(tool); } },
    commands: {
      register(command) {
        commands.set(command.name, command);
        return () => commands.delete(command.name);
      },
    },
    webServer: {
      register(route) {
        routes.add(route);
        return () => routes.delete(route);
      },
    },
    connection: { admit: () => ({}) },
    events: { _hooks: hooks },
    emit() {},
    get() {},
    inject(_services, callback) { callback(ctx); },
    effect(register) {
      const pending = Promise.resolve(register()).then((dispose) => {
        if (typeof dispose === "function") disposers.push(dispose);
      });
      effects.push(pending);
    },
    on(event, callback) {
      (hooks[event] ??= []).push({ callback });
      disposers.push(() => { delete hooks[event]; });
    },
  };
  return {
    ctx, tools, commands, routes, adapters,
    ready: () => Promise.all(effects),
    async dispose() {
      await Promise.all(effects);
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
  };
}

function installClock(t) {
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  t.after(() => Object.assign(globalThis, originals));
  const pending = new Map();
  function schedule(callback, delay, repeating) {
    const handle = { unref() {} };
    pending.set(handle, { callback, delay, repeating });
    return handle;
  }
  globalThis.setTimeout = (callback, delay) => schedule(callback, delay, false);
  globalThis.setInterval = (callback, delay) => schedule(callback, delay, true);
  globalThis.clearTimeout = globalThis.clearInterval = (handle) => pending.delete(handle);
  return {
    pending,
    fireNext() {
      const [handle, timer] = pending.entries().next().value;
      if (!timer.repeating) pending.delete(handle);
      return timer.callback();
    },
  };
}

async function setup(t, { disabledAccount = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "gemini-plugin-lifecycle-"));
  const previousHome = process.env.DSH_HOME;
  const previousVision = process.env.ANTIGRAVITY_VISION_ENABLED;
  process.env.DSH_HOME = home;
  process.env.ANTIGRAVITY_VISION_ENABLED = "true";
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousVision === undefined) delete process.env.ANTIGRAVITY_VISION_ENABLED;
    else process.env.ANTIGRAVITY_VISION_ENABLED = previousVision;
    await rm(home, { recursive: true, force: true });
  });
  const poolFile = join(home, "storages", "antigravity-pool-accounts.json");
  await mkdir(join(home, "storages"));
  await writeFile(poolFile, JSON.stringify({
    probeIntervalMs: 25,
    accounts: disabledAccount ? [{
      id: "lifecycle-account", email: "lifecycle@example.com", refresh: "fake-refresh", access: "fake-access",
      expires: Date.now() + 3600000, projectId: "lifecycle-project", status: "disabled", failureCount: 3,
    }] : [],
  }));
  const clock = installClock(t);
  const host = createHost();
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();
  return { ...host, clock, poolFile };
}

function delayProbe(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let release;
  let markStarted;
  let streams = 0;
  const heldResponse = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).includes(":fetchAvailableModels")) {
      return new Response(JSON.stringify({ models: {} }), { headers: { "content-type": "application/json" } });
    }
    assert.ok(String(url).includes(":streamGenerateContent"), `unexpected offline request: ${url}`);
    streams += 1;
    markStarted();
    return heldResponse;
  };
  return {
    started,
    streams: () => streams,
    release() {
      release(new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "pong" }] } }] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }));
    },
  };
}

test("plugin startup registers the adapter, tools, commands, web routes, and vision bridge; disposal restores the host", async (t) => {
  const host = await setup(t);
  assert.deepEqual(host.adapters[0].providers, ["antigravity"]);
  assert.deepEqual(host.tools.map((tool) => tool.name).sort(), ["antigravity_image_generate", "antigravity_read_image"]);
  assert.equal(host.commands.size, 4);
  assert.equal(host.routes.size, 1);
  assert.equal(host.ctx.events._hooks[VISION_BRIDGE_EVENT].length, 1);
  assert.deepEqual((await host.ctx.llm.resolveModelInfo("text-provider", "text-model")).inputModalities, ["text", "image"]);
  assert.match(doctorText(), /^visionBridge=registered$/m);
  assert.equal(host.clock.pending.size, 1);

  await host.dispose();
  assert.equal(host.commands.size, 0);
  assert.equal(host.routes.size, 0);
  assert.equal(host.ctx.events._hooks[VISION_BRIDGE_EVENT], undefined);
  assert.deepEqual((await host.ctx.llm.resolveModelInfo("text-provider", "text-model")).inputModalities, ["text"]);
  assert.equal(host.clock.pending.size, 0, "unloading the plugin must cancel background probes");
});

test("background probes honor the persisted interval and schedule the next run only after completion", { timeout: 5000 }, async (t) => {
  const host = await setup(t, { disabledAccount: true });
  const probe = delayProbe(t);
  assert.equal([...host.clock.pending.values()][0].delay, 25);
  const running = host.clock.fireNext();
  await probe.started;
  assert.equal(probe.streams(), 1);
  assert.equal(host.clock.pending.size, 0, "an unfinished probe must not overlap another timer run");
  probe.release();
  await running;
  const saved = JSON.parse(await readFile(host.poolFile, "utf8"));
  assert.equal(saved.accounts[0].status, "active");
  assert.equal(saved.accounts[0].failureCount, 2);
  assert.equal(host.clock.pending.size, 1);
  assert.equal([...host.clock.pending.values()][0].delay, 25);
});

test("unloading during an in-flight probe prevents recovery writes and timer rescheduling", { timeout: 5000 }, async (t) => {
  const host = await setup(t, { disabledAccount: true });
  const probe = delayProbe(t);
  const running = host.clock.fireNext();
  await probe.started;
  assert.equal(probe.streams(), 1);
  await host.dispose();
  probe.release();
  await running;
  const saved = JSON.parse(await readFile(host.poolFile, "utf8"));
  assert.equal(saved.accounts[0].status, "disabled");
  assert.equal(saved.accounts[0].failureCount, 3);
  assert.equal(host.clock.pending.size, 0);
});
