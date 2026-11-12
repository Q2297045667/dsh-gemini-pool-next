import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { FileModelSettingsStore, parseCatalogModels, registerWebApi } from "../lib/index.js";
import { AccountPoolManager } from "../lib/pool.js";

const ACCESS_TOKEN = "ya29.fake-web-api-access-token";
const REFRESH_TOKEN = "1/fake_web_api_refresh_token_123456789";

async function createApi(t, { accountCount = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-web-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const poolFile = join(dir, "accounts.json");
  const settingsFile = join(dir, "settings.json");
  const legacyFile = join(dir, "legacy.json");
  const pool = new AccountPoolManager(poolFile, legacyFile);
  const settings = new FileModelSettingsStore(settingsFile);
  for (let index = 0; index < accountCount; index += 1) {
    await pool.addOrUpdateAccount({
      email: `web-${index}@example.com`,
      refresh: `${REFRESH_TOKEN}_${index}`,
      access: `${ACCESS_TOKEN}-${index}`,
      expires: Date.now() + 3600000,
      projectId: `web-project-${index}`,
    });
  }

  let definition;
  let rejection;
  const events = [];
  const admittedRequests = [];
  const ctx = {
    emit: (event) => events.push(event),
    inject(_services, callback) {
      callback({
        effect: (register) => register(),
        webServer: {
          register(value) {
            definition = value;
            return () => {};
          },
        },
        connection: {
          admit(request) {
            admittedRequests.push(request);
            return rejection ? { rejection } : {};
          },
        },
      });
    },
  };
  registerWebApi(ctx, pool, settings);
  assert.equal(definition.path, "/antigravity-pool-next/api");

  async function request(path = "status", { method = "GET", body, raw, chunks } = {}) {
    const payload = raw ?? (body === undefined ? "" : JSON.stringify(body));
    const req = Readable.from(chunks ?? (payload ? [Buffer.from(payload)] : []));
    req.method = method;
    req.url = `/antigravity-pool-next/api${path ? `/${path}` : ""}`;
    req.headers = { host: "dsh.local" };
    const result = { status: 0, headers: {}, text: "" };
    const response = {
      writeHead(status, headers = {}) {
        result.status = status;
        result.headers = headers;
      },
      end(text = "") {
        result.text = text;
      },
    };
    await definition.handler(req, response);
    result.body = result.headers["content-type"]?.startsWith("application/json")
      ? JSON.parse(result.text)
      : undefined;
    return result;
  }

  return {
    pool, settings, poolFile, settingsFile, legacyFile, request, events, admittedRequests,
    reject: (status) => { rejection = status; },
  };
}

function assertNoTokens(result) {
  assert.equal(result.text.includes(ACCESS_TOKEN), false, "access tokens must stay out of API responses");
  assert.equal(result.text.includes(REFRESH_TOKEN), false, "refresh tokens must stay out of API responses");
}

test("status and model settings expose usable state without account credentials", async (t) => {
  const api = await createApi(t);
  const status = await api.request();
  assert.equal(status.status, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(status.body.value.accounts.length, 2);
  assert.equal(status.body.value.accounts[0].email, "web-0@example.com");
  assertNoTokens(status);
  assert.deepEqual((await api.request("")).body, status.body);

  const enabledModelIds = ["gemini-3.8-flash", "claude-sonnet-5.5"];
  const updated = await api.request("models", { method: "POST", body: { enabledModelIds } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.value.enabledModelIds, enabledModelIds);
  const models = await api.request("models");
  assert.deepEqual(models.body, updated.body);
  assert.equal(models.body.value.options.find((model) => model.id === enabledModelIds[0]).enabled, true);
  assert.equal(models.body.value.options.find((model) => model.id === "gemini-4-argon").enabled, false);
  assert.deepEqual((await new FileModelSettingsStore(api.settingsFile).read()).enabledModelIds, enabledModelIds);
  assert.ok(api.events.includes("llm/adapters-updated"));
});

test("the model API explains unavailable Carbon and never lists the disabled entity", async (t) => {
  const api = await createApi(t);
  await api.settings.setCatalogModels(parseCatalogModels({
    models: {
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
      "gemini-4-carbon-disabled": {
        displayName: "Gemini 4 Carbon",
        supportsImages: true,
        supportsThinking: true,
        maxTokens: 1048576,
        maxOutputTokens: 262144,
        disabled: true,
        tagTitle: "Unavailable",
        tagDescription: "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
        thinkingLevel: 2,
      },
    },
  }));
  const models = (await api.request("models")).body.value;
  const carbon = models.options.find((model) => model.id === "gemini-4-carbon");
  assert.ok(carbon, "Carbon stays listed so the card can explain why it is unavailable");
  assert.equal(carbon.available, false);
  assert.equal(carbon.enabled, false);
  assert.match(carbon.unavailableReason, /Ultra plan subscribers/);
  assert.match(carbon.description, /Ultra/i);
  assert.equal(models.options.some((model) => model.id.includes("-disabled")), false);
  assert.equal(models.enabledModelIds.includes("gemini-4-carbon"), false);
  assert.equal(models.enabledModelIds.includes("gemini-4-carbon-disabled"), false);
  // Other models keep displaying normally.
  assert.equal(models.options.find((model) => model.id === "gemini-4-argon").available, false);
  assert.equal(models.options.find((model) => model.id === "gemini-3.8-flash").available, true);
});

test("a catalog saved with the raw disabled id never exposes it as a selectable model", async (t) => {
  const api = await createApi(t);
  // Exactly what the buggy version persisted before the fix.
  await api.settings.setCatalogModels([
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
  await api.settings.setEnabledModelIds(["gemini-4-carbon-disabled"]);
  const models = (await api.request("models")).body.value;
  assert.equal(models.options.some((model) => model.id === "gemini-4-carbon-disabled"), false);
  assert.equal(models.enabledModelIds.includes("gemini-4-carbon-disabled"), false);
  // The picker falls back to the static catalog when the stored one was only
  // the stale placeholder, and the residual selection is not exposed as usable.
  const carbon = models.options.find((model) => model.id === "gemini-4-carbon");
  assert.ok(carbon);
  assert.equal(carbon.available, false);
  assert.equal(models.options.find((model) => model.id === "gemini-4-carbon-disabled"), undefined);
  assertNoTokens(await api.request());
});

test("config, primary selection, enable, removal, and logout persist across reload", async (t) => {
  const api = await createApi(t);
  const [first, second] = api.pool.allAccounts;
  const config = { schedulingMode: "manual", activeAccountId: second.id, visionEnabled: false, visionModel: "gemini-3.8-flash", cooldownMs: 2000 };
  const configured = await api.request("config", { method: "POST", body: config });
  assert.equal(configured.status, 200);
  for (const [key, value] of Object.entries(config)) assert.equal(configured.body.value[key], value);
  const primary = await api.request("accounts/set-primary", { method: "POST", body: { id: second.id } });
  assert.deepEqual(primary.body.value.accounts.map((account) => account.isPrimary), [false, true]);

  await api.pool.updateConfig({ disableThreshold: 1 });
  await api.pool.markCooldown(second.id, 60000, "rate limited");
  const enabled = await api.request("accounts/enable", { method: "POST", body: { id: second.id } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.value.accounts[1].status, "active");
  assert.equal(enabled.body.value.accounts[1].failureCount, 0);
  assert.equal(enabled.body.value.accounts[1].inCooldown, false);
  assertNoTokens(enabled);

  const removed = await api.request("accounts/remove", { method: "POST", body: { id: first.id } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.value.accounts.map((account) => account.id), [second.id]);
  const reloaded = new AccountPoolManager(api.poolFile, api.legacyFile);
  assert.deepEqual((await reloaded.getStatus()).accounts.map((account) => account.id), [second.id]);
  assert.equal(reloaded.visionEnabled, false);
  assert.equal(reloaded.visionModel, config.visionModel);

  const loggedOut = await api.request("logout", { method: "POST" });
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(loggedOut.body.value.accounts, []);
  assert.equal(loggedOut.body.value.activeAccountId, null);
  assert.deepEqual((await new AccountPoolManager(api.poolFile, api.legacyFile).getStatus()).accounts, []);
});

test("quota refresh updates all accounts concurrently and survives a new manager", async (t) => {
  const api = await createApi(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const refreshedTokens = new Set();
  globalThis.fetch = async (url, init) => {
    const token = init.headers.Authorization;
    const remaining = token.endsWith("-0") ? 0.2 : 0.8;
    let body;
    if (String(url).includes(":loadCodeAssist")) {
      body = { currentTier: { id: "pro", name: "Pro" } };
    } else if (String(url).includes(":retrieveUserQuotaSummary")) {
      refreshedTokens.add(token);
      body = { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "weekly", displayName: "Weekly", remainingFraction: remaining }] }] };
    } else if (String(url).includes(":fetchAvailableModels")) {
      body = { models: { "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", quotaInfo: { remainingFraction: remaining } } } };
    } else {
      throw new Error(`unexpected offline request: ${url}`);
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };

  const response = await api.request("quota", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(refreshedTokens.size, 2);
  assert.deepEqual(response.body.value.accounts.map((account) => account.quota.groups[0].buckets[0].remainingFraction), [0.2, 0.8]);
  const bestModel = response.body.value.models.options.find((model) => model.id === "gemini-3.8-flash");
  assert.equal(bestModel.remainingFraction, 0.8);
  assertNoTokens(response);
  const reloaded = new AccountPoolManager(api.poolFile, api.legacyFile);
  assert.deepEqual((await reloaded.getStatus()).accounts.map((account) => account.quota.groups[0].buckets[0].remainingFraction), [0.2, 0.8]);
  assert.equal((await api.request("quota")).status, 200);
});

test("host admission rejects unauthorized and forbidden requests before mutations", async (t) => {
  const api = await createApi(t);
  const before = await readFile(api.poolFile, "utf8");
  for (const status of [401, 403]) {
    api.reject(status);
    const response = await api.request("logout", { method: "POST" });
    assert.equal(response.status, status);
    assert.equal(response.text, status === 401 ? "unauthorized" : "forbidden");
    assert.equal(await readFile(api.poolFile, "utf8"), before);
  }
  assert.equal(api.admittedRequests.length, 2);
  assert.equal(api.events.length, 0);
});

test("routes enforce method limits, required fields, and unknown paths", async (t) => {
  const api = await createApi(t, { accountCount: 0 });
  for (const path of ["status", "", "doctor", "login", "quota", "accounts/remove", "accounts/set-primary", "accounts/enable", "config", "models", "logout"]) {
    const response = await api.request(path, { method: "DELETE" });
    assert.equal(response.status, 405, path);
    assert.equal(response.body.error, "method-not-allowed");
  }
  for (const path of ["accounts/remove", "accounts/set-primary", "accounts/enable"]) {
    assert.equal((await api.request(path, { method: "POST", body: {} })).status, 400, path);
  }
  assert.equal((await api.request("models", { method: "POST", body: { enabledModelIds: "bad" } })).status, 400);
  assert.equal((await api.request("missing")).status, 404);
  const doctor = await api.request("doctor");
  assert.equal(doctor.status, 200);
  assert.match(doctor.body.value, /transport=native-cloud-code-assist-sse/);
  assertNoTokens(doctor);
});

test("malformed JSON is rejected with 400 and oversized bodies with 413 without state changes", async (t) => {
  const api = await createApi(t);
  const before = await readFile(api.poolFile, "utf8");
  for (const raw of ["{", "null", "[]", '"text"']) {
    const response = await api.request("config", { method: "POST", raw });
    assert.equal(response.status, 400, raw);
    assert.equal(response.body.ok, false);
  }
  const oversized = await api.request("config", {
    method: "POST",
    chunks: [Buffer.alloc(1024 * 1024, " "), Buffer.alloc(1024 * 1024 + 1, " ")],
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.ok, false);
  assert.equal(await readFile(api.poolFile, "utf8"), before);
});

test("status redacts persisted and newly recorded cooldown errors", async (t) => {
  const api = await createApi(t);
  const id = api.pool.allAccounts[0].id;
  await api.pool.markCooldown(id, 1000, `429 Bearer ${ACCESS_TOKEN}; refresh_token="${REFRESH_TOKEN}"`);
  const fresh = await api.request();
  assert.equal(fresh.status, 200);
  assertNoTokens(fresh);
  assert.match(fresh.body.value.accounts[0].lastError, /redacted/);
  const saved = await readFile(api.poolFile, "utf8");
  assert.equal(JSON.parse(saved).accounts[0].lastError.includes(ACCESS_TOKEN), false);

  const raw = JSON.parse(saved);
  raw.accounts[0].lastError = `429 Bearer ${ACCESS_TOKEN}`;
  await writeFile(api.poolFile, JSON.stringify(raw));
  const reloaded = new AccountPoolManager(api.poolFile, api.legacyFile);
  assert.equal(JSON.stringify(await reloaded.getStatus()).includes(ACCESS_TOKEN), false);
});

test("unexpected storage failures return a redacted 500 response", async (t) => {
  const api = await createApi(t);
  await writeFile(api.settingsFile, `invalid JSON ${ACCESS_TOKEN}`);
  const response = await api.request();
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assertNoTokens(response);
});
