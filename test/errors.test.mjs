import assert from "node:assert/strict";
import test from "node:test";

import { LlmError, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";

import {
  MAX_BACKEND_MESSAGE_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  classifyAntigravityFailure,
  createAntigravityError,
  isEndpointUnsupportedResponse,
  parseErrorPayload,
  parseRetryAfterHeader,
} from "../lib/errors.js";

// Real bodies captured from the user's Google AI Pro account (2026-11). The
// backend names nothing useful in the 404 body, so the classifier has to add
// model/entity/endpoint context and an actionable hint itself.
const NOT_FOUND = {
  error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
};

const INVALID_THINKING = {
  error: {
    code: 400,
    message:
      "Invalid value at 'request.generation_config.thinking_config.thinking_level' " +
      '(type.googleapis.com/google.cloud.aiplatform.master.GenerationConfig.ThinkingConfig.ThinkingLevel), "ULTRA"',
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [
          {
            field: "request.generation_config.thinking_config.thinking_level",
            description: 'Invalid value at \'request.generation_config.thinking_config.thinking_level\' ... "ULTRA"',
          },
        ],
      },
    ],
  },
};

const EXHAUSTED = {
  error: {
    code: 429,
    message: "Resource has been exhausted (e.g. check quota).",
    status: "RESOURCE_EXHAUSTED",
  },
};

const HTML_404 = [
  "<!DOCTYPE html>",
  '<html lang=en><meta charset=utf-8><title>Error 404 (Not Found)!!1</title>',
  "<p>That's an error.</p></html>",
].join("\n");

const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";
const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

/** Classify one HTTP failure the way the adapter does. */
function classify(body, overrides = {}) {
  return classifyAntigravityFailure({
    httpStatus: typeof body === "object" ? body.error?.code : undefined,
    body: typeof body === "object" ? JSON.stringify(body) : body,
    endpoint: DAILY,
    model: "gemini-4-hydrogen",
    entity: "gemini-4-hydrogen-high",
    operation: "stream",
    ...overrides,
  });
}

test("a 404 entity-not-found names the model/entity/endpoint and points at the stale catalog", () => {
  const failure = classify(NOT_FOUND);
  assert.equal(failure.code, "MODEL_NOT_FOUND");
  assert.equal(failure.httpStatus, 404);
  assert.equal(failure.grpcStatus, "NOT_FOUND");
  assert.equal(failure.model, "gemini-4-hydrogen");
  assert.equal(failure.entity, "gemini-4-hydrogen-high");
  assert.equal(failure.endpoint, DAILY);
  const [headline] = failure.message.split("\n");
  assert.match(headline, /did not find entity "gemini-4-hydrogen-high"/);
  assert.match(headline, /model "gemini-4-hydrogen"/);
  assert.match(headline, /daily-cloudcode-pa\.googleapis\.com/);
  assert.match(failure.message, /Backend said: Requested entity was not found\./);
  assert.match(failure.hint, /catalog may be stale|plan may not serve/);
  assert.match(failure.message, /^Next: /m);
});

test("a 404 without a model falls back to a plain NOT_FOUND", () => {
  const failure = classify(NOT_FOUND, { model: undefined, entity: undefined });
  assert.equal(failure.code, "NOT_FOUND");
  assert.match(failure.message, /did not find the requested entity/);
});

test("a 400 BadRequest exposes field: description and a thinking-level hint", () => {
  const failure = classify(INVALID_THINKING);
  assert.equal(failure.code, "INVALID_REQUEST");
  assert.equal(failure.field, "request.generation_config.thinking_config.thinking_level");
  assert.equal(failure.fieldDescription.includes("ULTRA"), true);
  assert.match(failure.message, /Rejected field: request\.generation_config\.thinking_config\.thinking_level — /);
  assert.match(failure.hint, /thinking level is not supported/);
});

test("the 429 resource-exhausted fixture keeps pool quota semantics", () => {
  const failure = classify(EXHAUSTED);
  assert.equal(failure.code, QUOTA_EXCEEDED_CODE);
  assert.equal(failure.grpcStatus, "RESOURCE_EXHAUSTED");
  assert.equal(failure.httpStatus, 429);
  assert.match(failure.message, /quota exhausted/);
  assert.match(failure.message, /Resource has been exhausted \(e\.g\. check quota\)/);
  assert.match(failure.hint, /quota window/);
  assert.match(failure.hint, /cools this account down/);
});

test("individual quota wording, reset text and RetryInfo reach the message", () => {
  const failure = classify(
    {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Individual quota reached for gemini-4-hydrogen-high. Resets in 2h 30m.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }],
      },
    },
    { endpoint: PROD },
  );
  assert.equal(failure.code, QUOTA_EXCEEDED_CODE);
  assert.equal(failure.retryAfterMs, 90_000);
  assert.match(failure.message, /individual quota/);
  assert.match(failure.hint, /resets 2h 30m/);
  assert.match(failure.hint, /Retry after ~1m 30s/);
});

