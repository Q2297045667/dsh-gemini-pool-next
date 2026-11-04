import assert from "node:assert/strict";
import test from "node:test";
import { requestAntigravityChunksWithAccount, probeAccountLiveness } from "../lib/index.js";
import { modelById } from "../lib/models.js";

const tokenInfo = { token: "protocol-test", projectId: "test-project" };
const textFrame = (text) => ({ response: { candidates: [{ content: { parts: [{ text }] } }] } });

/** The entities a paid (Google AI Pro) project advertises with a current fingerprint. */
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
  "gemini-3.8-flash-high": {},
  "gemini-3.8-flash-low": {},
  "gemini-3.8-flash-medium": {},
  "gemini-3.8-flash-tiered": {},
  "gemini-4-argon-high": {},
  "gemini-4-argon-low": {},
  "gemini-4-argon-medium": {},
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

test("no whitespace-only text part ever reaches the wire", async (t) => {
  // The Claude backend behind Cloud Code rejects such a request with 400
  // "messages: text content blocks must contain non-whitespace text".
  const { requests } = await runRequest(t, {
    modelId: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: "   " },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: " \n\t " }] },
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "real question" }] },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      { role: "user", content: [{ type: "text", text: "  " }] },
    ],
    options: { system: "   " },
  });
  const contents = requests[0].request.contents;
  assert.ok(contents.length > 0);
  for (const entry of contents) {
    for (const part of entry.parts) {
      if ("text" in part) assert.ok(String(part.text).trim().length > 0, `empty text part reached the wire: ${JSON.stringify(part)}`);
    }
  }
  // The whitespace-only system text is dropped, the fixed instructions stay.
  const systemParts = requests[0].request.systemInstruction.parts;
  assert.equal(systemParts.length, 3);
  for (const part of systemParts) assert.ok(part.text.trim().length > 0);
  assert.equal(contents[0].role, "user");
  assert.equal(contents[contents.length - 1].role, "user");
  assert.ok(contents.some((entry) => entry.parts.some((part) => part.text === "real question")));
});

test("a role:tool result answers the call in the very next turn", async (t) => {
  // This is how DSH delivers tool results; sending them as plain user text made
  // Claude answer 400 "tool_use ids were found without tool_result blocks
  // immediately after".
  const { requests } = await runRequest(t, {
    modelId: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: [{ type: "text", text: "list the repo" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "tool-call", id: "call_00_abc", name: "run_code", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_00_abc", content: [{ type: "text", text: "a\nb" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ],
  });
  const contents = requests[0].request.contents;
  const callIndex = contents.findIndex((entry) => entry.parts.some((part) => part.functionCall));
  assert.ok(callIndex >= 0);
  const next = contents[callIndex + 1];
  assert.equal(next.role, "user");
  assert.ok(next.parts.some((part) => part.functionResponse), "the very next turn must carry the tool result");
  assert.deepEqual(next.parts.find((part) => part.functionResponse).functionResponse, {
    name: "run_code",
    response: { output: "a\nb" },
    id: "call_00_abc",
  });
});

test("a history ending on an unanswered tool call still sends a valid pairing", async (t) => {
  const { requests } = await runRequest(t, {
    modelId: "claude-opus-5.5",
    messages: [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call_00_pending", name: "run_code", arguments: "{}" }] },
    ],
  });
  const contents = requests[0].request.contents;
  assert.equal(contents.length, 3);
  const tail = contents[2];
  assert.equal(tail.role, "user");
  assert.equal(tail.parts[0].functionResponse.name, "run_code");
  assert.equal(tail.parts[0].functionResponse.id, "call_00_pending");
});

test("every functionCall in a mixed history is answered by the next turn", async (t) => {
  const { requests } = await runRequest(t, {
    modelId: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "a1", name: "first", arguments: "{}" }] },
      { role: "tool", toolCallId: "a1", content: [{ type: "text", text: "r1" }] },
      { role: "system", content: [{ type: "text", text: "model changed" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "a2", name: "second", arguments: "{}" }] },
      { role: "tool", toolCallId: "a2", content: [{ type: "text", text: "r2" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "a3", name: "third", arguments: "{}" }] },
      { role: "tool", toolCallId: "a3", content: [{ type: "text", text: "r3" }] },
      { role: "user", content: [{ type: "text", text: "done?" }] },
    ],
  });
  const contents = requests[0].request.contents;
  for (let i = 0; i < contents.length; i++) {
    const calls = contents[i].parts.filter((part) => part.functionCall).map((part) => part.functionCall.id);
    if (calls.length === 0) continue;
    const nextIds = (contents[i + 1]?.parts ?? []).filter((part) => part.functionResponse).map((part) => part.functionResponse.id);
    assert.deepEqual(calls.filter((id) => !nextIds.includes(id)), [], "unanswered call in turn " + i);
  }
});

test("a tool that printed only whitespace sends a non-empty result", async (t) => {
  // Real sessions contain tool results whose text is a single space; forwarding
  // that verbatim made Claude answer 400 "messages: text content blocks must
  // contain non-whitespace text".
  const { requests } = await runRequest(t, {
    modelId: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "inspect", arguments: "{}" }] },
      { role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: " " }] }] },
    ],
  });
  const parts = requests[0].request.contents.flatMap((entry) => entry.parts);
  const results = parts.filter((part) => "functionResponse" in part);
  assert.equal(results.length, 1);
  assert.equal(results[0].functionResponse.response.output, "(no output)");
  for (const part of parts) {
    if ("text" in part) assert.ok(String(part.text).trim().length > 0);
  }
});

test("a conversation that is only whitespace still sends a valid request", async (t) => {
  const { requests } = await runRequest(t, {
    messages: [{ role: "user", content: "   " }, { role: "system", content: "" }],
  });
  const contents = requests[0].request.contents;
  assert.deepEqual(contents, [{ role: "user", parts: [{ text: "Continue" }] }]);
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
  // The live catalog advertises one entity per level, so the level is pinned by
  // the model id and no thinkingConfig has to be sent.
  assert.equal(model, "gemini-3.8-flash-medium");
  assert.equal(request.generationConfig.thinkingConfig, undefined);
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
  assert.equal(requests[0].model, "gemini-3.8-flash-low");
  assert.equal(requests[0].request.generationConfig.maxOutputTokens, 1);
});
