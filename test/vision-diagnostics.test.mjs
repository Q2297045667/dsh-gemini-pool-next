import assert from "node:assert/strict";
import test from "node:test";

import { doctorText, registerWebApi } from "../lib/index.js";

// Refs #7: /antigravity-doctor must surface the vision chain's assembly
// state — bridge listener registration, admission shim install result, and
// the live visionEnabled switch — so one doctor run tells whether the
// silent-failure candidates are even reachable in this process.
test("doctor output includes the vision assembly section", () => {
  const text = doctorText();
  assert.match(text, /^visionEnabled=/m);
  assert.match(text, /^visionBridge=/m);
  assert.match(text, /^visionShim=/m);
});

test("doctor vision lines report the pre-apply defaults before the plugin starts", () => {
  const lines = doctorText()
    .split("\n")
    .filter((line) => /^vision(Enabled|Bridge|Shim)=/.test(line));
  assert.equal(lines.length, 3);
  // Defaults before apply(): nothing registered, nothing installed yet.
  assert.ok(lines.some((line) => line === "visionBridge=unregistered"), `got: ${lines.join("; ")}`);
  assert.ok(lines.some((line) => line === "visionShim=pending"), `got: ${lines.join("; ")}`);
});

// The README's troubleshooting section sends users to a real callable entry:
// GET /antigravity-pool-next/api/doctor returns the doctor text verbatim. This route
// was a documentation promise without an implementation until Refs #7.
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function makeWebCtx({ rejection } = {}) {
  let route;
  const webCtx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    webServer: { register: (captured) => (route = captured) },
    connection: {
      admit: () => (rejection === undefined ? { peer: {} } : { rejection }),
    },
    get route() {
      return route;
    },
  };
  return webCtx;
}

test("web api registers GET /antigravity-pool-next/api/doctor returning the doctor text", async () => {
  const webCtx = makeWebCtx();
  const ctx = { inject: (deps, cb) => cb(webCtx) };
  registerWebApi(ctx, {}, {});
  const route = webCtx.route;

  assert.ok(route, "registerWebApi must register a route");
  assert.equal(route.kind, "prefix");
  assert.equal(route.path, "/antigravity-pool-next/api");

  const response = makeResponse();
  await route.handler({ method: "GET", url: "/antigravity-pool-next/api/doctor" }, response);

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  for (const line of ["visionEnabled=", "visionBridge=", "visionShim="]) {
    assert.ok(payload.value.includes(line), `doctor payload must include "${line}"`);
  }

  // Read-only fence: non-GET hits the method guard, no side effects.
  const rejected = makeResponse();
  await route.handler({ method: "POST", url: "/antigravity-pool-next/api/doctor" }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(JSON.parse(rejected.body).error, "method-not-allowed");
});

// The /antigravity-pool-next/api prefix rides the host connection admission fence
// (same as the host /api channel): an unauthenticated or untrusted-origin
// request must be rejected before any route logic — no pool state, no
// credentials, no doctor text leaks to a bare curl.
for (const rejection of [401, 403]) {
  test(`web api rejects requests the connection fence refuses (${rejection})`, async () => {
    const webCtx = makeWebCtx({ rejection });
    const ctx = { inject: (deps, cb) => cb(webCtx) };
    registerWebApi(ctx, {}, {});
    const route = webCtx.route;
    assert.ok(route, "registerWebApi must register a route");

    const response = makeResponse();
    await route.handler({ method: "GET", url: "/antigravity-pool-next/api/doctor" }, response);
    assert.equal(response.statusCode, rejection);
    assert.equal(response.body, rejection === 401 ? "unauthorized" : "forbidden");

    // The login route (the natural "first contact" for a fresh setup) is
    // behind the same fence: no OAuth flow starts for a refused request.
    const loginResponse = makeResponse();
    await route.handler({ method: "POST", url: "/antigravity-pool-next/api/login" }, loginResponse);
    assert.equal(loginResponse.statusCode, rejection);
  });
}

// Response identity (traceId/modelVersion/responseId, captured from the newest
// stream chunk) and the structured last-error fields let a support report quote
// the exact backend request without re-running it. Existing keys stay stable.
test("doctor output exposes response identity and structured last-error fields", () => {
  const text = doctorText();
  for (const key of [
    "lastTraceId",
    "lastModelVersion",
    "lastResponseId",
    "lastResponseMetadata",
    "errorCode",
    "errorGrpcStatus",
    "errorEndpoint",
    "errorTraceId",
    "errorRetryAfterMs",
  ]) {
    assert.match(text, new RegExp(`^${key}=`, "m"), `doctor must expose ${key}`);
  }
  for (const key of ["lastEndpoint", "lastStatus", "lastProjectId", "lastError"]) {
    assert.match(text, new RegExp(`^${key}=`, "m"), `existing doctor key ${key} must stay`);
  }
});
