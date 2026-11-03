import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { Context } from "@deepseek-ai/cordis";

import { createVisionBridge, isVisionBridgeHookLive } from "../lib/vision-bridge.js";

const HASH = "ab12cd34".repeat(8);
const ATTACHMENT_ID = `sha256:${HASH}`;

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The agent/pre-step builtin hands each listener the decision the host would
// enter with; extra fields (assembly and friends) ride on it and must survive
// a rewrite untouched.
function enterDecision(messages, extra = {}) {
  return { kind: "enter", messages, ...extra };
}

// Drive one pre-step dispatch the way the host loop does: listener(payload,
// next) with next resolving to the (already composed) decision.
async function runPreStep(bridge, decision, payloadExtra = {}) {
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
    return Promise.resolve(decision);
  };
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  const payload = { messages, turn: 1, step: 1, signal: new AbortController().signal, agent: {}, ...payloadExtra };
  const result = await bridge(payload, next);
  return { result, nextCalls };
}

function makeDeps({ textOnly = true, describe, route } = {}) {
  const resolveCalls = [];
  const describeCalls = [];
  const deps = {
    resolveCalls,
    describeCalls,
    isEnabled: () => true,
    resolveRoute: () => route ?? { provider: "zai-coding-cn", model: "glm-5.3" },
    isTextOnlyModel: async () => textOnly,
    resolveImage: async (ref) => {
      resolveCalls.push(ref);
      return { base64: "QUJD", mimeType: "image/png" };
    },
    describeImage: async (base64, mimeType) => {
      describeCalls.push({ base64, mimeType });
      return describe ? describe() : "A red square on white background.";
    },
  };
  deps.bridge = createVisionBridge(deps);
  return deps;
}

