import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolManager } from "../lib/pool.js";
import {
  FileModelSettingsStore,
  catalogClientFingerprint,
  fetchQuotaForAccount,
  getBestCatalogQuota,
  parseCatalogModels,
  registerWebApi,
} from "../lib/index.js";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-catalog-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  const settingsFile = join(dir, "models.json");
  const settings = new FileModelSettingsStore(settingsFile);
  await pool.init();
  async function addAccount(name) {
    const email = `${name}@example.com`;
    await pool.addOrUpdateAccount({
      email,
      access: `access_${name}`,
      refresh: `refresh_${name}`,
      expires: Date.now() + 3600_000,
      projectId: `project-${name}`,
    });
    return pool.allAccounts.find((account) => account.email === email);
  }
  return { pool, settings, settingsFile, addAccount };
}

function stubCatalogFetch(t, catalogs) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const token = new Headers(init?.headers).get("authorization");
    const account = token?.replace("Bearer access_", "");
    assert.ok(Object.hasOwn(catalogs, account), `unexpected account token ${token}`);
    const path = new URL(String(url)).pathname;
    let payload;
    if (path.endsWith(":loadCodeAssist")) payload = { cloudaicompanionProject: `project-${account}` };
    else if (path.endsWith(":retrieveUserQuotaSummary")) payload = { groups: [] };
    else if (path.endsWith(":fetchAvailableModels")) payload = { models: catalogs[account] };
    else throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  });
}

/** The disabled placeholder the sandbox endpoint serves on a Pro account. */
const CARBON_DISABLED = {
  displayName: "Gemini 4 Carbon",
  supportsImages: true,
  supportsThinking: true,
  minThinkingBudget: 128,
  recommended: true,
  maxTokens: 1048576,
  maxOutputTokens: 262144,
  disabled: true,
  tagTitle: "Unavailable",
  tagDescription: "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
  thinkingLevel: 2,
};

function apiHandler(pool, settings) {
  let handler;
  const webCtx = {
    connection: { admit: () => ({}) },
    effect: (fn) => fn(),
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  };
  registerWebApi({ inject: (_deps, fn) => fn(webCtx) }, pool, settings);
  assert.equal(typeof handler, "function");
  return async (path = "status") => {
    let status;
    let body;
    await handler({ method: "GET", url: `/antigravity-pool-next/api/${path}` }, {
      writeHead(value) { status = value; },
      end(value) { body = JSON.parse(value); },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    return body.value;
  };
}

test("first quota discovery enables only models advertised by that account", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("free");
  stubCatalogFetch(t, { free: { "gemini-3.8-flash-low": {} } });
  await fetchQuotaForAccount(account, pool, settings);

  const stored = await settings.read();
  assert.deepEqual(stored.enabledModelIds, ["gemini-3.8-flash"]);
  assert.equal(stored.catalogModels.find((model) => model.id === "gemini-4-argon").available, false);
  const status = await apiHandler(pool, settings)();
  assert.equal(status.models.options.find((model) => model.id === "gemini-4-argon").enabled, false);
});

test("refreshing another account retains the pool catalog and enabled dynamic models", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const first = await addAccount("first");
  const second = await addAccount("second");
  stubCatalogFetch(t, {
    first: { "gemini-3.8-flash-low": {}, "gemini-custom-alpha": {} },
    second: { "claude-opus-5-5-high": {}, "gemini-custom-beta": {} },
  });
  await fetchQuotaForAccount(first, pool, settings);
  await settings.setEnabledModelIds(["gemini-custom-alpha"]);
  await fetchQuotaForAccount(second, pool, settings);

  const stored = await settings.read();
  const catalog = new Map(stored.catalogModels.map((model) => [model.id, model]));
  assert.ok(catalog.has("gemini-custom-alpha"));
  assert.ok(catalog.has("gemini-custom-beta"));
  assert.equal(catalog.get("gemini-3.8-flash").available, true);
  assert.equal(catalog.get("claude-opus-5.5").available, true);
  assert.deepEqual(stored.enabledModelIds, ["gemini-custom-alpha"]);
});

