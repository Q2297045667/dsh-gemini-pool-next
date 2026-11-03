import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { createVisionTool, resolveImageInput } from "../lib/vision-tool.js";
import { requestVisionThroughPool, resolveVisionModelId } from "../lib/index.js";

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
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-vision-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    dir,
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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const HASH_PREFIX = "ab12cd34";
// 64-hex object name whose prefix is HASH_PREFIX.
const HASH_FULL = "ab12cd34" + "ef567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

async function makeAttachmentsRoot() {
  const dir = await mkdtemp(join(tmpdir(), "vision-attachments-"));
  const bucket = join(dir, HASH_PREFIX.slice(0, 2));
  await mkdir(bucket, { recursive: true });
  const padding = Buffer.alloc(32, 7);
  await writeFile(join(bucket, HASH_FULL), Buffer.concat([PNG_MAGIC, padding]));
  return { root: dir, bucket, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("resolveImageInput finds the unique attachment object for a hash prefix", async (t) => {
  const { root, bucket, cleanup } = await makeAttachmentsRoot();
  t.after(cleanup);
  const { base64, mimeType } = await resolveImageInput(HASH_PREFIX, { attachmentsRoot: root });
  assert.equal(mimeType, "image/png");
  const decoded = Buffer.from(base64, "base64");
  assert.deepEqual([...decoded.subarray(0, 8)], [...PNG_MAGIC]);
  // The sha256: form resolves to the same object.
  const viaSha = await resolveImageInput(`sha256:${HASH_PREFIX}`, { attachmentsRoot: root });
  assert.equal(viaSha.base64, base64);
  // Lookup is case-insensitive on the prefix.
  const upper = await resolveImageInput(HASH_PREFIX.toUpperCase(), { attachmentsRoot: root });
  assert.equal(upper.base64, base64);
  // Mime type is sniffed from content: attachment objects carry no extension.
  const jpegName = "ff12cd34" + "ef567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const jpegBucket = join(root, "ff");
  await mkdir(jpegBucket, { recursive: true });
  await writeFile(join(jpegBucket, jpegName), JPEG_MAGIC);
  const viaJpeg = await resolveImageInput("ff12cd34", { attachmentsRoot: root });
  assert.equal(viaJpeg.mimeType, "image/jpeg");
});

test("resolveImageInput rejects 0-hit and ambiguous hash prefixes with distinct errors", async (t) => {
  const { root, bucket, cleanup } = await makeAttachmentsRoot();
  t.after(cleanup);
  await assert.rejects(
    () => resolveImageInput("ffffffff", { attachmentsRoot: root }),
    /No attachment .*ffffffff/i,
  );
  // A second object sharing the prefix makes the lookup ambiguous.
  await writeFile(join(bucket, HASH_FULL.slice(0, 16) + "99"), Buffer.from("x"));
  await assert.rejects(
    () => resolveImageInput(HASH_PREFIX, { attachmentsRoot: root }),
    /ambiguous/i,
  );
});

test("resolveImageInput parses data: URLs into mime type and base64 payload", async () => {
  const { base64, mimeType } = await resolveImageInput("data:image/webp;base64,QUJD");
  assert.equal(mimeType, "image/webp");
  assert.equal(Buffer.from(base64, "base64").toString(), "ABC");
  await assert.rejects(() => resolveImageInput("data:image/webp,QUJD"), /Invalid data: URL/);
});

test("resolveImageInput reads local files confined to the workspace", async (t) => {
  // Inside the workspace: absolute and cwd-relative references both work.
  const localDir = await mkdtemp(join(process.cwd(), "test", "vision-tmp-"));
  t.after(() => rm(localDir, { recursive: true, force: true }));
  const file = join(localDir, "shot.png");
  await writeFile(file, PNG_MAGIC);
  const absolute = await resolveImageInput(file, { attachmentsRoot: "unused" });
  assert.equal(absolute.mimeType, "image/png");
  const relResult = await resolveImageInput(relative(process.cwd(), file), { attachmentsRoot: "unused" });
  assert.equal(relResult.base64, absolute.base64);
  await assert.rejects(() => resolveImageInput(join(localDir, "missing.png"), { attachmentsRoot: "unused" }), /not found/i);
  // Content sniffing wins over the file extension (jpeg bytes, .png name).
  const sniffDir = await mkdtemp(join(process.cwd(), "test", "vision-tmp-"));
  t.after(() => rm(sniffDir, { recursive: true, force: true }));
  const mislabeled = join(sniffDir, "photo.png");
  await writeFile(mislabeled, JPEG_MAGIC);
  const sniffed = await resolveImageInput(mislabeled, { attachmentsRoot: "unused" });
  assert.equal(sniffed.mimeType, "image/jpeg");
});

test("resolveImageInput refuses local paths escaping the workspace (arbitrary file read)", async (t) => {
  // Relative traversal out of the workspace.
  await assert.rejects(
    () => resolveImageInput("../../outside.png", { attachmentsRoot: "unused" }),
    /inside the workspace/i,
  );
  // Absolute path outside the workspace (os tmpdir lives elsewhere).
  const outsideDir = await mkdtemp(join(tmpdir(), "vision-escape-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsideFile = join(outsideDir, "secret.png");
  await writeFile(outsideFile, PNG_MAGIC);
  await assert.rejects(
    () => resolveImageInput(outsideFile, { attachmentsRoot: "unused" }),
    /inside the workspace/i,
  );
  // Traversal hidden inside a workspace-relative prefix is still an escape.
  await assert.rejects(
    () => resolveImageInput(join("test", "..", "..", "..", "secret.png"), { attachmentsRoot: "unused" }),
    /inside the workspace/i,
  );
});

test("resolveImageInput refuses workspace symlinks to files outside allowed roots", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "vision-symlink-outside-"));
  const inside = await mkdtemp(join(process.cwd(), "test", "vision-symlink-"));
  t.after(() => Promise.all([rm(outside, { recursive: true, force: true }), rm(inside, { recursive: true, force: true })]));
  const secret = join(outside, "secret.png");
  await writeFile(secret, PNG_MAGIC);
  const link = join(inside, "picture.png");
  await symlink(secret, link);
  await assert.rejects(() => resolveImageInput(link), /inside the workspace/i);
});

test("resolveImageInput refuses attachment objects symlinked outside the store", async (t) => {
  const { root, bucket, cleanup } = await makeAttachmentsRoot();
  const outside = await mkdtemp(join(tmpdir(), "vision-object-outside-"));
  t.after(() => Promise.all([cleanup(), rm(outside, { recursive: true, force: true })]));
  const secret = join(outside, "secret.png");
  await writeFile(secret, PNG_MAGIC);
  await rm(join(bucket, HASH_FULL));
  await symlink(secret, join(bucket, HASH_FULL));
  await assert.rejects(() => resolveImageInput(HASH_PREFIX, { attachmentsRoot: root }), /attachments store/i);
});

test("resolveImageInput refuses non-public http(s) URL targets (SSRF guard)", async () => {
  // Full URL fetch coverage lives in test/vision-url.test.mjs; this stays as
  // the minimal boundary check on the shared resolver. localhost resolves
  // locally, so no network is involved.
  await assert.rejects(
    () => resolveImageInput("http://localhost/secret", { attachmentsRoot: "unused" }),
    /non-public address/i,
  );
  await assert.rejects(
    () => resolveImageInput("http://127.0.0.1/x.png", { attachmentsRoot: "unused" }),
    /non-public address/i,
  );
});

test("resolveImageInput rejects images above the 10 MiB byte limit", async () => {
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
  await assert.rejects(
    () => resolveImageInput(`data:image/png;base64,${tooBig}`),
    /exceeds size limit/i,
  );
});

test("vision tool execute resolves the image, calls the pool, and renders text", async (t) => {
  const dataUrl = "data:image/png;base64," + PNG_MAGIC.toString("base64");
  const calls = [];
  const tool = createVisionTool({}, async (base64, mimeType, prompt) => {
    calls.push({ base64, mimeType, prompt });
    return { text: "A tiny PNG with padding bytes.", accountEmail: "vision@example.com" };
  });
  assert.equal(tool.name, "antigravity_read_image");

  const output = await tool.execute({ image: dataUrl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, "image/png");
  assert.equal(calls[0].base64, PNG_MAGIC.toString("base64"));
  assert.ok(calls[0].prompt.includes("Describe this image in detail"));
  assert.deepEqual(output, {
    description: "A tiny PNG with padding bytes.",
    image: dataUrl,
    account: "vision@example.com",
  });
  // The host calls render(arguments, value): fields come from the second one.
  const rendered = tool.output.render({ image: output.image }, output);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("A tiny PNG with padding bytes."));
  assert.ok(rendered[0].text.includes("vision@example.com"));

  // Empty image argument is rejected before any IO.
  await assert.rejects(() => tool.execute({ image: "  " }), /image must be/);
  // An explicit prompt is forwarded verbatim (file path input exercises the
  // mime sniffing; 4 bytes of RIFF stays extension-mapped webp).
  const dir = await mkdtemp(join(process.cwd(), "test", "vision-tmp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "clip.webp");
  await writeFile(file, Buffer.from("RIFF"));
  await tool.execute({ image: file, prompt: "What is this?" });
  assert.equal(calls[1].prompt, "What is this?");
  assert.equal(calls[1].mimeType, "image/webp");
});

test("vision tool render gets its fields from the second argument (arguments, value)", () => {
  const tool = createVisionTool({}, async () => ({ text: "unused", accountEmail: "unused" }));
  const rendered = tool.output.render(
    { image: "ab12cd34" },
    { description: "A red square on white.", image: "ab12cd34", account: "acc@example.com" },
  );
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("A red square on white."));
  assert.ok(rendered[0].text.includes("acc@example.com"));
  assert.ok(!rendered[0].text.includes("undefined"));
});

test("requestVisionThroughPool collects text parts from the pool SSE stream", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);
  await addAccount(manager, "visionpool@example.com");

  let seenBody = null;
  await withStubbedFetch(
    async (url, init) => {
      if (String(url).includes("fetchAvailableModels")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      seenBody = JSON.parse(String(init?.body || "{}"));
      const inlineChunk = JSON.stringify({
        response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }] },
      });
      return sseResponse(SSE(textChunk("It is "), inlineChunk, textChunk("a red square.")));
    },
    async () => {
      const result = await requestVisionThroughPool(
        PNG_MAGIC.toString("base64"),
        "image/png",
        "What is in this image?",
        manager,
        modelSettings(),
      );
      assert.equal(result.text, "It is a red square.");
      assert.equal(result.accountEmail, "visionpool@example.com");
    },
  );

  // The image rode along as an inlineData part next to the prompt text.
  const parts = seenBody?.request?.contents?.[0]?.parts || [];
  assert.ok(parts.some((p) => p.text === "What is in this image?"));
  assert.ok(
    parts.some((p) => p.inlineData?.mimeType === "image/png" && p.inlineData?.data === PNG_MAGIC.toString("base64")),
  );
});

