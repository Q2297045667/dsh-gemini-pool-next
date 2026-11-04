import assert from "node:assert/strict";
import test from "node:test";
import { requestAntigravityChunksWithAccount, probeAccountLiveness } from "../lib/index.js";
import { modelById } from "../lib/models.js";

const tokenInfo = { token: "protocol-test", projectId: "test-project" };
const textFrame = (text) => ({ response: { candidates: [{ content: { parts: [{ text }] } }] } });

/** The entities a paid (Google AI Pro) project advertises today. */
const LIVE_ENTITIES = {
  "claude-opus-5-5-high": {},
  "claude-opus-5-5-low": {},
  "claude-opus-5-5-medium": {},
  "claude-sonnet-5-5-high": {},
  "claude-sonnet-5-5-low": {},
  "claude-sonnet-5-5-medium": {},
  "gemini-2.5-flash": {},
  "gemini-2.5-pro": {},
  "gemini-3-flash": {},
  "gemini-3.1-flash-image": {},
  "gemini-3.8-flash-tiered": {},
  "gpt-oss-120b-medium": {},
};

// The live-catalog lookup is cached per access token, so every request needs
// its own token to keep one test's catalog out of the next test.
let requestCounter = 0;

async function runRequest(t, { modelId = "gemini-3.8-flash", messages, frames, options = {}, attachments, response, entities = LIVE_ENTITIES } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes(":fetchAvailableModels")) return Response.json({ models: entities });
    requests.push(JSON.parse(init.body));
    return response || new Response(frames || `data:${JSON.stringify(textFrame("ok"))}`);
  });
  const chunks = [];
  for await (const chunk of requestAntigravityChunksWithAccount({
    model: modelId,
    messages: messages || [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...options,
  }, modelById(modelId), undefined, { ...tokenInfo, token: `${tokenInfo.token}-${requestCounter += 1}` }, attachments)) chunks.push(chunk);
  return { requests, chunks };
}

test("stream decodes fragmented UTF-8, reasoning, tools, usage and a final unterminated frame", async (t) => {
  const events = [
    { response: { candidates: [{ content: { parts: [{ text: "思考", thought: true, thoughtSignature: "reasoning-signature" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "你好🌍" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ functionCall: { id: "call_1", name: "inspect", args: { path: "src" } }, thoughtSignature: "tool-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 7 } } },
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `data:${JSON.stringify(event)}`).join("\r\n\r\n"));
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  const { chunks } = await runRequest(t, { response });
  assert.equal(chunks.find((chunk) => chunk.type === "reasoning-delta").text, "思考");
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta").text, "你好🌍");
  assert.deepEqual(chunks.find((chunk) => chunk.type === "tool-call-delta").argumentsDelta, '{"path":"src"}');
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.deepEqual(finish.reason, { kind: "tool-calls" });
  assert.equal(finish.replayState.blocks[0].thinkingSignature, "reasoning-signature");
  assert.equal(finish.replayState.blocks[2].thoughtSignature, "tool-signature");
  assert.ok(chunks.some((chunk) => chunk.type === "usage"));
});

test("stream surfaces nested upstream error frames and releases its reader", async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data:{"response":{"error":{"message":"429 RESOURCE_EXHAUSTED"}}}\n'));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(runRequest(t, { response }), /429 RESOURCE_EXHAUSTED/);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("ending a stream consumer cancels and unlocks the upstream body", async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data:${JSON.stringify(textFrame("partial"))}\n`)); },
    cancel() { cancelled = true; },
  }));
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes(":fetchAvailableModels") ? Response.json({ models: {} }) : response);
  const stream = requestAntigravityChunksWithAccount({ messages: [{ role: "user", content: [] }] }, modelById("gemini-2.5-flash"), undefined, tokenInfo);
  await stream.next();
  await stream.return();
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("tool requests preserve schema and replay signatures while clamping output tokens", async (t) => {
  const tool = { name: "inspect", description: "Read a path", parameters: { $schema: "ignored", type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
  const { requests } = await runRequest(t, {
    options: { tools: [tool], toolChoice: "required", maxTokens: 1_000_000, reasoningEffort: "medium" },
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      { role: "assistant", source: { kind: "model", model: "gemini-3.8-flash", replayState: { kind: "antigravity", version: 1, provider: "antigravity", model: "gemini-3.8-flash", blocks: [{ type: "tool-call", thoughtSignature: "signed" }] } }, content: [{ type: "tool-call", id: "call_1", name: "inspect", arguments: '{"path":"src"}' }] },
      { role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "found" }] }] },
    ],
  });
  const { request, model } = requests[0];
  // The live catalog advertises the tiered entity, so the requested level
  // travels in thinkingConfig instead of a per-level model id.
  assert.equal(model, "gemini-3.8-flash-tiered");
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");
  assert.equal(request.generationConfig.maxOutputTokens, 65536);
  assert.equal(request.contents[1].parts[0].thought_signature, "signed");
  assert.equal(request.contents[2].parts[0].functionResponse.name, "inspect");
  assert.deepEqual(request.contents[2].parts[0].functionResponse.response, { output: "found" });
  assert.equal(request.toolConfig.functionCallingConfig.mode, "ANY");
  assert.deepEqual(request.tools[0].functionDeclarations[0].parametersJsonSchema, { type: "object", properties: { path: { type: "string" } }, required: ["path"] });
});