test("concurrent account quota refreshes preserve both dynamic model catalogs", async (t) => {
  const { pool, settings, settingsFile, addAccount } = await setup(t);
  const first = await addAccount("first");
  const second = await addAccount("second");
  stubCatalogFetch(t, {
    first: { "gemini-custom-concurrent-alpha": {} },
    second: { "gemini-custom-concurrent-beta": {} },
  });
  await Promise.all([
    fetchQuotaForAccount(first, pool, settings),
    fetchQuotaForAccount(second, pool, settings),
  ]);

  const stored = await settings.read();
  const ids = new Set(stored.catalogModels.filter((model) => model.available).map((model) => model.id));
  assert.deepEqual(ids, new Set(["gemini-custom-concurrent-alpha", "gemini-custom-concurrent-beta"]));
  assert.deepEqual(await new FileModelSettingsStore(settingsFile).read(), stored);
});

test("quota refresh preserves an intentional empty model selection", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("free");
  stubCatalogFetch(t, { free: { "gemini-3.8-flash-low": {} } });
  await fetchQuotaForAccount(account, pool, settings);
  await settings.setEnabledModelIds([]);
  await fetchQuotaForAccount(account, pool, settings);
  assert.deepEqual((await settings.read()).enabledModelIds, []);
});

test("first quota discovery preserves a model selection saved before discovery", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("free");
  stubCatalogFetch(t, { free: { "gemini-3.8-flash-low": {} } });
  await settings.setEnabledModelIds([]);
  await fetchQuotaForAccount(account, pool, settings);
  assert.deepEqual((await settings.read()).enabledModelIds, []);
});

test("a refresh stamps the catalog with the client fingerprint it was discovered under", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("free");
  stubCatalogFetch(t, { free: { "gemini-3.8-flash-low": {} } });
  await fetchQuotaForAccount(account, pool, settings);
  const stored = await settings.read();
  assert.equal(stored.catalogClient, catalogClientFingerprint());
  assert.match(stored.catalogClient, /^\d+\.\d+\.\d+\/\d+$/);
});

test("a refresh prunes models no account in the pool serves", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("free");
  stubCatalogFetch(t, { free: { "gemini-3.8-flash-low": {} } });
  await fetchQuotaForAccount(account, pool, settings);
  // Simulate a selection saved while the model was still advertised.
  await settings.setEnabledModelIds(["gemini-3.8-flash", "gemini-4-argon"]);
  await fetchQuotaForAccount(account, pool, settings);
  assert.deepEqual((await settings.read()).enabledModelIds, ["gemini-3.8-flash"]);
});

test("available catalog rows without numeric quota beat unavailable rows in either order", () => {
  const unavailable = { quota: { fetchedAt: 1, catalogModels: [{ id: "gemini-4-argon", available: false }] } };
  const available = { quota: { fetchedAt: 2, catalogModels: [{ id: "gemini-4-argon", available: true }] } };
  for (const accounts of [[unavailable, available], [available, unavailable]]) {
    const best = getBestCatalogQuota(accounts);
    assert.equal(best.catalogModels[0].available, true);
    assert.equal(best.catalogModels[0].remainingFraction, undefined);
    assert.equal(best.fetchedAt, 2);
  }
});

test("best catalog aggregation selects the largest remaining quota for an available model", () => {
  const quotas = [0, 0.8, 0.3].map((remainingFraction) => ({
    quota: { catalogModels: [{ id: "gemini-3.8-flash", available: true, remainingFraction }] },
  }));
  assert.equal(getBestCatalogQuota(quotas).catalogModels[0].remainingFraction, 0.8);
});

test("status API retains catalog unavailability when no account quota remains", async (t) => {
  const { pool, settings } = await setup(t);
  await settings.setCatalogModels(parseCatalogModels({ models: { "gemini-3.8-flash-low": {} } }));
  const status = await apiHandler(pool, settings)();
  const options = new Map(status.models.options.map((model) => [model.id, model]));
  assert.equal(options.get("gemini-4-argon").available, false);
  assert.equal(options.get("gemini-4-argon").remainingPercent, undefined);
  assert.equal(options.get("gemini-3.8-flash").available, true);
});

test("status API restores static model metadata for catalogs saved by earlier versions", async (t) => {
  const { pool, settings } = await setup(t);
  await settings.setCatalogModels([{
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    available: false,
  }]);
  const status = await apiHandler(pool, settings)();
  const model = status.models.options.find((option) => option.id === "claude-sonnet-4-6");
  assert.equal(model.deprecated, true);
  assert.match(model.description, /2026-11-18/);
  assert.equal(model.available, false);
});