test("a 429 without quota evidence is a RATE_LIMIT carrying its delay", () => {
  const failure = classify({
    error: {
      code: 429,
      status: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded for projects/123.",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7.5s" }],
    },
  });
  assert.equal(failure.code, "RATE_LIMIT");
  assert.equal(failure.retryAfterMs, 7500);
  assert.match(failure.message, /rate limited/);
  assert.match(failure.message, /HTTP 429 TOO_MANY_REQUESTS/);
  assert.match(failure.hint, /retry after ~8s/);
});

test("401/403 map to AUTH with a sign-in and plan-entitlement hint", () => {
  for (const [status, grpcStatus] of [
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
  ]) {
    const failure = classify({
      error: { code: status, status: grpcStatus, message: "Request had invalid authentication credentials." },
    });
    assert.equal(failure.code, "AUTH");
    assert.match(failure.hint, /\/antigravity-login/);
    assert.match(failure.hint, /plan may not include the model/);
  }
});

test("an invalid API key in a 400 is still an AUTH failure", () => {
  const failure = classify({
    error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
  });
  assert.equal(failure.code, "AUTH");
});

test("5xx classes split server failure from backend capacity", () => {
  const server = classify({ error: { code: 500, status: "INTERNAL", message: "Internal error encountered." } });
  assert.equal(server.code, "SERVER");
  const overloaded = classify({
    error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded. No capacity available." },
  });
  assert.equal(overloaded.code, "OVERLOADED");
  assert.match(overloaded.hint, /backend capacity, not your quota/);
});

test("Google Help links surface in the AUTH hint", () => {
  const failure = classify({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "The caller does not have permission.",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [{ description: "Billing", url: "https://console.cloud.google.com/billing" }],
        },
      ],
    },
  });
  assert.equal(failure.code, "AUTH");
  assert.match(failure.hint, /https:\/\/console\.cloud\.google\.com\/billing/);
});

test("an HTML page is an endpoint-unsupported failure naming every endpoint tried", () => {
  const failure = classify(HTML_404, { httpStatus: 404, triedEndpoints: [DAILY, PROD, SANDBOX] });
  assert.equal(failure.code, "ENDPOINT_UNSUPPORTED");
  assert.match(failure.message, /HTML page/);
  assert.match(failure.headline, /daily-cloudcode-pa\.googleapis\.com, cloudcode-pa\.googleapis\.com/);
  assert.match(failure.hint, /ANTIGRAVITY_BASE_URL/);
});

test("a non-JSON 404 body is a routing miss, not an entity miss", () => {
  const failure = classify("404 page not found", { httpStatus: 404, triedEndpoints: [DAILY] });
  assert.equal(failure.code, "ENDPOINT_UNSUPPORTED");
});

test("double-encoded JSON parses into the same envelope", () => {
  const direct = classify(NOT_FOUND);
  const doubleEncoded = classify(JSON.stringify(JSON.stringify(NOT_FOUND)));
  assert.equal(doubleEncoded.code, direct.code);
  assert.equal(doubleEncoded.model, direct.model);
  assert.equal(parseErrorPayload(JSON.stringify(JSON.stringify(EXHAUSTED))).status, "RESOURCE_EXHAUSTED");
});

test("plain text and empty bodies are tolerated", () => {
  const text = classify("upstream connect error or disconnect/reset before headers", {
    httpStatus: 502,
  });
  assert.equal(text.code, "SERVER");
  assert.match(text.message, /upstream connect error/);

  const empty = classify("", { httpStatus: 500 });
  assert.equal(empty.code, "SERVER");
  assert.equal(empty.bodyKind, "empty");
  assert.doesNotMatch(empty.message, /Backend said/);
});

test("a bare in-band error object infers status from its message", () => {
  // SSE error frames from the live API often carry only a message.
  const failure = classifyAntigravityFailure({
    body: { message: "429 RESOURCE_EXHAUSTED: Individual quota reached for this account." },
    operation: "vision",
    model: "gemini-3.8-flash",
  });
  assert.equal(failure.code, QUOTA_EXCEEDED_CODE);
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.grpcStatus, "RESOURCE_EXHAUSTED");
  assert.match(failure.message, /429 RESOURCE_EXHAUSTED: Individual quota reached/);
});

test("transport failures separate timeout from unreachable backend", () => {
  const timeout = classify(undefined, {
    httpStatus: undefined,
    transportError: Object.assign(new Error("The operation was aborted due to timeout"), { code: "ETIMEDOUT" }),
    body: undefined,
  });
  assert.equal(timeout.code, "TIMEOUT");
  const transport = classify(undefined, {
    httpStatus: undefined,
    transportError: new TypeError("fetch failed"),
    body: undefined,
  });
  assert.equal(transport.code, "TRANSPORT");
  assert.match(transport.hint, /proxy \.env/);
});

test("JSON 404 with a numeric code in an in-band frame maps to MODEL_NOT_FOUND", () => {
  const failure = classifyAntigravityFailure({
    body: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." },
    operation: "stream",
    entity: "gemini-4-carbon-disabled",
    endpoint: SANDBOX,
  });
  assert.equal(failure.code, "MODEL_NOT_FOUND");
  assert.match(failure.message, /gemini-4-carbon-disabled/);
  assert.match(failure.message, /daily-cloudcode-pa\.sandbox\.googleapis\.com/);
});

