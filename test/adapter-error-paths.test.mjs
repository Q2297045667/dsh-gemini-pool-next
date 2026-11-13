import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import {
  AntigravityPoolAdapter,
  doctorText,
  fetchQuotaForAccount,
  generateImageThroughPool,
  getAntigravityDiagnostics,
  resetEndpointCapabilityCache,
} from "../lib/index.js";

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

function errorResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

// Minimal in-memory model settings store: the adapter only ever calls read().
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

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-adapter-"));
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

// Records every markCooldown call so a test can assert on call count.
function spyPool(manager) {
  const calls = [];
  const original = manager.markCooldown.bind(manager);
  manager.markCooldown = async (id, durationMs, reason) => {
    calls.push({ id, durationMs, reason });
    return original(id, durationMs, reason);
  };
  return calls;
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// The adapter performs model-discovery requests (fetchAvailableModels) before
// the streaming request, so fakes must route on the URL rather than on call
// order. Discovery is answered with an empty but valid payload.
function isStreamRequest(url) {
  return url.includes(":streamGenerateContent");
}

function isDiscoveryRequest(url) {
  return url.includes(":fetchAvailableModels");
}

function discoveryResponse() {
  return new Response(JSON.stringify({ models: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// C1-adjacent guard: a real successful stream must leave failureCount intact so
// the backoff ladder can still retire a flaky account.
test("successful stream clears cooldown window without resetting failureCount", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "ok@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 3 });
    await manager.markCooldown(accountId, undefined, "earlier 429");
    assert.equal((await manager.getStatus()).accounts[0].failureCount, 1);

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : sseResponse(SSE(textChunk("hello")))),
      async () => {
        const chunks = [];
        for await (const chunk of adapter.stream({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        })) {
          chunks.push(chunk);
        }
        assert.ok(chunks.length > 0, "stream must yield chunks");
      },
    );

    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 1, "successful stream must not reset failureCount");
    assert.equal(acc.cooldownRemainingMs, 0, "successful stream must clear the cooldown window");
  } finally {
    await cleanup();
  }
});

// Important: quota-ish text in a 400 must not cool down the account on the
// image path. "quota field unknown" is a malformed request, not exhaustion.
test("image path does not mark cooldown for a 400 whose text merely contains quota", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "img@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const calls = spyPool(manager);

    await withStubbedFetch(
      (url) =>
        isDiscoveryRequest(url)
          ? discoveryResponse()
          : errorResponse(400, "400 invalid request: quota field unknown"),
      async () => {
        await assert.rejects(
          () => generateImageThroughPool("draw a cat", manager, modelSettings()),
          /400|quota field unknown/i,
        );
      },
    );

    assert.equal(calls.length, 0, `markCooldown must not be called for a 400 (got ${JSON.stringify(calls)})`);
    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 0, "a 400 must not count as a cooldown failure");
    assert.equal(acc.status, "active");
    void accountId;
  } finally {
    await cleanup();
  }
});

// Critical: exhausting the pool is not an authentication failure. Users being
// told "AUTH" are pushed to re-login when they only need to wait or add accounts.
test("all accounts disabled yields a non-AUTH error code from stream()", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "gone@example.com");
    await manager.updateConfig({ disableThreshold: 1 });
    await manager.markCooldown(accountId, undefined, "disabled");

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : sseResponse(SSE(textChunk("unused")))),
      async () => {
        await assert.rejects(
          async () => {
            for await (const _chunk of adapter.stream({
              model: "gemini-3.8-flash",
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            })) {
              void _chunk;
            }
          },
          (error) => {
            assert.equal(error.code, "EXHAUSTED", `all-disabled pool must surface as EXHAUSTED (got ${error.code})`);
            return true;
          },
        );
      },
    );
  } finally {
    await cleanup();
  }
});