test("a disabled carbon placeholder never becomes a quota, catalog or enabled model", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("pro");
  stubCatalogFetch(t, {
    pro: { "gemini-3.8-flash-low": {}, "gemini-4-carbon-disabled": CARBON_DISABLED },
  });
  const quota = await fetchQuotaForAccount(account, pool, settings);

  // The quota-row list (CLI / status) never lists the disabled entity.
  assert.ok(!quota.models.some((model) => model.modelId === "gemini-4-carbon-disabled"));

  const stored = await settings.read();
  const catalog = new Map(stored.catalogModels.map((model) => [model.id, model]));
  assert.equal(catalog.has("gemini-4-carbon-disabled"), false);
  const carbon = catalog.get("gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.equal(carbon.unavailableReason, "Gemini 4 Carbon is currently available to Ultra plan subscribers.");
  assert.equal(carbon.maxTokens, 262144);
  assert.equal(carbon.contextWindow, 1048576);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);
  // First discovery enables only what this Pro account really serves.
  assert.deepEqual(stored.enabledModelIds, ["gemini-3.8-flash"]);

  // The settings card sees it as unavailable, with the backend reason.
  const status = await apiHandler(pool, settings)();
  const carbonOption = status.models.options.find((option) => option.id === "gemini-4-carbon");
  assert.equal(carbonOption.available, false);
  assert.equal(carbonOption.enabled, false);
  assert.match(carbonOption.unavailableReason, /Ultra plan subscribers/);
  assert.equal(status.models.options.some((option) => option.id.includes("-disabled")), false);
});

test("a refresh prunes the stale disabled id and keeps unavailable carbon unchecked", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("pro");
  // Settings persisted by the buggy version: the raw placeholder was a model
  // (available: true) and the user's enabled set named it.
  await settings.setCatalogModels([
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", available: true },
    {
      id: "gemini-4-carbon-disabled",
      name: "Gemini 4 Carbon",
      inputModalities: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 65536,
      reasoningEfforts: ["low", "medium", "high"],
      available: true,
    },
  ]);
  await settings.setEnabledModelIds(["gemini-3.8-flash", "gemini-4-carbon-disabled", "gemini-4-carbon"]);

  stubCatalogFetch(t, {
    pro: { "gemini-3.8-flash-low": {}, "gemini-4-carbon-disabled": CARBON_DISABLED },
  });
  await fetchQuotaForAccount(account, pool, settings);

  const stored = await settings.read();
  assert.deepEqual(stored.enabledModelIds, ["gemini-3.8-flash"]);
  assert.equal(stored.catalogModels.some((model) => model.id === "gemini-4-carbon-disabled"), false);
  const carbon = stored.catalogModels.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.equal(stored.enabledModelIds.includes("gemini-4-carbon"), false);
});

test("a payload with only the disabled carbon placeholder enables nothing", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("pro");
  stubCatalogFetch(t, { pro: { "gemini-4-carbon-disabled": CARBON_DISABLED } });
  const quota = await fetchQuotaForAccount(account, pool, settings);

  // The disabled entity is not a quota row and not availability evidence.
  assert.deepEqual(quota.models, []);
  const stored = await settings.read();
  assert.deepEqual(stored.enabledModelIds, []);
  const carbon = stored.catalogModels.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.match(carbon.unavailableReason, /Ultra plan subscribers/);
  assert.equal(stored.catalogModels.some((model) => model.id === "gemini-4-carbon-disabled"), false);
});

test("an Ultra account that serves carbon entities gets Carbon enabled and routable", async (t) => {
  const { pool, settings, addAccount } = await setup(t);
  const account = await addAccount("ultra");
  stubCatalogFetch(t, {
    ultra: {
      "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
    },
  });
  await fetchQuotaForAccount(account, pool, settings);

  const stored = await settings.read();
  const carbon = stored.catalogModels.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, true);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);
  assert.ok(stored.enabledModelIds.includes("gemini-4-carbon"));
  // Per-level entities are folded into the base model, never raw rows.
  assert.equal(stored.catalogModels.some((model) => model.id.startsWith("gemini-4-carbon-")), false);
});