test("image-free step -> the exact same decision object rides through, next called once", async () => {
  const { bridge } = makeDeps();
  const decision = enterDecision([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  const { result, nextCalls } = await runPreStep(bridge, decision);
  assert.equal(nextCalls, 1);
  assert.equal(result, decision, "no-image steps must return the host decision untouched");
});

test("reject decisions ride through untouched without consulting the gate", async () => {
  const deps = makeDeps();
  let gateCalls = 0;
  deps.isTextOnlyModel = async () => {
    gateCalls += 1;
    return true;
  };
  const bridge = createVisionBridge(deps);
  const decision = {
    kind: "reject",
    reason: "blocked",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
  assert.equal(gateCalls, 0);
  assert.equal(deps.describeCalls.length, 0);
});

test("text-only model: image blocks replaced in a NEW decision, extras preserved, input frozen-intact", async () => {
  const { bridge, resolveCalls, describeCalls } = makeDeps();
  const dataUrl = "data:image/png;base64,QUJD";
  const messages = deepFreeze([
    {
      role: "user",
      content: [
        { type: "text", text: "what do you see?" },
        { type: "image", attachment: { attachmentId: ATTACHMENT_ID, mediaType: "image/png" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content: [{ type: "image", data: dataUrl, mimeType: "image/png" }],
    },
  ]);
  const decision = enterDecision(messages, { assembly: { marker: "keep-me" } });

  const { result } = await runPreStep(bridge, decision);
  assert.notEqual(result, decision, "a rewrite must return a new decision object");
  assert.equal(result.kind, "enter");
  assert.deepEqual(result.assembly, { marker: "keep-me" }, "sibling decision fields ride along");

  const [first, second] = result.messages;
  const replacement = first.content[1];
  assert.equal(replacement.type, "text");
  assert.ok(replacement.text.includes("A red square on white background."));
  assert.ok(replacement.text.includes(`(original attachment: sha256:${HASH}`));
  assert.ok(replacement.text.includes("call antigravity_read_image with the 8-char hash prefix"));
  assert.equal(first.content[0].text, "what do you see?", "non-image blocks ride along unchanged");
  assert.equal(first.role, "user");
  assert.equal(second.role, "tool");
  assert.equal(second.toolCallId, "call-1", "message identity fields survive the rewrite");

  // Inline data: URL is decoded inside the bridge (no resolver round-trip).
  assert.equal(second.content[0].type, "text");
  assert.ok(second.content[0].text.includes("A red square on white background."));
  assert.ok(second.content[0].text.includes(`sha256:${sha256Hex(Buffer.from("ABC"))}`));
  assert.ok(second.content[0].text.includes("not a stored attachment"));
  assert.ok(!second.content[0].text.includes("call antigravity_read_image with the 8-char hash prefix"));

  assert.deepEqual(resolveCalls, [ATTACHMENT_ID]);
  assert.equal(describeCalls.length, 2);

  // The original deep-frozen input was never mutated.
  assert.equal(messages[0].content[1].type, "image");
  assert.equal(messages[1].content[0].type, "image");
});

test("remote image descriptions use the URL for follow-up reads and cache repeat occurrences", async () => {
  const { bridge, describeCalls, resolveCalls } = makeDeps();
  const url = "https://images.example.test/picture.png";
  const decision = enterDecision([{ role: "user", content: [{ type: "image", data: url }] }]);
  const { result } = await runPreStep(bridge, decision);
  await runPreStep(bridge, decision);
  assert.equal(describeCalls.length, 1);
  assert.deepEqual(resolveCalls, [url]);
  assert.ok(result.messages[0].content[0].text.includes(`original image URL: ${url}`));
  assert.ok(result.messages[0].content[0].text.includes("with this URL to look again"));
});

test("vision-capable model -> decision returned untouched", async () => {
  const { bridge, describeCalls } = makeDeps({ textOnly: false });
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
  assert.equal(describeCalls.length, 0);
});

test("isTextOnlyModel throwing -> conservative passthrough", async () => {
  const deps = makeDeps();
  deps.isTextOnlyModel = async () => {
    throw new Error("resolver exploded");
  };
  const bridge = createVisionBridge(deps);
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
  assert.equal(deps.describeCalls.length, 0);
});

test("route resolution failure preserves the original decision", async () => {
  const deps = makeDeps();
  deps.resolveRoute = () => { throw new Error("route unavailable"); };
  const bridge = createVisionBridge(deps);
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
  assert.equal(deps.describeCalls.length, 0);
});

test("diagnostic logger failures cannot interrupt a vision step", async () => {
  const deps = makeDeps();
  deps.log = () => { throw new Error("logger unavailable"); };
  const bridge = createVisionBridge(deps);
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
});

test("same attachment id across steps describes only once (cache)", async () => {
  const { bridge, describeCalls } = makeDeps();
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  await runPreStep(bridge, decision);
  await runPreStep(bridge, enterDecision(decision.messages));
  assert.equal(describeCalls.length, 1);
});

test("concurrent steps for the same image share one in-flight description", async () => {
  const gate = deferred();
  let describeCalls = 0;
  const deps = makeDeps();
  deps.describeImage = async (base64, mimeType) => {
    describeCalls += 1;
    return gate.promise.then(() => "late description");
  };
  const bridge = createVisionBridge(deps);
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const first = runPreStep(bridge, decision);
  const second = runPreStep(bridge, enterDecision(decision.messages));
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(describeCalls, 1);
  assert.ok(a.result.messages[0].content[0].text.includes("late description"));
  assert.ok(b.result.messages[0].content[0].text.includes("late description"));
});

test("describeImage rejecting -> fail-open: the original decision and image block survive", async () => {
  let calls = 0;
  const deps = makeDeps();
  deps.describeImage = async () => {
    calls += 1;
    throw new Error("pool is down");
  };
  const bridge = createVisionBridge(deps);
  const imageBlock = { type: "image", attachment: { attachmentId: ATTACHMENT_ID } };
  const decision = enterDecision([
    { role: "user", content: [{ type: "text", text: "look" }, imageBlock] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision, "fail-open returns the host decision untouched");
  assert.equal(decision.messages[0].content[1].type, "image");
  assert.equal(decision.messages[0].content[1], imageBlock);
  // The failed key was evicted: a later step retries the description.
  await runPreStep(bridge, enterDecision(decision.messages));
  assert.equal(calls, 2);
});

test("isEnabled false -> passthrough without consulting the model gate", async () => {
  const deps = makeDeps();
  let gateCalls = 0;
  deps.isEnabled = () => false;
  deps.isTextOnlyModel = async () => {
    gateCalls += 1;
    return true;
  };
  const bridge = createVisionBridge(deps);
  const decision = enterDecision([
    { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
  ]);
  const { result } = await runPreStep(bridge, decision);
  assert.equal(result, decision);
  assert.equal(gateCalls, 0);
  assert.equal(deps.describeCalls.length, 0);
});

// --- Decision-chain logging (Refs #7) ---------------------------------------
// The bridge must say what it decided on every image path so one reproduction
// tells which of the four candidate breakpoints (event not reaching the
// bridge / resolver unavailable / resolver error / describe failure) fired.
// No log lines at all means the handler was never entered with images.

function imageMessages(blocks = [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }]) {
  return [{ role: "user", content: blocks }];
}

function makeLoggingDeps(overrides = {}) {
  const lines = [];
  const deps = makeDeps(overrides.textOnly === undefined ? {} : { textOnly: overrides.textOnly });
  deps.log = (message) => lines.push(message);
  Object.assign(deps, { lines }, overrides.deps || {});
  return { bridge: createVisionBridge(deps), lines, deps };
}

test("logging: happy path baseline signature", async () => {
  const { bridge, lines } = makeLoggingDeps();
  const decision = enterDecision(
    imageMessages([
      { type: "text", text: "what is this?" },
      { type: "image", attachment: { attachmentId: ATTACHMENT_ID } },
    ]),
  );
  await runPreStep(bridge, decision);
  assert.equal(lines.length, 3, `expected request/gate/rewrote lines, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^request provider=zai-coding-cn model=glm-5\.3 images=1$/);
  assert.match(lines[1], /^model gate: textOnly=true$/);
  assert.match(lines[2], /^rewrote: 1 image block\(s\) replaced$/);
});

test("logging: textOnly=false -> not-text-only passthrough", async () => {
  const { bridge, lines } = makeLoggingDeps({ textOnly: false });
  await runPreStep(bridge, enterDecision(imageMessages()));
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^passthrough: reason=not-text-only$/);
});

test("logging: gate resolver throwing -> resolve=error passthrough", async () => {
  const { lines } = makeLoggingDeps();
  const deps = makeDeps();
  deps.isTextOnlyModel = async () => {
    throw new Error("resolver exploded");
  };
  deps.log = (message) => lines.push(message);
  const bridge = createVisionBridge(deps);
  await runPreStep(bridge, enterDecision(imageMessages()));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^model gate: resolve=error \(resolver exploded\)$/);
  assert.match(lines[2], /^passthrough: reason=gate-error$/);
});

test("logging: all descriptions failing -> all-describe-failed passthrough", async () => {
  const { lines } = makeLoggingDeps();
  const deps = makeDeps();
  deps.describeImage = async () => {
    throw new Error("pool is down");
  };
  deps.log = (message) => lines.push(message);
  const bridge = createVisionBridge(deps);
  await runPreStep(bridge, enterDecision(imageMessages()));
  const passthrough = lines.find((l) => l.startsWith("passthrough:"));
  assert.match(passthrough, /^passthrough: reason=all-describe-failed \(1 failed\)$/);
});

test("logging: image blocks without usable source -> no-usable-source passthrough", async () => {
  const { bridge, lines } = makeLoggingDeps();
  // Width/height only: no attachmentId, no data — imageSourceOf cannot resolve it.
  await runPreStep(bridge, enterDecision(imageMessages([{ type: "image", width: 100, height: 50 }])));
  const passthrough = lines.find((l) => l.startsWith("passthrough:"));
  assert.match(passthrough, /^passthrough: reason=no-usable-source \(1 unresolved\)$/);
});

test("logging: no-image steps produce no log lines", async () => {
  const { bridge, lines } = makeLoggingDeps();
  await runPreStep(
    bridge,
    enterDecision([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
  );
  assert.equal(lines.length, 0);
});

test("logging: failure injections have pairwise-distinguishable readouts (Refs #7 red team)", async () => {
  const readouts = {};

  // Injection A — handler entered but gate says not text-only (resolver
  // unavailable in the assembled plugin reads exactly like this at the bridge
  // layer; the index-side resolver log disambiguates).
  {
    const { bridge, lines } = makeLoggingDeps({ textOnly: false });
    await runPreStep(bridge, enterDecision(imageMessages()));
    readouts.notTextOnly = lines.join("|");
  }
  // Injection B — resolver throws.
  {
    const { lines } = makeLoggingDeps();
    const deps = makeDeps();
    deps.isTextOnlyModel = async () => {
      throw new Error("boom");
    };
    deps.log = (m) => lines.push(m);
    const bridge = createVisionBridge(deps);
    await runPreStep(bridge, enterDecision(imageMessages()));
    readouts.gateError = lines.join("|");
  }
  // Injection C — describe fails for every usable image.
  {
    const { lines } = makeLoggingDeps();
    const deps = makeDeps();
    deps.describeImage = async () => {
      throw new Error("pool is down");
    };
    deps.log = (m) => lines.push(m);
    const bridge = createVisionBridge(deps);
    await runPreStep(bridge, enterDecision(imageMessages()));
    readouts.describeFailed = lines.join("|");
  }
  // Injection D — event never reaches the handler (or no image): no lines.
  {
    const { bridge, lines } = makeLoggingDeps();
    await runPreStep(
      bridge,
      enterDecision([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );
    readouts.eventMissed = lines.join("|");
  }

  const values = Object.values(readouts);
  assert.ok(values.every((v) => v.length > 0 || v === readouts.eventMissed));
  assert.equal(new Set(values).size, values.length, "all four readouts must be pairwise distinct");
  assert.equal(readouts.eventMissed, "", "missed event must read as zero lines");
});

// --- Hook liveness probing (Refs #7) -----------------------------------------
// The doctor's visionBridge line must reflect the host's event bus at read
// time, not apply-time bookkeeping: a handler silently dropped from the bus
// after ctx.on() returned is the failure shape issue #7 hunts, and pure
// bookkeeping would keep saying "registered". The probe must see through
// ctx.on()'s traceability Proxy (apply/construct traps only, property reads
// forward to the target) and stay honest when the bus layout is unreadable.

// Minimal stand-in for the host's reflect.bind() wrapper.
function hostWrapped(listener) {
  return new Proxy(listener, {
    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
  });
}

test("liveness: probe sees the tagged handler through host-style proxying and detects the drop", () => {
  const { bridge } = makeDeps();
  const hooks = [{ callback: hostWrapped(() => {}), global: true }];
  const events = { _hooks: { "agent/pre-step": hooks } };
  // Foreign listeners only: nothing of ours on the bus.
  assert.equal(isVisionBridgeHookLive(events), false);
  hooks.push({ callback: hostWrapped(bridge), global: true });
  assert.equal(isVisionBridgeHookLive(events), true);
  // The #7 signature: registered once, silently absent now.
  hooks.pop();
  assert.equal(isVisionBridgeHookLive(events), false);
});

test("liveness: unreadable bus layout reports undefined instead of a false alarm", () => {
  assert.equal(isVisionBridgeHookLive(undefined), undefined);
  assert.equal(isVisionBridgeHookLive({}), undefined);
  // Cordis >= 4.0.6 keeps a readable hook table; an absent key on a readable
  // table is a truthful "no bridge", not a false alarm.
  assert.equal(isVisionBridgeHookLive({ _hooks: {} }), false);
});

test("liveness: real cordis registration is visible and disposal flips it", () => {
  const app = new Context();
  const { bridge } = makeDeps();
  const dispose = app.on("agent/pre-step", bridge, { global: true });
  assert.equal(isVisionBridgeHookLive(app.events), true);
  dispose();
  assert.equal(isVisionBridgeHookLive(app.events), false);
});
