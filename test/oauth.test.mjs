import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  beginWebLogin, ensureApiKeyForAccount, FileModelSettingsStore,
  getWebLoginStatus, loginAntigravity, refreshAntigravityToken,
} from "../lib/index.js";
import { AccountPoolManager } from "../lib/pool.js";

async function callbackEnv(t) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const names = ["ANTIGRAVITY_CALLBACK_PORT", "ANTIGRAVITY_CALLBACK_HOST"];
  const previous = names.map((name) => process.env[name]);
  process.env.ANTIGRAVITY_CALLBACK_PORT = String(port);
  process.env.ANTIGRAVITY_CALLBACK_HOST = "127.0.0.1";
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  return port;
}

function callback(port, params, path = "/oauth-callback", method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: `${path}?${new URLSearchParams(params)}`, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function loginFlow(signal) {
  let notify;
  const notified = new Promise((resolve) => { notify = resolve; });
  const completed = loginAntigravity({ signal, notify }).then(
    (credentials) => ({ credentials }), (error) => ({ error }),
  );
  return { notified, completed };
}

function fakeGoogle(t, onToken = () => {}) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      onToken(new URLSearchParams(init.body));
      return Response.json({ access_token: "fake-oauth-access", refresh_token: "fake-oauth-refresh", expires_in: 3600 });
    }
    if (String(url).includes("userinfo")) return Response.json({ email: "oauth@example.com" });
    if (String(url).includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "oauth-project" });
    if (String(url).includes(":retrieveUserQuotaSummary")) return Response.json({ groups: [] });
    if (String(url).includes(":fetchAvailableModels")) return Response.json({ models: { "gemini-3.8-flash-low": {} } });
    assert.fail(`unexpected external request: ${url}`);
  });
}

test("OAuth callback validates PKCE, exchanges the code and discovers account metadata", { timeout: 5000 }, async (t) => {
  const port = await callbackEnv(t);
  let params;
  fakeGoogle(t, (body) => { params = body; });
  const flow = loginFlow();
  const event = await flow.notified;
  const auth = new URL(event.url);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.ok(auth.searchParams.get("state").length >= 32);
  const response = await callback(port, { code: "fake-code", state: auth.searchParams.get("state") });
  assert.equal(response.status, 200);
  assert.match(response.headers["cache-control"], /no-store/);
  const result = await flow.completed;
  assert.equal(result.error, undefined);
  assert.equal(result.credentials.email, "oauth@example.com");
  assert.equal(result.credentials.projectId, "oauth-project");
  assert.equal(result.credentials.refresh, "fake-oauth-refresh");
  assert.equal(params.get("code"), "fake-code");
  assert.equal(params.get("redirect_uri"), `http://localhost:${port}/oauth-callback`);
  assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), auth.searchParams.get("code_challenge"));
});

test("OAuth callback rejects invalid state before exchanging credentials", { timeout: 5000 }, async (t) => {
  const port = await callbackEnv(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("invalid state must not exchange tokens"));
  const flow = loginFlow();
  await flow.notified;
  const response = await callback(port, { code: "fake", state: "wrong" });
  assert.equal(response.status, 400);
  assert.match((await flow.completed).error.message, /state mismatch/i);
});

test("OAuth callback rejects other methods and routes, then handles an escaped provider error", { timeout: 5000 }, async (t) => {
  const port = await callbackEnv(t);
  const flow = loginFlow();
  await flow.notified;
  assert.equal((await callback(port, {}, "/other")).status, 404);
  assert.equal((await callback(port, {}, "/oauth-callback", "POST")).status, 405);
  const response = await callback(port, { error: "<script>failed</script>" });
  assert.equal(response.status, 400);
  assert.ok(!response.body.includes("<script>"));
  assert.match((await flow.completed).error.message, /OAuth error/);
});

test("aborting OAuth while waiting for the browser closes the callback promptly", { timeout: 5000 }, async (t) => {
  const port = await callbackEnv(t);
  const controller = new AbortController();
  const flow = loginFlow(controller.signal);
  await flow.notified;
  controller.abort();
  assert.match((await flow.completed).error.message, /OAuth login aborted/);
  await assert.rejects(callback(port, {}), /ECONNREFUSED/);
});

test("an already-aborted OAuth login starts no browser flow", async (t) => {
  await callbackEnv(t);
  await assert.rejects(loginAntigravity({ signal: AbortSignal.abort(), notify() { assert.fail("must not notify"); } }), /aborted/i);
});

test("concurrent web login starts share one callback and persist the signed-in account", { timeout: 5000 }, async (t) => {
  const port = await callbackEnv(t);
  const dir = await mkdtemp(join(tmpdir(), "gemini-oauth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  const settings = new FileModelSettingsStore(join(dir, "settings.json"));
  fakeGoogle(t);
  const [first, second] = await Promise.all([beginWebLogin(pool, settings), beginWebLogin(pool, settings)]);
  assert.equal(first.authUrl, second.authUrl);
  assert.equal(getWebLoginStatus().status, "pending");
  const auth = new URL(first.authUrl);
  await callback(port, { code: "fake-web-code", state: auth.searchParams.get("state") });
  while (getWebLoginStatus().status === "pending") await setImmediate();
  assert.equal(getWebLoginStatus().status, "complete");
  assert.equal(pool.allAccounts[0].email, "oauth@example.com");
  assert.deepEqual((await settings.read()).enabledModelIds, ["gemini-3.8-flash"]);
});

test("concurrent account requests coalesce token refresh and preserve rotated credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pool = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await pool.addOrUpdateAccount({ email: "refresh@example.com", refresh: "old-refresh", access: "old-access", expires: 1, projectId: "refresh-project" });
  let calls = 0;
  fakeGoogle(t, (body) => { calls++; assert.equal(body.get("refresh_token"), "old-refresh"); });
  const account = pool.allAccounts[0];
  const results = await Promise.all(Array.from({ length: 10 }, () => ensureApiKeyForAccount(account, pool)));
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.token === "fake-oauth-access"));
  assert.equal(pool.allAccounts[0].refresh, "fake-oauth-refresh");
  assert.equal(pool.allAccounts[0].projectId, "refresh-project");
});

test("token refresh rejects malformed success payloads and redacts provider errors", async (t) => {
  const account = { refresh: "fake-refresh", projectId: "test" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ expires_in: 3600 }));
  await assert.rejects(refreshAntigravityToken(account), /valid access_token/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant", error_description: "access_token=ya29.fake-secret" }, { status: 400 }));
  await assert.rejects(refreshAntigravityToken(account), (error) => {
    assert.match(error.message, /invalid_grant/);
    assert.ok(!error.message.includes("ya29.fake-secret"));
    return true;
  });
});

test("a missing browser launcher is best effort and does not crash the login process", async () => {
  const entry = new URL("../lib/index.js", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import { openBrowser } from ${JSON.stringify(entry)}; openBrowser("https://example.com"); await new Promise(r => setTimeout(r, 50));`], { env: { ...process.env, PATH: "" }, timeout: 5000 });
});
