import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LlmError } from "@deepseek-ai/dsh-llm";
import {
  WEB_API_PREFIX,
  activeProviderId,
  activeProviderName,
  apply,
  callbackPort,
  credentialPath,
  doctorText,
  ensureStorageMigration,
  isCoexistMode,
  modelSettingsPath,
  providerCandidates,
  resolveProviderTarget,
  upstreamPluginConfigured,
} from "../lib/index.js";
import {
  AccountPoolManager,
  accountsPoolPath,
  legacyCredentialPath,
  setCoexistMode,
  storageFileName,
  storagePathForMode,
} from "../lib/pool.js";

// Every env knob this suite manipulates; setupHome clears them so the developer
// machine's real configuration never leaks into the assertions.
const ENV_KEYS = [
  "ANTIGRAVITY_PROVIDER_ID",
  "ANTIGRAVITY_PROVIDER_NAME",
  "ANTIGRAVITY_COEXIST_PROVIDER_ID",
  "ANTIGRAVITY_CALLBACK_PORT",
  "NOAGY_PROVIDER_ID",
  "NOAGY_PROVIDER_NAME",
  "NOAGY_COEXIST_PROVIDER_ID",
  "NOAGY_CALLBACK_PORT",
];

async function setupHome(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), "gemini-coexist-"));
  const previousHome = process.env.DSH_HOME;
  const savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DSH_HOME = home;
  Object.assign(process.env, overrides);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

/**
 * Minimal stand-in for the Cordis host services the plugin touches. `inject`
 * resolves every dependency as available (the real host gates on service
 * presence; these tests exercise plugin logic, not activation order).
 */
