import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateImageThroughPool } from "../lib/index.js";
import { AccountPoolManager } from "../lib/pool.js";

const settings = { read: async () => ({ catalogModels: [], enabledModelIds: [] }) };
const imageFrame = (mimeType = "image/png") => ({
  response: { candidates: [{ content: { parts: [{ inlineData: { mimeType, data: "QUJD" } }] } }] },
});

async function setup(t, count = 1) {
  const dir = await mkdtemp(join(tmpdir(), "image-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await pool.init();
  for (let i = 0; i < count; i++) {
    await pool.addOrUpdateAccount({
      email: `image${i}@example.com`,
      access: `access_${i}`,
      refresh: `refresh_${i}`,
      expires: Date.now() + 3600_000,
      projectId: "image-test-project",
    });
  }
  return pool;
}

async function withStreamFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).includes("cloudcode"), "all requests must use the stubbed Google transport");
    return String(url).includes("fetchAvailableModels")
      ? new Response("{}", { headers: { "content-type": "application/json" } })
      : handler(url, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const sse = (frame) => new Response(`data: ${JSON.stringify(frame)}\n\n`, {
  headers: { "content-type": "text/event-stream" },
});

test("image SSE quota errors cool the account down and fail over to the next account", async (t) => {
  const pool = await setup(t, 2);
  const usedTokens = [];
  await withStreamFetch(
    (url, init) => {
      const token = init.headers.Authorization;
      usedTokens.push(token);
      return token.includes("access_0")
        ? sse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests" } })
        : sse(imageFrame());
    },
    async () => {
      const result = await generateImageThroughPool("a square", pool, settings);
      assert.equal(result.accountEmail, "image1@example.com");
      assert.equal(result.base64, "QUJD");
      assert.equal(usedTokens.length, 2);
      const status = await pool.getStatus();
      assert.equal(status.accounts.find((a) => a.email === "image0@example.com").inCooldown, true);
    },
  );
});

test("nested image SSE errors are surfaced instead of becoming missing image data", async (t) => {
  const pool = await setup(t);
  await withStreamFetch(
    () => sse({ response: { error: { message: "400 invalid request: missing prompt" } } }),
    () => assert.rejects(() => generateImageThroughPool("x", pool, settings), /400 invalid request: missing prompt/),
  );
});

test("image SSE accepts data fields without a space and a final frame without a newline", async (t) => {
  const pool = await setup(t);
  await withStreamFetch(
    () => new Response(`data:${JSON.stringify(imageFrame("image/webp"))}`, {
      headers: { "content-type": "text/event-stream" },
    }),
    async () => {
      const result = await generateImageThroughPool("x", pool, settings);
      assert.equal(result.base64, "QUJD");
      assert.equal(result.mimeType, "image/webp");
    },
  );
});

test("returning the generated image cancels the remaining response stream", async (t) => {
  const pool = await setup(t);
  let cancelled = false;
  await withStreamFetch(
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data:${JSON.stringify(imageFrame())}\n\n`));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }),
    async () => {
      await generateImageThroughPool("x", pool, settings);
      assert.equal(cancelled, true);
    },
  );
});

test("generated MIME types are returned and unsupported image formats are rejected", async (t) => {
  const pool = await setup(t);
  for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
    await withStreamFetch(
      () => sse(imageFrame(mimeType)),
      async () => assert.equal((await generateImageThroughPool("x", pool, settings)).mimeType, mimeType),
    );
  }
  await withStreamFetch(
    () => sse(imageFrame("image/svg+xml")),
    () => assert.rejects(() => generateImageThroughPool("x", pool, settings), /unsupported image mime type/i),
  );
});

test("image HTTP 400 and 401 errors do not retry other endpoints", async (t) => {
  const pool = await setup(t);
  for (const status of [400, 401]) {
    let calls = 0;
    await withStreamFetch(
      () => { calls++; return new Response("request rejected", { status }); },
      async () => {
        await assert.rejects(() => generateImageThroughPool("x", pool, settings), new RegExp(`Google API ${status}`));
        assert.equal(calls, 1);
      },
    );
  }
});