function errorChunk(message) {
  return JSON.stringify({ error: { message } });
}

test("requestVisionThroughPool surfaces SSE error frames and fails over accounts", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);
  await addAccount(manager, "first@example.com");
  await addAccount(manager, "second@example.com");

  await withStubbedFetch(
    async (url, init) => {
      if (String(url).includes("fetchAvailableModels")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const auth = String(init?.headers?.Authorization || "");
      if (auth.includes("access_first@example.com")) {
        return sseResponse(SSE(errorChunk("429 RESOURCE_EXHAUSTED: Individual quota reached for this account.")));
      }
      return sseResponse(SSE(textChunk("Second account description.")));
    },
    async () => {
      const result = await requestVisionThroughPool(
        PNG_MAGIC.toString("base64"),
        "image/png",
        "What is this?",
        manager,
        modelSettings(),
      );
      assert.equal(result.text, "Second account description.");
      assert.equal(result.accountEmail, "second@example.com");
    },
  );

  const status = await manager.getStatus();
  const first = status.accounts.find((a) => a.email === "first@example.com");
  assert.equal(first.inCooldown, true, "quota error frame must cool the account down");
});

test("requestVisionThroughPool rejects with the SSE error message (no silent truncation)", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);
  await addAccount(manager, "solo@example.com");

  await withStubbedFetch(
    async (url, init) => {
      if (String(url).includes("fetchAvailableModels")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return sseResponse(SSE(textChunk("partial "), errorChunk("400 INVALID_ARGUMENT: model not found")));
    },
    async () => {
      await assert.rejects(
        () => requestVisionThroughPool(PNG_MAGIC.toString("base64"), "image/png", "q", manager, modelSettings()),
        /INVALID_ARGUMENT/,
      );
    },
  );
});