function createHost({ listedProviders = [], loaderEntries, tools } = {}) {
  const effects = [];
  const disposers = [];
  const adapters = [];
  const routes = [];
  const hooks = {};
  const registeredTools = [];
  const toolsService = tools ?? {
    register(tool) {
      registeredTools.push(tool);
    },
    view() {
      return { knownNames: new Set(registeredTools.map((tool) => tool.name)) };
    },
  };
  const ctx = {
    llm: {
      listProviders: () => listedProviders.map((id) => ({ id, name: id })),
      registerAdapter(providers, adapter) {
        adapters.push({ providers, adapter });
      },
      async resolveModelInfo(provider, id) {
        return { provider, id, inputModalities: ["text"] };
      },
    },
    tools: toolsService,
    commands: {
      register() {
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    connection: { admit: () => ({}) },
    events: { _hooks: hooks },
    emit() {},
    get(name) {
      if (name === "loader" && loaderEntries) return { entries: () => loaderEntries };
      return undefined;
    },
    inject(_services, callback) {
      callback(ctx);
    },
    effect(register) {
      effects.push(
        Promise.resolve(register()).then((dispose) => {
          if (typeof dispose === "function") disposers.push(dispose);
        }),
      );
    },
    on(event, callback) {
      (hooks[event] ??= []).push({ callback });
      disposers.push(() => {
        delete hooks[event];
      });
    },
  };
  return {
    ctx,
    adapters,
    routes,
    registeredTools,
    toolsService,
    ready: () => Promise.all(effects),
    async dispose() {
      await Promise.all(effects);
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
  };
}

function routeFor(host, path) {
  const route = host.routes.find((candidate) => candidate.path === path);
  assert.ok(route, `expected a prefix route for ${path}, got ${host.routes.map((r) => r.path).join(", ")}`);
  return route;
}

async function requestStatus(host, prefix = WEB_API_PREFIX) {
  const route = routeFor(host, prefix);
  const result = { status: 0, body: undefined };
  await route.handler({ method: "GET", url: `${prefix}/status`, headers: {} }, {
    writeHead(status) {
      result.status = status;
    },
    end(text) {
      result.body = JSON.parse(text);
    },
  });
  return result;
}

async function writeStorage(home, mode, kind, payload) {
  await mkdir(join(home, "storages"), { recursive: true });
  const file = join(home, "storages", storageFileName(kind, mode));
  await writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

test("no competing provider: keeps the historical antigravity identity", async (t) => {
  const home = await setupHome(t);
  const host = createHost();
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();

  assert.deepEqual(host.adapters.map((entry) => entry.providers), [["antigravity"]]);
  assert.equal(activeProviderId(), "antigravity");
  assert.equal(activeProviderName(), "Antigravity");
  assert.equal(isCoexistMode(), false);
  assert.equal(host.adapters[0].adapter.providerInfo("antigravity").name, "Antigravity");
  assert.equal(host.adapters[0].adapter.providerInfo("antigravity").id, "antigravity");

  // Storage keeps the historical names in non-coexist mode.
  assert.equal(accountsPoolPath(), join(home, "storages", "antigravity-pool-accounts.json"));
  assert.equal(modelSettingsPath(), join(home, "storages", "antigravity-settings.json"));
  assert.equal(credentialPath(), join(home, "storages", "antigravity-oauth.json"));
  assert.equal(legacyCredentialPath(), credentialPath());

  assert.equal(callbackPort(), 51121);
  assert.match(doctorText(), /^provider=antigravity$/m);
  assert.match(doctorText(), /^providerName=Antigravity$/m);
  assert.match(doctorText(), /^coexistMode=false$/m);

  // Web API lives on our own prefix (upstream owns /antigravity/api).
  assert.equal(routeFor(host, WEB_API_PREFIX).kind, "prefix");
  const status = await requestStatus(host);
  assert.equal(status.status, 200);
  assert.equal(status.body.value.provider, "antigravity");
  assert.equal(status.body.value.providerName, "Antigravity");
});

test("provider already taken: registers antigravity-pool and moves storage/callback off upstream", async (t) => {
  const home = await setupHome(t);
  const host = createHost({ listedProviders: ["antigravity"] });
  t.after(() => host.dispose());
  const logged = [];
  t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));
  apply(host.ctx);
  await host.ready();

  assert.deepEqual(host.adapters.map((entry) => entry.providers), [["antigravity-pool"]]);
  assert.equal(activeProviderId(), "antigravity-pool");
  assert.equal(activeProviderName(), "Antigravity Pool");
  assert.equal(isCoexistMode(), true);
  assert.equal(host.adapters[0].adapter.providerInfo("antigravity-pool").id, "antigravity-pool");
  assert.equal(host.adapters[0].adapter.providerInfo("antigravity-pool").name, "Antigravity Pool");

  assert.ok(
    logged.some((line) =>
      /^\[Antigravity Pool\] provider "antigravity" is already taken by another plugin; using provider "antigravity-pool" \(coexist mode; decided by listProviders\)$/.test(line)),
    `expected one coexist log line naming the listProviders rule, got: ${logged.join(" | ")}`,
  );

  // Namespaced storage so the upstream plugin's files cannot be clobbered.
  assert.equal(accountsPoolPath(), join(home, "storages", "antigravity-pool-next-accounts.json"));
  assert.equal(modelSettingsPath(), join(home, "storages", "antigravity-pool-next-settings.json"));
  assert.equal(credentialPath(), join(home, "storages", "antigravity-pool-next-oauth.json"));
  assert.equal(legacyCredentialPath(), credentialPath());

  assert.equal(callbackPort(), 51122);
  assert.match(doctorText(), /^provider=antigravity-pool$/m);
  assert.match(doctorText(), /^providerName=Antigravity Pool$/m);
  assert.match(doctorText(), /^coexistMode=true$/m);

  const status = await requestStatus(host);
  assert.equal(status.status, 200);
  assert.equal(status.body.value.provider, "antigravity-pool");
  assert.equal(status.body.value.providerName, "Antigravity Pool");
  // Existing payload fields are untouched.
  assert.equal(typeof status.body.value.schedulingMode, "string");
  assert.deepEqual(status.body.value.accounts, []);
});

test("the loader entry list forces coexist even before the upstream adapter registers", async (t) => {
  await setupHome(t);
  const upstreamEntry = {
    options: { id: "dsh-gemini-pool", name: "dsh-gemini-pool" },
    disabled: false,
  };
  const logged = [];
  t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));
  const host = createHost({ listedProviders: [], loaderEntries: [upstreamEntry] });
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();
  assert.deepEqual(host.adapters.map((entry) => entry.providers), [["antigravity-pool"]]);
  assert.equal(isCoexistMode(), true);
  assert.ok(
    logged.some((line) => line.includes('decided by loader entry "dsh-gemini-pool"')),
    `expected the loader-entry rule in the coexist log, got: ${logged.join(" | ")}`,
  );

  // Our own entry (and any other plugin) must not trigger the fallback.
  const ownEntry = { options: { id: "dsh-gemini-pool-next", name: "dsh-gemini-pool-next" }, disabled: false };
  const normalHost = createHost({ listedProviders: [], loaderEntries: [ownEntry] });
  t.after(() => normalHost.dispose());
  apply(normalHost.ctx);
  await normalHost.ready();
  assert.deepEqual(normalHost.adapters.map((entry) => entry.providers), [["antigravity"]]);
  assert.equal(isCoexistMode(), false);

  // A disabled upstream entry never registers, so we keep "antigravity".
  const disabledEntry = {
    options: { id: "dsh-gemini-pool", name: "dsh-gemini-pool", disabled: true },
    disabled: true,
  };
  const disabledHost = createHost({ listedProviders: [], loaderEntries: [disabledEntry] });
  t.after(() => disabledHost.dispose());
  apply(disabledHost.ctx);
  await disabledHost.ready();
  assert.deepEqual(disabledHost.adapters.map((entry) => entry.providers), [["antigravity"]]);
  assert.equal(isCoexistMode(), false);
});

