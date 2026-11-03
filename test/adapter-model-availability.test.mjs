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
