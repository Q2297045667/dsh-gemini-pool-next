import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolManager } from "../lib/pool.js";
import { AntigravityPoolAdapter, FileModelSettingsStore, parseCatalogModels } from "../lib/index.js";

/**
 * The entities a paid (Google AI Pro) project advertises when the request
 * carries a current client fingerprint. With the outdated fingerprint this
 * plugin used to send, the same account only advertised 16 entities — no
 * Gemini 4 Argon and no per-level Gemini 3.8 siblings.
 */
const LIVE_MODELS = {
  "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)" },
  "claude-opus-5-5-low": { displayName: "Claude Opus 5.5 (Low)" },
  "claude-opus-5-5-medium": { displayName: "Claude Opus 5.5 (Medium)" },
  "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 (High)" },
  "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)" },
  "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)" },
  "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash" },
  "gemini-2.5-flash-lite": { displayName: "Gemini 2.5 Flash Lite" },
  "gemini-2.5-flash-thinking": { displayName: "Gemini 2.5 Flash Thinking" },
  "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
  "gemini-3-flash": { displayName: "Gemini 3 Flash" },
  "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
  "gemini-3.1-flash-lite": { displayName: "Gemini 3.1 Flash Lite" },
  "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite" },
  "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
  "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
  "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)" },
  "gemini-3.8-flash-tiered": {},
  "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" },
  "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)" },
  "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
  "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
};

const ENTITY_IDS = new Set(Object.keys(LIVE_MODELS));

let tokenCounter = 0;

async function setup(t, { entities = LIVE_MODELS, failFirst = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-live-routing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  const settings = new FileModelSettingsStore(join(dir, "models.json"));
  await pool.init();
  await pool.updateConfig({ schedulingMode: "primary-backup" });
  const catalogModels = parseCatalogModels({ models: entities });
  await settings.write({
    catalogModels,
    enabledModelIds: catalogModels.filter((model) => model.available).map((model) => model.id),
  });
  const token = `access_live_${tokenCounter += 1}`;
  await pool.addOrUpdateAccount({
    email: "live@example.com",
    access: token,
    refresh: "refresh_live",
    expires: Date.now() + 3600_000,
    projectId: "project-live",
  });
  const account = pool.allAccounts.find((entry) => entry.email === "live@example.com");
  await pool.updateAccountQuota(account.id, { catalogModels }, "Google AI Pro");

  const requests = [];
  const headers = [];
  let failRemaining = failFirst ? 1 : 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(String(url)).pathname;
    headers.push(new Headers(init?.headers));
    if (path.endsWith(":fetchAvailableModels")) return Response.json({ models: entities });
    assert.ok(path.endsWith(":streamGenerateContent"), `unexpected network request: ${path}`);
    requests.push(JSON.parse(init.body));
    if (failRemaining > 0) {
      failRemaining -= 1;
      return new Response("Requested entity was not found.", { status: 400 });
    }
    const frame = {
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      },
    };
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { pool, settings, adapter: new AntigravityPoolAdapter(pool, settings), requests, headers };
}

async function streamOnce(adapter, model, reasoningEffort) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...(reasoningEffort ? { reasoningEffort } : {}),
  })) chunks.push(chunk);
  return chunks;
}

test("the flagship resolves through its own per-level entities", async (t) => {
  const { adapter, requests } = await setup(t);
  await streamOnce(adapter, "gemini-4-argon", "high");
  await streamOnce(adapter, "gemini-4-argon", "low");
  assert.deepEqual(requests.map((request) => request.model), ["gemini-4-argon-high", "gemini-4-argon-low"]);
  // The id already pins the level, so no thinking options ride along.
  assert.equal(requests[0].request.generationConfig.thinkingConfig, undefined);
});

test("requests carry the client fingerprint the catalog gate requires", async (t) => {
  const { adapter, headers } = await setup(t);
  await streamOnce(adapter, "gemini-4-argon", "high");
  assert.ok(headers.length > 0);
  for (const header of headers) {
    // The host appends its own attribution entry after ours ("..., deepseek-
    // harness/x.y.z (+url)"), so assert the leading client fingerprint. The
    // backend still unlocks the full catalog with that suffix (verified).
    assert.match(
      header.get("user-agent"),
      /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=[a-z]+; arch=[a-z0-9]+; cl=\d+\)/,
    );
  }
});

