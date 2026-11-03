import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { registerCommands } from "../lib/commands.js";

// The README's conversation-command table must be backed by real
// registrations on the host `commands` service. These tests pin the four
// names, the defensive no-service path, and each handler's contract against
// stubbed collaborators (the same functions the web API routes use).

function makeRegistry() {
  const registered = [];
  const disposed = [];
  return {
    registered,
    disposed,
    commands: {
      register(definition) {
        registered.push(definition);
        return () => disposed.push(definition.name);
      },
    },
  };
}

function makeDeps() {
  const calls = { fetch: [], emit: 0, removed: [] };
  const deps = {
    calls,
    poolManager: {
      inited: 0,
      async init() {
        this.inited += 1;
      },
      allAccounts: [{ id: "a1" }, { id: "a2" }],
      async getStatus() {
        return {
          schedulingMode: "auto",
          accounts: [
            {
              id: "a1",
              email: "one@gmail.com",
              status: "active",
              isPrimary: true,
              inCooldown: false,
              quota: {
                groups: [
                  {
                    name: "gemini pro",
                    limits: [
                      { label: "5 hours", remainingFraction: 0.47 },
                      { label: "weekly", remainingFraction: 0.9 },
                    ],
                  },
                ],
              },
            },
            { id: "a2", email: "two@gmail.com", status: "cooldown", isPrimary: false, inCooldown: true, quota: null },
          ],
        };
      },
      async removeAccount(id) {
        calls.removed.push(id);
      },
    },
    modelSettings: {},
    beginLogin: async () => ({ status: "pending", authUrl: "https://accounts.google.test/auth", startedAt: 1 }),
    fetchQuotaForAccount: async (acc) => {
      calls.fetch.push(acc.id);
    },
    doctorText: () => "visionEnabled=true\nvisionBridge=registered\nvisionShim=installed",
    emitUpdated: () => {
      calls.emit += 1;
    },
  };
  return deps;
}

test("registers the four README commands and disposes them together", () => {
  const { registered, disposed, commands } = makeRegistry();
  const dispose = registerCommands({ commands }, makeDeps());
  assert.deepEqual(
    registered.map((d) => d.name).sort(),
    ["antigravity-doctor", "antigravity-login", "antigravity-logout", "antigravity-quota"],
  );
  for (const definition of registered) {
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.description.length > 0);
    assert.equal(typeof definition.handler, "function");
  }
  dispose();
  assert.equal(disposed.length, 4);
});

test("host without a commands registry: no-op disposer, no throw", () => {
  const dispose = registerCommands({}, makeDeps());
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
});

test("login handler surfaces the OAuth URL", async () => {
  const { registered, commands } = makeRegistry();
  registerCommands({ commands }, makeDeps());
  const login = registered.find((d) => d.name === "antigravity-login");
  const result = await login.handler({});
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("https://accounts.google.test/auth"));
});

test("quota handler refreshes every account, emits adapter update, lists accounts", async () => {
  const { registered, commands } = makeRegistry();
  const deps = makeDeps();
  registerCommands({ commands }, deps);
  const quota = registered.find((d) => d.name === "antigravity-quota");
  const result = await quota.handler({});
  assert.equal(result.kind, "success");
  assert.deepEqual(deps.calls.fetch, ["a1", "a2"]);
  assert.equal(deps.calls.emit, 1);
  assert.ok(result.text.includes("accounts=2"));
  assert.ok(result.text.includes("one@gmail.com"));
  assert.ok(result.text.includes("gemini 5h=47% week=90%"));
  assert.ok(result.text.includes("two@gmail.com"));
  assert.ok(result.text.includes("quota=unknown"));
});

test("quota handler renders real parsed quota groups and buckets", async () => {
  const status = JSON.parse(await readFile(new URL("./fixtures/status-value.json", import.meta.url), "utf8"));
  const { registered, commands } = makeRegistry();
  const deps = makeDeps();
  deps.poolManager.getStatus = async () => status;
  registerCommands({ commands }, deps);
  const result = await registered.find((d) => d.name === "antigravity-quota").handler({});
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("gemini 5h=100% week=67%"));
});

test("empty pool: quota handler answers with guidance instead of a bare zero", async () => {
  const { registered, commands } = makeRegistry();
  const deps = makeDeps();
  deps.poolManager.allAccounts = [];
  registerCommands({ commands }, deps);
  const quota = registered.find((d) => d.name === "antigravity-quota");
  const result = await quota.handler({});
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("/antigravity-login"));
});

test("doctor handler returns the doctor text verbatim", async () => {
  const { registered, commands } = makeRegistry();
  registerCommands({ commands }, makeDeps());
  const doctor = registered.find((d) => d.name === "antigravity-doctor");
  const result = await doctor.handler({});
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("visionBridge=registered"));
});

test("logout refuses without confirm and removes everything with it", async () => {
  const { registered, commands } = makeRegistry();
  const deps = makeDeps();
  registerCommands({ commands }, deps);
  const logout = registered.find((d) => d.name === "antigravity-logout");

  const refused = await logout.handler({ rawInput: "" });
  assert.equal(refused.kind, "error");
  assert.ok(refused.text.includes("confirm"));
  assert.deepEqual(deps.calls.removed, []);

  const done = await logout.handler({ rawInput: "confirm" });
  assert.equal(done.kind, "success");
  assert.deepEqual(deps.calls.removed, ["a1", "a2"]);
  assert.equal(deps.calls.emit, 1);
});

test("handler failures settle as error results, not throws", async () => {
  const { registered, commands } = makeRegistry();
  const deps = makeDeps();
  deps.beginLogin = async () => {
    throw new Error("callback port busy");
  };
  registerCommands({ commands }, deps);
  const login = registered.find((d) => d.name === "antigravity-login");
  const result = await login.handler({});
  assert.equal(result.kind, "error");
  assert.ok(result.text.includes("callback port busy"));
});