test("Claude uses legacy tool schema and its advertised runtime entity", async (t) => {
  const { requests } = await runRequest(t, {
    modelId: "claude-sonnet-5.5",
    options: { tools: [{ name: "inspect", parameters: { type: "object", properties: { path: { type: ["string", "null"], minLength: 1 } }, additionalProperties: false } }] },
  });
  assert.equal(requests[0].model, "claude-sonnet-5-5-high");
  assert.deepEqual(requests[0].request.tools[0].functionDeclarations[0].parameters, { type: "object", properties: { path: { type: "string" } } });
  assert.equal(requests[0].request.toolConfig.functionCallingConfig.mode, "VALIDATED");
});

test("history image budget omits every excess old image, retains recent images and leaves input intact", async (t) => {
  const images = Array.from({ length: 15 }, (_, index) => Object.freeze({ type: "image", attachment: Object.freeze({ attachmentId: `sha256:image-${index}`, bytes: 1024 * 1024, mediaType: "image/png", width: 100, height: 100 }) }));
  const messages = Object.freeze(images.map((image) => Object.freeze({ role: "user", content: Object.freeze([image]) })));
  const read = [];
  const attachments = { async readImageRequest(ref) {
    read.push(ref.attachmentId);
    return { data: Buffer.from(ref.attachmentId), mediaType: "image/png", width: 100, height: 100 };
  } };
  const { requests } = await runRequest(t, { messages, attachments });
  assert.equal(read.length, 11);
  assert.deepEqual(read, images.slice(4).map((image) => image.attachment.attachmentId));
  const parts = requests[0].request.contents.flatMap((content) => content.parts);
  assert.equal(parts.filter((part) => part.inlineData).length, 11);
  assert.equal(parts.filter((part) => part.text?.includes("image omitted")).length, 4);
  assert.equal(messages[0].content[0], images[0]);
});

test("liveness probe uses a text model when only image generation is enabled", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes(":fetchAvailableModels")) return Response.json({ models: {} });
    requests.push(JSON.parse(init.body));
    return new Response(`data:${JSON.stringify(textFrame("pong"))}`);
  });
  await probeAccountLiveness({ refresh: "refresh", access: "access", expires: Date.now() + 3600_000, projectId: "test" }, {}, {
    async read() { return { catalogModels: [], enabledModelIds: ["gemini-3.1-flash-image"] }; },
  });
  assert.equal(requests[0].model, "gemini-3.8-flash-tiered");
  assert.equal(requests[0].request.generationConfig.maxOutputTokens, 1);
});