// Important: a 429 arriving mid-stream after chunks were already emitted must
// still cool the account down. Failover is deliberately skipped (stream
// integrity), but the cooldown bookkeeping must happen.
test("mid-stream 429 after a chunk still marks cooldown but does not failover", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const firstId = await addAccount(manager, "first@example.com");
    await addAccount(manager, "second@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const calls = spyPool(manager);

    // The stream request yields chunks, then surfaces a 429 in the same SSE
    // body. The adapter processes the text frame before the error frame, so
    // anyChunkYielded is already true when the 429 is classified.
    let streamRequests = 0;
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        streamRequests += 1;
        const body = `${SSE(textChunk("partial"))}data: ${JSON.stringify({ error: { message: "429 RESOURCE_EXHAUSTED: Individual quota reached" } })}\n\n`;
        return sseResponse(body);
      },
      async () => {
        const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
        let yielded = 0;
        await assert.rejects(async () => {
          for await (const _chunk of adapter.stream({
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          })) {
            yielded += 1;
            void _chunk;
          }
        });
        assert.ok(yielded > 0, "test must produce at least one chunk before the 429");
      },
    );

    const first = (await manager.getStatus()).accounts.find((a) => a.id === firstId);
    assert.equal(calls.length, 1, `markCooldown must be called once for the mid-stream 429 (got ${calls.length})`);
    assert.equal(calls[0].id, firstId);
    assert.equal(first.failureCount, 1, "mid-stream 429 must accumulate a failure");
    assert.ok(first.cooldownRemainingMs > 0, "mid-stream 429 must open a cooldown window");
    assert.equal(streamRequests, 1, "must not fail over to the second account mid-stream");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Endpoint capability routing and precise failure classification.
//
// Live 2026-11 evidence: the daily channel serves catalog/quota/stream (and the
// new Gemini 4 Hydrogen entities) while production currently answers stream
// requests with 429; production keeps project discovery because the daily
// channel answers listCloudAICompanionProjects with an HTML 404 page.
// ---------------------------------------------------------------------------

const ENDPOINT = {
  daily: "https://daily-cloudcode-pa.googleapis.com",
  production: "https://cloudcode-pa.googleapis.com",
  sandbox: "https://daily-cloudcode-pa.sandbox.googleapis.com",
};

/** Real Google RPC envelopes captured from the live backend. */
const LIVE_NOT_FOUND = JSON.stringify({
  error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
});
const LIVE_INVALID_THINKING = JSON.stringify({
  error: {
    code: 400,
    message:
      'Invalid value at \'request.generation_config.thinking_config.thinking_level\' "ULTRA"',
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [
          {
            field: "request.generation_config.thinking_config.thinking_level",
            description: 'Invalid value at \'...thinking_level\' "ULTRA"',
          },
        ],
      },
    ],
  },
});
const LIVE_EXHAUSTED = JSON.stringify({
  error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
});
const HTML_404 = "<!DOCTYPE html>\n<html><title>Error 404 (Not Found)!!1</title></html>";

function hostOf(url) {
  return new URL(String(url)).host;
}

function streamHosts(calls) {
  return calls.filter((call) => String(call.url).includes(":streamGenerateContent")).map((call) => hostOf(call.url));
}

function sseTextResponse(text = "hello") {
  return sseResponse(SSE(textChunk(text)));
}

async function collectStream(adapter, model = "gemini-3.8-flash") {
  const chunks = [];
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/** In-memory model-settings store covering the calls the quota path makes. */
function memoryModelSettings(initial = {}) {
  let state = { catalogModels: [], enabledModelIds: [], updatedAt: 0, ...initial };
  const persist = (next) => {
    if (next !== undefined) state = { ...next, updatedAt: Date.now() };
    return state;
  };
  return {
    async read() {
      return state;
    },
    async write(next) {
      return persist(next);
    },
    async modify(fn) {
      return persist(await fn(state));
    },
  };
}

test("capability routing prefers daily for catalog/quota/stream and production for discovery", async () => {
  resetEndpointCapabilityCache();
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "routing@example.com");
    const account = manager.allAccounts[0];
    const settings = memoryModelSettings();
    await withStubbedFetch(
      (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "project-routing" });
        if (path.endsWith(":retrieveUserQuotaSummary")) return Response.json({ groups: [] });
        if (path.endsWith(":fetchAvailableModels")) {
          return Response.json({ models: { "gemini-3.8-flash-low": {} } });
        }
        return sseTextResponse();
      },
      async (calls) => {
        await fetchQuotaForAccount(account, manager, settings);
        await collectStream(new AntigravityPoolAdapter(manager, settings, () => undefined));
        const firstOf = (suffix) => {
          const call = calls.find((entry) => String(entry.url).includes(suffix));
          return call ? hostOf(call.url) : undefined;
        };
        assert.equal(firstOf(":loadCodeAssist"), hostOf(ENDPOINT.production), "discovery must start on production");
        assert.equal(firstOf(":retrieveUserQuotaSummary"), hostOf(ENDPOINT.daily), "quota must start on daily");
        assert.equal(firstOf(":fetchAvailableModels"), hostOf(ENDPOINT.daily), "catalog must start on daily");
        assert.equal(streamHosts(calls)[0], hostOf(ENDPOINT.daily), "stream must start on daily");
      },
    );
  } finally {
    resetEndpointCapabilityCache();
    await cleanup();
  }
});

