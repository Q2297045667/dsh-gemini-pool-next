import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolManager } from "../lib/pool.js";
import {
  AntigravityPoolAdapter,
  FileModelSettingsStore,
  generateImageThroughPool,
  parseCatalogModels,
  requestVisionThroughPool,
} from "../lib/index.js";

const TEXT_MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";

async function setup(t, kind) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-model-availability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  const settings = new FileModelSettingsStore(join(dir, "models.json"));
  await pool.init();
  await pool.updateConfig({ schedulingMode: "primary-backup" });
  await settings.write({
    catalogModels: parseCatalogModels({ models: { "gemini-3.8-flash-low": {}, [IMAGE_MODEL]: {} } }),
    enabledModelIds: [TEXT_MODEL, IMAGE_MODEL],
  });
  const modelId = kind === "image" ? IMAGE_MODEL : TEXT_MODEL;
  async function addAccount(name, available) {
    const email = `${name}@example.com`;
    await pool.addOrUpdateAccount({
      email,
      access: `access_${name}`,
      refresh: `refresh_${name}`,
      expires: Date.now() + 3600_000,
      projectId: `project-${name}`,
    });
    const account = pool.allAccounts.find((entry) => entry.email === email);
    if (available !== undefined) {
      await pool.updateAccountQuota(account.id, { catalogModels: [{ id: modelId, available }] }, "test-plan");
    }
    return account;
  }
  return { pool, settings, addAccount };
}