test("a model no account serves degrades to an advertised model instead of failing", async (t) => {
  const { adapter, requests } = await setup(t);
  // Gemini 3.5 Flash is not in the backend catalog; the request must not be
  // sent for an entity that does not exist.
  const chunks = await streamOnce(adapter, "gemini-3.5-flash", "high");
  assert.ok(chunks.some((chunk) => chunk.type === "finish"));
  assert.equal(requests.length, 1);
  // The flagship is the best model the pool serves, so it is the substitute.
  assert.equal(requests[0].model, "gemini-4-argon-high");
  assert.ok(ENTITY_IDS.has(requests[0].model));
});

test("replay metadata keeps the requested model id when a substitute runs the turn", async (t) => {
  const { adapter } = await setup(t);
  const chunks = await streamOnce(adapter, "gemini-3.5-flash", "high");
  const finish = chunks.find((chunk) => chunk.type === "finish");
  // The host stamps the assistant message with the requested id, so replay
  // metadata has to agree or the next turn loses every thought signature.
  assert.equal(finish.replayState.model, "gemini-3.5-flash");
  assert.equal(finish.replayState.runtimeModel, "gemini-4-argon-high");
});

test("no request ever names an entity the account does not advertise", async (t) => {
  const { adapter, requests } = await setup(t);
  for (const model of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-pro"]) {
    await streamOnce(adapter, model, "high");
    await streamOnce(adapter, model, "low");
  }
  assert.ok(requests.length >= 8);
  for (const request of requests) {
    assert.ok(ENTITY_IDS.has(request.model), `request sent unknown entity ${request.model}`);
  }
});

test("thinking effort selects the per-level entity the account advertises", async (t) => {
  const { adapter, requests } = await setup(t);
  await streamOnce(adapter, "claude-opus-5.5", "low");
  await streamOnce(adapter, "claude-opus-5.5", "medium");
  await streamOnce(adapter, "claude-sonnet-5.5", "high");
  assert.deepEqual(requests.map((request) => request.model), [
    "claude-opus-5-5-low",
    "claude-opus-5-5-medium",
    "claude-sonnet-5-5-high",
  ]);
  // Anthropic entities carry their level in the id and reject thinkingConfig.
  assert.equal(requests[0].request.generationConfig.thinkingConfig, undefined);
});

test("a tiered entity steps down a thinking level when the backend rejects one", async (t) => {
  // Older fingerprints only expose the tiered entity; it selects its level
  // through thinkingConfig, so a rejected level must step down, not fail.
  const { adapter, requests } = await setup(t, {
    entities: { "gemini-3.8-flash-tiered": {} },
    failFirst: true,
  });
  const chunks = await streamOnce(adapter, "gemini-3.8-flash", "high");
  assert.ok(chunks.some((chunk) => chunk.type === "finish"));
  assert.deepEqual(requests.map((request) => request.model), [
    "gemini-3.8-flash-tiered",
    "gemini-3.8-flash-tiered",
  ]);
  assert.deepEqual(
    requests.map((request) => request.request.generationConfig.thinkingConfig.thinkingLevel),
    ["HIGH", "MEDIUM"],
  );
});

test("a pool without the requested family serves the closest line instead of erroring", async (t) => {
  const { adapter, requests } = await setup(t, { entities: { "gemini-3.8-flash-tiered": {}, "gemini-3-flash": {} } });
  await streamOnce(adapter, "gpt-oss-120b", "medium");
  assert.equal(requests[0].model, "gemini-3.8-flash-tiered");
  assert.equal(requests[0].request.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");
});

test("image generation never degrades onto a text model", async (t) => {
  const { adapter } = await setup(t, { entities: { "gemini-3-flash": {}, "gemini-3.8-flash-tiered": {} } });
  await assert.rejects(
    () => streamOnce(adapter, "gemini-3.1-flash-image"),
    (error) => error.code === "EXHAUSTED",
  );
});

test("the catalog offers exactly the thinking levels the account can pin", async (t) => {
  const { settings } = await setup(t);
  const catalog = new Map((await settings.read()).catalogModels.map((model) => [model.id, model]));
  assert.deepEqual(catalog.get("claude-opus-5.5").reasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(catalog.get("gemini-4-argon").reasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(catalog.get("gemini-3.8-flash").reasoningEfforts, ["minimal", "low", "medium", "high"]);
  assert.equal(catalog.get("gemini-4-argon").available, true);
  assert.equal(catalog.get("gemini-3.8-flash").available, true);
  // Models the backend does not advertise stay unavailable and get pruned.
  assert.equal(catalog.get("gemini-3.5-flash").available, false);
  assert.equal(catalog.get("gemini-3.5-flash-lite").available, true);
});