test("an endpoint that answers HTML 404 is skipped and not retried by later calls", async () => {
  resetEndpointCapabilityCache();
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "route-miss@example.com");
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        return String(url).startsWith(ENDPOINT.daily)
          ? new Response(HTML_404, { status: 404, headers: { "content-type": "text/html" } })
          : sseTextResponse();
      },
      async (calls) => {
        const chunks = await collectStream(adapter);
        assert.ok(chunks.some((chunk) => chunk.type === "finish"), "the call must succeed on the next endpoint");
        assert.deepEqual(streamHosts(calls), [hostOf(ENDPOINT.daily), hostOf(ENDPOINT.production)]);

        // The dead route is remembered: the second call never pays for it again.
        const before = calls.length;
        await collectStream(adapter);
        const retried = calls.slice(before).filter((call) => String(call.url).includes(":streamGenerateContent"));
        assert.deepEqual(retried.map((call) => hostOf(call.url)), [hostOf(ENDPOINT.production)]);
      },
    );
  } finally {
    resetEndpointCapabilityCache();
    await cleanup();
  }
});

test("a JSON 404 entity-not-found becomes MODEL_NOT_FOUND with model/entity/endpoint context", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "notfound@example.com");
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : errorResponse(404, LIVE_NOT_FOUND)),
      async () => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "MODEL_NOT_FOUND", `got code ${error.code}: ${error.message}`);
          assert.match(error.message, /did not find entity "gemini-\d/);
          assert.match(error.message, /model "gemini-3\.8-flash"/);
          assert.match(error.message, /\.googleapis\.com/);
          assert.match(error.message, /Backend said: Requested entity was not found\./);
          assert.match(error.message, /catalog may be stale|switch model/);
          assert.match(error.message, /^Next: /m);
          return true;
        });
      },
    );
    // The structured failure is recorded for /antigravity-doctor.
    const diagnostics = getAntigravityDiagnostics();
    assert.equal(diagnostics.errorCode, "MODEL_NOT_FOUND");
    assert.match(diagnostics.errorEndpoint, /cloudcode-pa\.(sandbox\.)?googleapis\.com$/);
    assert.match(doctorText(), /^errorCode=MODEL_NOT_FOUND$/m);
    assert.match(doctorText(), /^errorEndpoint=https:\/\/(daily-)?cloudcode-pa/m);
  } finally {
    await cleanup();
  }
});

test("a 400 BadRequest field violation becomes INVALID_REQUEST naming the rejected field", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "invalid@example.com");
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : errorResponse(400, LIVE_INVALID_THINKING)),
      async () => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "INVALID_REQUEST", `got code ${error.code}: ${error.message}`);
          assert.match(error.message, /request\.generation_config\.thinking_config\.thinking_level/);
          assert.match(error.message, /Rejected field: request\.generation_config\.thinking_config\.thinking_level — /);
          assert.match(error.message, /thinking level is not supported/);
          return true;
        });
      },
    );
  } finally {
    await cleanup();
  }
});