test("upstreamPluginConfigured tolerates hosts without a loader service", () => {
  assert.equal(upstreamPluginConfigured(undefined), false);
  assert.equal(upstreamPluginConfigured({}), false);
  assert.equal(upstreamPluginConfigured({ get() { return undefined; } }), false);
  assert.equal(upstreamPluginConfigured({ get: () => ({}) }), false);
});

test("provider candidates: explicit config/env preferred and coexist ids are honored", async (t) => {
  await setupHome(t);
  // No env, no config: the documented defaults.
  assert.deepEqual(providerCandidates({}), ["antigravity", "antigravity-pool", "antigravity-pool-2"]);
  const free = resolveProviderTarget({}, { listedProviders: [] });
  assert.equal(free.provider.id, "antigravity");
  assert.equal(free.provider.coexist, false);
  const taken = resolveProviderTarget({}, { listedProviders: [{ id: "antigravity" }] });
  assert.equal(taken.provider.id, "antigravity-pool");
  assert.equal(taken.provider.coexist, true);
  assert.equal(taken.decidedBy, "listProviders");
  assert.equal(free.decidedBy, "preferred");
  assert.equal(
    resolveProviderTarget({}, { listedProviders: [], upstreamConfigured: true }).decidedBy,
    "loader-entry",
  );
  // Third registration guard.
  const twiceTaken = resolveProviderTarget(
    {},
    { listedProviders: [{ id: "antigravity" }, { id: "antigravity-pool" }] },
  );
  assert.equal(twiceTaken.provider.id, "antigravity-pool-2");

  // Config wins over env.
  process.env.ANTIGRAVITY_PROVIDER_ID = "env-antigravity";
  assert.equal(resolveProviderTarget({}, { listedProviders: [] }).provider.id, "env-antigravity");
  assert.equal(
    resolveProviderTarget({ providerId: "config-antigravity" }, { listedProviders: [] }).provider.id,
    "config-antigravity",
  );
  assert.deepEqual(
    providerCandidates({ coexistProviderId: "my-pool" }),
    ["env-antigravity", "my-pool", "my-pool-2"],
  );
  process.env.ANTIGRAVITY_COEXIST_PROVIDER_ID = "env-pool";
  assert.equal(
    resolveProviderTarget({}, { listedProviders: [{ id: "env-antigravity" }] }).provider.id,
    "env-pool",
  );

  // Explicit providerId means "do not auto-yield to the upstream plugin"; the
  // registry snapshot still wins because a taken id cannot be registered twice.
  delete process.env.ANTIGRAVITY_COEXIST_PROVIDER_ID;
  assert.equal(
    resolveProviderTarget({ providerId: "custom" }, { listedProviders: [], upstreamConfigured: true })
      .provider.id,
    "custom",
  );
  assert.equal(
    resolveProviderTarget({ providerId: "custom" }, { listedProviders: [{ id: "custom" }] }).provider.id,
    "custom-pool",
  );
});

test("a stale registry snapshot is recovered by retrying the next provider id", async (t) => {
  const home = await setupHome(t);
  const host = createHost({ listedProviders: [] });
  const registered = [];
  host.ctx.llm.registerAdapter = (providers, adapter) => {
    if (providers[0] === "antigravity") {
      throw new LlmError('an adapter for provider "antigravity" is already registered', "DUPLICATE_ADAPTER");
    }
    registered.push({ providers, adapter });
  };
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();

  assert.deepEqual(registered.map((entry) => entry.providers), [["antigravity-pool"]]);
  assert.equal(activeProviderId(), "antigravity-pool");
  assert.equal(isCoexistMode(), true);
  assert.equal(accountsPoolPath(), join(home, "storages", "antigravity-pool-next-accounts.json"));

  // Any other registration error is not swallowed.
  const failingHost = createHost({ listedProviders: [] });
  failingHost.ctx.llm.registerAdapter = () => {
    throw new LlmError("adapter metadata invalid", "INVALID_ADAPTER");
  };
  t.after(() => failingHost.dispose());
  assert.throws(() => apply(failingHost.ctx), (error) => error.code === "INVALID_ADAPTER");
});

