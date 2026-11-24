import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { AntigravityPoolAdapter } from "../lib/index.js";

const SSE = (...lines) => lines.map((l) => `data: ${l}\n\n`).join("");

function textChunk(text) {
  return JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }] } }],
    },
  });
}

function sseResponse(body, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function modelSettings(overrides = {}) {
  return {
    async read() {
      return {
        catalogModels: [],
        enabledModelIds: [],
        ...overrides,
      };
    },
  };
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-image-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function addAccount(manager, email) {
  await manager.addOrUpdateAccount({
    email,
    refresh: `refresh_${email}`,
    access: `access_${email}`,
    expires: Date.now() + 3600_000,
    projectId: "test-project",
  });
  return (await manager.getStatus()).accounts.find((a) => a.email === email).id;
}

test("readImageRequest receives a target in the host's current ImageRequestTarget shape", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "imgtest@example.com");

    let receivedTarget = null;
    const fakeAttachments = {
      async readImageRequest(ref, target) {
        receivedTarget = target;
        return {
          mediaType: "image/png",
          data: Buffer.from("fake-png-bytes"),
          width: target.width,
          height: target.height,
        };
      },
    };

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => fakeAttachments);

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:abc123def456",
              mediaType: "image/png",
              bytes: 302454,
              width: 1920,
              height: 1027,
              name: "test.png",
            },
          },
        ],
      },
    ];

    await withStubbedFetch(
      async () => sseResponse(SSE(textChunk("Got image"))),
      async () => {
        const chunks = [];
        for await (const chunk of adapter.stream({ model: "gemini-2.5-flash", messages })) {
          chunks.push(chunk);
        }
        assert.ok(chunks.length > 0);
      },
    );

    assert.ok(receivedTarget !== null, "readImageRequest should have been called");
    assert.ok(Number.isSafeInteger(receivedTarget.width) && receivedTarget.width > 0, "width must be positive int");
    assert.ok(Number.isSafeInteger(receivedTarget.height) && receivedTarget.height > 0, "height must be positive int");
    // DSH 0.2.2-rc.5 replaced the single `maxBytes` soft target with a hard
    // `maxImageBytes` limit plus a preferred `imageTargetBytes`; the attachment
    // store rejects a target that omits either one (INVALID_ATTACHMENT_REF
    // "Image request maxImageBytes must be a positive integer"), which made
    // every image-bearing request fail.
    assert.ok(
      Number.isSafeInteger(receivedTarget.maxImageBytes) && receivedTarget.maxImageBytes > 0,
      "maxImageBytes must be positive int",
    );
    assert.ok(
      Number.isSafeInteger(receivedTarget.imageTargetBytes) && receivedTarget.imageTargetBytes > 0,
      "imageTargetBytes must be positive int",
    );
    assert.ok(
      receivedTarget.imageTargetBytes <= receivedTarget.maxImageBytes,
      "imageTargetBytes must not exceed maxImageBytes",
    );
    assert.equal(receivedTarget.maxBytes, undefined, "the retired maxBytes field must not be sent");
    assert.equal(receivedTarget.width, 1920);
    assert.equal(receivedTarget.height, 1027);
  } finally {
    await cleanup();
  }
});

/**
 * The target above is only useful if the store accepts it, so this pins the
 * exact admission rule the host's attachment store applies before it encodes
 * anything (`validateTarget` in @deepseek-ai/dsh-attachment-local): both byte
 * fields must be positive safe integers and the preferred target may not
 * exceed the hard limit. Keeping the rule here means the shape regression is
 * caught even when this plugin is tested without a live host tree.
 */
test("the built target satisfies the host's attachment-store admission rule", async () => {
  const checkedInteger = (value) => Number.isSafeInteger(value) && value > 0;
  const accepted = (target) =>
    checkedInteger(target.width) &&
    checkedInteger(target.height) &&
    checkedInteger(target.maxImageBytes) &&
    checkedInteger(target.imageTargetBytes) &&
    target.imageTargetBytes <= target.maxImageBytes;

  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "admission@example.com");
    let receivedTarget = null;
    const fakeAttachments = {
      async readImageRequest(ref, target) {
        receivedTarget = target;
        return { mediaType: "image/png", data: Buffer.from("png"), width: target.width, height: target.height };
      },
    };
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => fakeAttachments);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:admission",
              mediaType: "image/png",
              bytes: 4096,
              width: 4000,
              height: 3000,
            },
          },
        ],
      },
    ];
    await withStubbedFetch(
      async () => sseResponse(SSE(textChunk("ok"))),
      async () => {
        for await (const _chunk of adapter.stream({ model: "gemini-2.5-flash", messages })) {
          // drain
        }
      },
    );
    assert.ok(receivedTarget !== null);
    assert.ok(
      accepted(receivedTarget),
      `the attachment store would refuse this target: ${JSON.stringify(receivedTarget)}`,
    );
    // Oversized sources are projected down, so the accepted target is bounded.
    assert.ok(receivedTarget.width * receivedTarget.height <= 2048 * 2048);
  } finally {
    await cleanup();
  }
});

// Architecture guard (Codex review false-positive pin): the vision bridge and
// the host's text-model projection are supposed to keep image blocks away
// from this check. If a future refactor lets them through, this must fail
// loudly instead of silently changing behavior.
test("text-only model with image content still raises UNSUPPORTED_CONTENT", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "guard@example.com");
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    const iterator = adapter.stream({
      model: "gpt-oss-120b",
      messages: [
        { role: "user", content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] },
      ],
    });
    await assert.rejects(() => iterator.next(), /UNSUPPORTED_CONTENT|does not support image/i);
  } finally {
    await cleanup();
  }
});