test("a 429 resource-exhausted body classifies as quota and still marks one cooldown", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "quota-class@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const cooldowns = spyPool(manager);
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : errorResponse(429, LIVE_EXHAUSTED)),
      async () => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "QUOTA", `quota semantics must not regress (got ${error.code})`);
          assert.match(error.message, /quota exhausted/);
          assert.match(error.message, /Resource has been exhausted \(e\.g\. check quota\)/);
          return true;
        });
      },
    );
    assert.equal(cooldowns.length, 1, `one cooldown per failed request (got ${cooldowns.length})`);
    assert.equal(cooldowns[0].id, accountId);
  } finally {
    await cleanup();
  }
});

test("a 429 without quota evidence classifies as RATE_LIMIT and surfaces its delay", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "ratelimit@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const cooldowns = spyPool(manager);
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded for this endpoint.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "6s" }],
      },
    });
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : errorResponse(429, body)),
      async () => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "RATE_LIMIT", `got code ${error.code}: ${error.message}`);
          assert.match(error.message, /rate limited/);
          assert.match(error.message, /~6s/);
          assert.equal(error.retryAfterMs, 6000);
          return true;
        });
      },
    );
    // A 429 that is not quota exhaustion still cools the account down, so the
    // pool's cooldown/backoff ladder keeps working.
    assert.equal(cooldowns.length, 1);
  } finally {
    await cleanup();
  }
});

test("every endpoint answering HTML surfaces ENDPOINT_UNSUPPORTED naming the routes, without cooldowns", async () => {
  resetEndpointCapabilityCache();
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "html@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const cooldowns = spyPool(manager);
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) =>
        isDiscoveryRequest(url)
          ? discoveryResponse()
          : new Response(HTML_404, { status: 404, headers: { "content-type": "text/html" } }),
      async (calls) => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "ENDPOINT_UNSUPPORTED", `got code ${error.code}: ${error.message}`);
          for (const endpoint of Object.values(ENDPOINT)) {
            assert.match(error.message, new RegExp(hostOf(endpoint).replace(/\./g, "\\.")));
          }
          assert.match(error.message, /HTML page/);
          return true;
        });
        assert.ok(streamHosts(calls).length >= 3, "every capability endpoint must be tried");
      },
    );
    assert.equal(cooldowns.length, 0, "a routing page is not a quota failure and must not cool the account down");
    const account = manager.allAccounts[0];
    assert.equal(account.failureCount, 0);
  } finally {
    resetEndpointCapabilityCache();
    await cleanup();
  }
});

test("a 429 that is not an individual quota continues to the next endpoint", async () => {
  resetEndpointCapabilityCache();
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "endpoint-retry@example.com");
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        // The live production endpoint currently answers every stream request
        // with 429 while the daily endpoint serves the same model — the daily
        // 429 must not abort the endpoint walk.
        if (String(url).startsWith(ENDPOINT.daily)) return errorResponse(429, LIVE_EXHAUSTED);
        return sseTextResponse();
      },
      async (calls) => {
        const chunks = await collectStream(adapter);
        assert.ok(chunks.some((chunk) => chunk.type === "finish"));
        assert.deepEqual(streamHosts(calls), [hostOf(ENDPOINT.daily), hostOf(ENDPOINT.production)]);
      },
    );
  } finally {
    resetEndpointCapabilityCache();
    await cleanup();
  }
});

test("an individual quota stops the endpoint walk because the account, not the route, is out", async () => {
  resetEndpointCapabilityCache();
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "individual@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    const individual = JSON.stringify({
      error: {
        code: 429,
        message: "Individual quota reached for this account.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : errorResponse(429, individual)),
      async (calls) => {
        await assert.rejects(() => collectStream(adapter), (error) => {
          assert.equal(error.code, "QUOTA");
          assert.match(error.message, /Individual quota reached/);
          return true;
        });
        assert.deepEqual(
          [...new Set(streamHosts(calls))],
          [hostOf(ENDPOINT.daily)],
          "an individual quota must not spend requests on the remaining endpoints",
        );
      },
    );
  } finally {
    resetEndpointCapabilityCache();
    await cleanup();
  }
});