function stubGeneration(t, kind, streamResponse) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(String(url)).pathname;
    const token = new Headers(init?.headers).get("authorization");
    calls.push({ path, token });
    if (path.endsWith(":fetchAvailableModels")) {
      return Response.json({ models: { "gemini-3.8-flash-low": {}, [IMAGE_MODEL]: {} } });
    }
    assert.ok(path.endsWith(":streamGenerateContent"), `unexpected network request: ${path}`);
    if (streamResponse) return streamResponse(token);
    const part = kind === "image"
      ? { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }
      : { text: "response text" };
    return new Response(`data: ${JSON.stringify({ response: {
      candidates: [{ content: { parts: [part] }, finishReason: "STOP" }],
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return calls;
}

async function invoke(kind, pool, settings) {
  if (kind === "image") {
    const result = await generateImageThroughPool("Draw a small icon", pool, settings);
    assert.equal(result.base64, "aW1hZ2U=");
    return result;
  }
  if (kind === "vision") {
    const result = await requestVisionThroughPool("aW1hZ2U=", "image/png", "Describe this image", pool, settings);
    assert.equal(result.text, "response text");
    return result;
  }
  const chunks = [];
  for await (const chunk of new AntigravityPoolAdapter(pool, settings).stream({
    model: TEXT_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  })) chunks.push(chunk);
  assert.ok(chunks.some((chunk) => chunk.type === "finish"));
  return chunks;
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

/**
 * Pool + settings built from one synthetic fetchAvailableModels payload, with a
 * fetch stub that records every streamGenerateContent request body.
 */
let carbonCaseCounter = 0;

async function setupWithPayload(t, payload) {
  carbonCaseCounter += 1;
  const token = `access_carbon_${carbonCaseCounter}`;
  const projectId = `project-carbon-${carbonCaseCounter}`;
  const dir = await mkdtemp(join(tmpdir(), "gemini-carbon-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  const settings = new FileModelSettingsStore(join(dir, "models.json"));
  await pool.init();
  await pool.updateConfig({ schedulingMode: "primary-backup" });
  const catalogModels = parseCatalogModels({ models: payload });
  await settings.write({
    catalogModels,
    enabledModelIds: catalogModels.filter((model) => model.available).map((model) => model.id),
  });
  await pool.addOrUpdateAccount({
    email: "carbon@example.com",
    access: token,
    refresh: "refresh_carbon",
    expires: Date.now() + 3600_000,
    projectId,
  });
  const account = pool.allAccounts.find((entry) => entry.email === "carbon@example.com");
  await pool.updateAccountQuota(account.id, { catalogModels }, "Google AI Pro");

  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(":fetchAvailableModels")) return Response.json({ models: payload });
    assert.ok(path.endsWith(":streamGenerateContent"), `unexpected network request: ${path}`);
    requests.push(JSON.parse(init.body));
    const frame = {
      response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    };
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { pool, settings, adapter: new AntigravityPoolAdapter(pool, settings), requests, catalogModels };
}

async function streamModel(adapter, model, reasoningEffort) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    ...(reasoningEffort ? { reasoningEffort } : {}),
  })) chunks.push(chunk);
  return chunks;
}

test("a carbon request degrades instead of reaching the backend-disabled placeholder", async (t) => {
  const payload = {
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" },
    "gemini-4-carbon-disabled": CARBON_DISABLED,
  };
  const { adapter, requests, settings } = await setupWithPayload(t, payload);
  const carbon = (await settings.read()).catalogModels.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.match(carbon.unavailableReason, /Ultra plan subscribers/);

  const chunks = await streamModel(adapter, "gemini-4-carbon", "high");
  assert.ok(chunks.some((chunk) => chunk.type === "finish"));
  assert.equal(requests.length, 1);
  // The request is served by an advertised sibling, never by the placeholder.
  assert.equal(requests[0].model, "gemini-4-argon-high");
  assert.notEqual(requests[0].model, "gemini-4-carbon-disabled");
  // The substitute keeps its own 65536 ceiling, not Carbon's 262144.
  assert.equal(requests[0].request.generationConfig.maxOutputTokens, 65536);
});

test("once the backend advertises usable carbon entities the model routes per level", async (t) => {
  const payload = {
    "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)", maxTokens: 1048576, maxOutputTokens: 262144, thinkingLevel: 1 },
    "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144, thinkingLevel: 2 },
    "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576, maxOutputTokens: 262144, thinkingLevel: 3 },
  };
  const { adapter, requests, settings } = await setupWithPayload(t, payload);
  const carbon = (await settings.read()).catalogModels.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, true);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);

  await streamModel(adapter, "gemini-4-carbon", "high");
  await streamModel(adapter, "gemini-4-carbon", "low");
  await streamModel(adapter, "gemini-4-carbon", "medium");
  assert.deepEqual(
    requests.map((request) => request.model),
    ["gemini-4-carbon-high", "gemini-4-carbon-low", "gemini-4-carbon-medium"],
  );
  for (const request of requests) {
    // Each request carries Carbon's 262144 output ceiling…
    assert.equal(request.request.generationConfig.maxOutputTokens, 262144);
    // …and the per-level entity pins the level, so no thinkingConfig rides along.
    assert.equal(request.request.generationConfig.thinkingConfig, undefined);
  }
});

for (const kind of ["text", "image", "vision"]) {
  test(`${kind} requests skip an account known to lack the requested model`, async (t) => {
    const { pool, settings, addAccount } = await setup(t, kind);
    await addAccount("unavailable", false);
    await addAccount("available", true);
    const calls = stubGeneration(t, kind);
    await invoke(kind, pool, settings);
    assert.ok(calls.some((call) => call.path.endsWith(":streamGenerateContent")));
    assert.ok(calls.every((call) => call.token === "Bearer access_available"));
    assert.ok((await pool.getStatus()).accounts.every((account) => account.failureCount === 0));
  });

  test(`${kind} requests report EXHAUSTED when all selected accounts lack the model`, async (t) => {
    const { pool, settings, addAccount } = await setup(t, kind);
    await addAccount("unavailable", false);
    await addAccount("also-unavailable", false);
    const calls = stubGeneration(t, kind);
    await assert.rejects(() => invoke(kind, pool, settings), (error) => {
      assert.equal(error.code, "EXHAUSTED");
      return true;
    });
    assert.deepEqual(calls, []);
  });

  test(`${kind} requests still try accounts whose model availability is unknown`, async (t) => {
    const { pool, settings, addAccount } = await setup(t, kind);
    await addAccount("unknown");
    await addAccount("available", true);
    const calls = stubGeneration(t, kind);
    await invoke(kind, pool, settings);
    assert.ok(calls.some((call) => call.path.endsWith(":streamGenerateContent")));
    assert.ok(calls.every((call) => call.token === "Bearer access_unknown"));
  });

  test(`${kind} manual mode does not switch from a locked account that lacks the model`, async (t) => {
    const { pool, settings, addAccount } = await setup(t, kind);
    const locked = await addAccount("locked", false);
    await addAccount("available", true);
    await pool.updateConfig({ schedulingMode: "manual", activeAccountId: locked.id });
    const calls = stubGeneration(t, kind);
    await assert.rejects(() => invoke(kind, pool, settings), (error) => {
      assert.equal(error.code, "EXHAUSTED");
      return true;
    });
    assert.deepEqual(calls, []);
  });

  test(`${kind} manual mode does not fail over after a locked account reaches quota`, async (t) => {
    const { pool, settings, addAccount } = await setup(t, kind);
    const locked = await addAccount("locked", true);
    await addAccount("available", true);
    await pool.updateConfig({ schedulingMode: "manual", activeAccountId: locked.id });
    const calls = stubGeneration(t, kind, () => new Response("Individual quota reached", { status: 429 }));
    await assert.rejects(() => invoke(kind, pool, settings), /429|quota/i);
    assert.ok(calls.some((call) => call.path.endsWith(":streamGenerateContent")));
    assert.ok(calls.every((call) => call.token === "Bearer access_locked"));
    const status = await pool.getStatus();
    assert.equal(status.accounts.find((account) => account.id === locked.id).failureCount, 1);
  });
}