test("requestVisionThroughPool retries the fallback runtime model on retryable status", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);
  await addAccount(manager, "fallback@example.com");
  await manager.updateConfig({ visionModel: "gemini-3.7-flash" });

  const seenModels = [];
  await withStubbedFetch(
    async (url, init) => {
      const u = String(url);
      if (u.includes("fetchAvailableModels")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body || "{}"));
      seenModels.push(body.model);
      // The primary runtime candidate keeps failing; the fallback must step in.
      if (body.model === "gemini-3.7-flash-low") {
        return new Response("not found", { status: 404 });
      }
      return sseResponse(SSE(textChunk("Fallback runtime worked.")));
    },
    async () => {
      const result = await requestVisionThroughPool(
        PNG_MAGIC.toString("base64"),
        "image/png",
        "q",
        manager,
        modelSettings(),
      );
      assert.equal(result.text, "Fallback runtime worked.");
    },
  );
  assert.ok(seenModels.length >= 2, "must retry after the retryable status");
  assert.ok(new Set(seenModels).size >= 2, "the retry must use a different runtime model");
});

test("resolveVisionModelId prefers visionModel, then a non-image-gen gemini, then the fallback", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);

  const catalog = [
    { id: "claude-sonnet-4-6", inputModalities: ["text", "image"] },
    { id: "gemini-3.1-flash-image", inputModalities: ["text", "image"] },
    { id: "gemini-2.5-pro", inputModalities: ["text", "image"] },
    { id: "gemini-3.6-flash", inputModalities: ["text", "image"] },
    { id: "gpt-oss-120b", inputModalities: ["text"] },
  ];
  // gemini-3.6-flash stays catalogued but disabled, so the auto pick has
  // exactly one viable candidate regardless of catalog sort order.
  const settings = {
    catalogModels: catalog,
    enabledModelIds: catalog.filter((m) => m.id !== "gemini-3.6-flash").map((m) => m.id),
  };

  // Auto pick: claude is not gemini, the image-gen model is excluded by suffix.
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");

  // A configured visionModel that exists in the catalog wins.
  await manager.updateConfig({ visionModel: "gemini-3.6-flash" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-3.6-flash");

  // A visionModel outside the catalog is ignored.
  await manager.updateConfig({ visionModel: "not-in-catalog" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");

  // Catalogued but non-vision preferred ids are rejected: text-only and
  // image-gen models must not be picked as the describing model.
  await manager.updateConfig({ visionModel: "gpt-oss-120b" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");
  await manager.updateConfig({ visionModel: "gemini-3.1-flash-image" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");

  // Nothing matches -> documented fallback (the everyday model of the
  // revamped catalog, available on every plan tier).
  const textOnly = { catalogModels: [{ id: "gpt-oss-120b", inputModalities: ["text"] }], enabledModelIds: ["gpt-oss-120b"] };
  assert.equal(resolveVisionModelId(manager, textOnly), "gemini-3.8-flash");
});