test("auth, quota and server messages are redacted and bounded", () => {
  const token = "ya29.a0ARrdaM-secret-token-value";
  const failure = classify(
    {
      error: {
        code: 500,
        status: "INTERNAL",
        message: `backend exploded with Authorization: Bearer ${token} ${"x".repeat(5000)}`,
      },
    },
    { endpoint: PROD },
  );
  assert.equal(failure.message.includes(token), false, "access tokens must be redacted");
  assert.match(failure.message, /\[redacted-access-token\]|Bearer \[redacted\]/);
  assert.ok(failure.message.length <= MAX_ERROR_MESSAGE_CHARS);
  assert.ok(failure.backendMessage.length <= MAX_BACKEND_MESSAGE_CHARS + 1);
});

test("the rendered message carries traceId and requestId when known", () => {
  const failure = classify(NOT_FOUND, { traceId: "4cb9b31a56283a07", requestId: "antigravity-123" });
  assert.equal(failure.traceId, "4cb9b31a56283a07");
  assert.match(failure.message, /Trace: 4cb9b31a56283a07 \(request antigravity-123\)/);
});

test("Retry-After headers are understood as seconds or an HTTP date", () => {
  assert.equal(parseRetryAfterHeader("15"), 15_000);
  const date = new Date(Date.now() + 20_000).toUTCString();
  const parsed = parseRetryAfterHeader(date);
  assert.ok(parsed > 15_000 && parsed <= 21_000, `unexpected parsed delay ${parsed}`);
  assert.equal(parseRetryAfterHeader("not-a-date"), undefined);
  const failure = classify(EXHAUSTED, { retryAfterHeader: "12" });
  assert.equal(failure.retryAfterMs, 12_000);
});

test("invalid-request hints keep the thought-signature, whitespace and tool-pairing guidance", () => {
  const cases = [
    ["Invalid value: thought_signature is missing for replayed tool call", /reasoning signature was rejected/],
    ["messages: text content blocks must contain non-whitespace text", /whitespace-only text block/],
    ["tool_use ids were found without tool_result blocks immediately after", /tool call\/result pairing was rejected/],
    ["Invalid JSON payload received. Unknown name \"foo\"", /request shape was rejected/],
  ];
  for (const [message, hint] of cases) {
    const failure = classify({ error: { code: 400, status: "INVALID_ARGUMENT", message } });
    assert.equal(failure.code, "INVALID_REQUEST");
    assert.match(failure.hint, hint);
  }
});

test("a label keeps the legacy first-line wording (image/vision paths)", () => {
  const failure = classify(NOT_FOUND, { label: "Google API 404", operation: "image" });
  assert.match(failure.message.split("\n")[0], /^Google API 404: /);
});

test("isEndpointUnsupportedResponse only flags HTML or non-JSON 404/410", () => {
  assert.equal(isEndpointUnsupportedResponse(404, HTML_404), true);
  assert.equal(isEndpointUnsupportedResponse(410, ""), true);
  assert.equal(isEndpointUnsupportedResponse(404, "not found"), true);
  assert.equal(isEndpointUnsupportedResponse(404, JSON.stringify(NOT_FOUND)), false);
  assert.equal(isEndpointUnsupportedResponse(429, JSON.stringify(EXHAUSTED)), false);
  assert.equal(isEndpointUnsupportedResponse(500, ""), false);
});

test("createAntigravityError maps the structured object onto one LlmError", () => {
  const error = createAntigravityError({
    httpStatus: 429,
    body: JSON.stringify(EXHAUSTED),
    endpoint: PROD,
    model: "gemini-4-hydrogen",
    label: "Google API 429",
  });
  assert.ok(error instanceof LlmError);
  assert.equal(error.code, QUOTA_EXCEEDED_CODE);
  assert.match(error.message, /^Google API 429: Antigravity quota exhausted/);
  assert.equal(error.structured.endpoint, PROD);
  assert.equal(error.retryAfterMs, undefined);
  const rateLimited = createAntigravityError({
    httpStatus: 429,
    body: JSON.stringify({
      error: {
        code: 429,
        status: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }],
      },
    }),
  });
  assert.equal(rateLimited.code, "RATE_LIMIT");
  assert.equal(rateLimited.retryAfterMs, 3000);
});

test("in-band gRPC statuses classify without an HTTP status", () => {
  const overloaded = classifyAntigravityFailure({
    body: { status: "UNAVAILABLE", message: "The service is currently unavailable." },
  });
  assert.equal(overloaded.code, "OVERLOADED");
  const timeout = classifyAntigravityFailure({
    body: { status: "DEADLINE_EXCEEDED", message: "Deadline exceeded." },
  });
  assert.equal(timeout.code, "TIMEOUT");
  const server = classifyAntigravityFailure({ body: { status: "INTERNAL", message: "Internal error." } });
  assert.equal(server.code, "SERVER");
});