test("storage migrates one way into coexist mode without overwriting", async (t) => {
  const home = await setupHome(t);
  const accounts = await writeStorage(home, "normal", "accounts", {
    accounts: [{ id: "acc-legacy", email: "legacy@example.com", refresh: "refresh-legacy" }],
  });
  const settings = await writeStorage(home, "normal", "settings", { enabledModelIds: ["gemini-3.8-flash"] });
  const oauth = await writeStorage(home, "normal", "oauth", { refresh: "refresh-legacy" });

  const logged = [];
  t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));
  const host = createHost({ listedProviders: ["antigravity"] });
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();

  const coexistAccounts = join(home, "storages", "antigravity-pool-next-accounts.json");
  const coexistSettings = join(home, "storages", "antigravity-pool-next-settings.json");
  const coexistOauth = join(home, "storages", "antigravity-pool-next-oauth.json");
  for (const [source, target] of [
    [accounts, coexistAccounts],
    [settings, coexistSettings],
    [oauth, coexistOauth],
  ]) {
    assert.equal(existsSync(target), true, `missing migrated ${target}`);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), JSON.parse(await readFile(source, "utf8")));
    // The historical file is left untouched for the upstream plugin/user.
    assert.equal(existsSync(source), true);
  }
  assert.ok(
    logged.some((line) => line.includes("[Antigravity Pool] migrate legacy storage")),
    `expected migration log lines, got: ${logged.join(" | ")}`,
  );
  // One-time: a second pass (as on the next boot) copies nothing.
  assert.deepEqual(ensureStorageMigration({ log: () => {} }), []);
});

test("storage migrates back out of coexist mode and never overwrites an existing file", async (t) => {
  const home = await setupHome(t);
  // Seed the coexist namespace only, then boot in normal mode (upstream gone).
  const nextAccounts = await writeStorage(home, "coexist", "accounts", {
    accounts: [{ id: "acc-next", email: "next@example.com", refresh: "refresh-next" }],
  });
  await writeStorage(home, "coexist", "settings", { enabledModelIds: [] });
  await writeStorage(home, "coexist", "oauth", { refresh: "refresh-next" });

  const normalHost = createHost();
  t.after(() => normalHost.dispose());
  apply(normalHost.ctx);
  await normalHost.ready();
  const normalAccounts = join(home, "storages", "antigravity-pool-accounts.json");
  assert.equal(existsSync(normalAccounts), true);
  assert.deepEqual(JSON.parse(await readFile(normalAccounts, "utf8")), JSON.parse(await readFile(nextAccounts, "utf8")));
  assert.equal(existsSync(join(home, "storages", "antigravity-settings.json")), true);
  assert.equal(existsSync(join(home, "storages", "antigravity-oauth.json")), true);

  // Never overwrite: both namespaces present with different content.
  const otherHome = await mkdtemp(join(tmpdir(), "gemini-coexist-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = otherHome;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(otherHome, { recursive: true, force: true });
  });
  await writeStorage(otherHome, "normal", "accounts", { accounts: [{ id: "old", refresh: "r1" }] });
  const namespaced = await writeStorage(otherHome, "coexist", "accounts", { accounts: [{ id: "new", refresh: "r2" }] });
  const coexistHost = createHost({ listedProviders: ["antigravity"] });
  t.after(() => coexistHost.dispose());
  apply(coexistHost.ctx);
  await coexistHost.ready();
  assert.deepEqual(JSON.parse(await readFile(namespaced, "utf8")), { accounts: [{ id: "new", refresh: "r2" }] });
});

test("OAuth callback port: 51121 normally, 51122 in coexist mode, env always wins", async (t) => {
  await setupHome(t);
  const normalHost = createHost();
  t.after(() => normalHost.dispose());
  apply(normalHost.ctx);
  await normalHost.ready();
  assert.equal(callbackPort(), 51121);
  process.env.ANTIGRAVITY_CALLBACK_PORT = "51999";
  assert.equal(callbackPort(), 51999);
  delete process.env.ANTIGRAVITY_CALLBACK_PORT;

  const coexistHost = createHost({ listedProviders: ["antigravity"] });
  t.after(() => coexistHost.dispose());
  apply(coexistHost.ctx);
  await coexistHost.ready();
  assert.equal(callbackPort(), 51122);
  process.env.ANTIGRAVITY_CALLBACK_PORT = "51999";
  assert.equal(callbackPort(), 51999);
  process.env.ANTIGRAVITY_CALLBACK_PORT = "not-a-port";
  assert.throws(() => callbackPort(), /Invalid ANTIGRAVITY_CALLBACK_PORT/);
});

test("a duplicate image tool name drops only that tool, never the vision tool", async (t) => {
  await setupHome(t);
  const taken = new Set(["antigravity_image_generate"]);
  const registered = [];
  const preCheckTools = {
    register(tool) {
      if (taken.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
      taken.add(tool.name);
      registered.push(tool);
    },
    view() {
      return { knownNames: new Set(taken) };
    },
  };
  const host = createHost({ listedProviders: ["antigravity"], tools: preCheckTools });
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();
  assert.deepEqual(registered.map((tool) => tool.name), ["antigravity_read_image"]);

  // Without a view API the registry duplicate error is caught per tool.
  const blindTaken = new Set(["antigravity_image_generate"]);
  const blindRegistered = [];
  const blindTools = {
    register(tool) {
      if (blindTaken.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
      blindTaken.add(tool.name);
      blindRegistered.push(tool);
    },
  };
  const blindHost = createHost({ listedProviders: ["antigravity"], tools: blindTools });
  t.after(() => blindHost.dispose());
  apply(blindHost.ctx);
  await blindHost.ready();
  assert.deepEqual(blindRegistered.map((tool) => tool.name), ["antigravity_read_image"]);

  // Normal mode registers both (no duplicate upstream plugin around).
  const normalHost = createHost();
  t.after(() => normalHost.dispose());
  apply(normalHost.ctx);
  await normalHost.ready();
  assert.deepEqual(
    normalHost.registeredTools.map((tool) => tool.name).sort(),
    ["antigravity_image_generate", "antigravity_read_image"],
  );
});

test("stream replay metadata is stamped with the resolved provider id", async (t) => {
  const home = await setupHome(t);
  // Seed the historical storage namespace: apply() must migrate it and the
  // registered adapter must stream/replay through the migrated copy.
  const normalAccounts = join(home, "storages", "antigravity-pool-accounts.json");
  const normalOauth = join(home, "storages", "antigravity-oauth.json");
  const pool = new AccountPoolManager(normalAccounts, normalOauth);
  await pool.addOrUpdateAccount({
    email: "coexist@example.com",
    access: "access-coexist-replay",
    refresh: "refresh-coexist-replay",
    expires: Date.now() + 3600_000,
    projectId: "project-coexist-replay",
  });

  const host = createHost({ listedProviders: ["antigravity"] });
  t.after(() => host.dispose());
  apply(host.ctx);
  await host.ready();

  assert.equal(existsSync(join(home, "storages", "antigravity-pool-next-accounts.json")), true);
  const adapter = host.adapters[0].adapter;

  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(":fetchAvailableModels")) return Response.json({ models: {} });
    assert.ok(path.endsWith(":streamGenerateContent"), `unexpected network request: ${path}`);
    const frame = {
      response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    };
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const chunks = [];
  for await (const chunk of adapter.stream({
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    chunks.push(chunk);
  }
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.ok(finish, "stream must finish");
  assert.equal(finish.replayState.kind, "antigravity");
  assert.equal(finish.replayState.provider, "antigravity-pool");
  assert.equal(finish.replayState.model, "gemini-3.8-flash");
  assert.ok(Array.isArray(finish.replayState.blocks));
});

test("storage path helpers follow the resolved mode", () => {
  setCoexistMode(false);
  assert.equal(accountsPoolPath(), storagePathForMode("accounts", "normal"));
  assert.equal(legacyCredentialPath(), storagePathForMode("oauth", "normal"));
  assert.equal(storageFileName("settings", "normal"), "antigravity-settings.json");
  assert.throws(() => storageFileName("nope", "normal"), /unknown Antigravity storage kind/);

  setCoexistMode(true);
  assert.equal(accountsPoolPath(), storagePathForMode("accounts", "coexist"));
  assert.equal(legacyCredentialPath(), storagePathForMode("oauth", "coexist"));
  assert.match(accountsPoolPath(), /antigravity-pool-next-accounts\.json$/);
  assert.match(legacyCredentialPath(), /antigravity-pool-next-oauth\.json$/);
  assert.equal(storageFileName("settings", "coexist"), "antigravity-pool-next-settings.json");
  setCoexistMode(false);
});
