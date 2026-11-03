import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";

async function tempPaths() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-persist-"));
  return {
    file: join(dir, "accounts.json"),
    legacy: join(dir, "legacy.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Regression: an account added and saved by the pool must survive a reload by a
// fresh manager instance. This broke because #load validated a field name that
// the saved account never has (accessToken vs the real `refresh`/`access`),
// throwing during load; the throw was swallowed and the pool came back empty —
// silent loss of every configured account on process restart.
test("saved accounts survive a reload into a fresh manager", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    const first = new AccountPoolManager(file, legacy);
    await first.init();
    await first.addOrUpdateAccount({
      email: "keep@example.com",
      refresh: "refresh-token-1",
      access: "access-token-1",
      expires: Date.now() + 3600_000,
      projectId: "proj-1",
    });
    assert.equal((await first.getStatus()).accounts.length, 1);

    const reloaded = new AccountPoolManager(file, legacy);
    await reloaded.init();
    const accounts = (await reloaded.getStatus()).accounts;
    assert.equal(accounts.length, 1, "reloaded pool must still contain the saved account");
    assert.equal(accounts[0].email, "keep@example.com");
  } finally {
    await cleanup();
  }
});

// A legacy-migrated account may legitimately have an empty access token (it is
// re-minted from the refresh token on demand). It must still load.
test("account with empty access token but a refresh token still loads", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    await writeFile(
      file,
      JSON.stringify({
        schedulingMode: "auto",
        accounts: [
          { id: "acc_legacy", email: "legacy@example.com", refresh: "r", access: "", expires: 0 },
        ],
      }),
      "utf8",
    );
    const m = new AccountPoolManager(file, legacy);
    await m.init();
    const accounts = (await m.getStatus()).accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, "legacy@example.com");
  } finally {
    await cleanup();
  }
});

// A pool file that exists but is corrupt must fail loudly, not silently start
// empty and let legacy migration overwrite a recoverable file.
test("a corrupt pool file throws instead of being silently discarded", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    await writeFile(file, "{ this is not valid json ", "utf8");
    const m = new AccountPoolManager(file, legacy);
    await assert.rejects(() => m.init(), /corrupt|cannot be parsed/i);
    // The corrupt file must be left untouched (not overwritten by migration).
    assert.equal(await readFile(file, "utf8"), "{ this is not valid json ");
    // A failed shared initialization must be retryable after the user repairs it.
    await writeFile(file, JSON.stringify({ accounts: [{ id: "repaired", refresh: "refresh" }] }));
    await m.init();
    assert.equal(m.allAccounts[0].id, "repaired");
  } finally {
    await cleanup();
  }
});

test("concurrent first-use mutations preserve every account in an existing pool", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    await writeFile(file, JSON.stringify({
      accounts: [{ id: "seed", email: "seed@example.com", refresh: "seed-refresh" }],
    }));
    const pool = new AccountPoolManager(file, legacy);
    const emails = Array.from({ length: 12 }, (_, index) => `new-${index}@example.com`);
    await Promise.all(emails.map((email) => pool.addOrUpdateAccount({ email, refresh: "refresh" })));

    const reloaded = new AccountPoolManager(file, legacy);
    const savedEmails = (await reloaded.getStatus()).accounts.map((account) => account.email).sort();
    assert.deepEqual(savedEmails, ["seed@example.com", ...emails].sort());
  } finally {
    await cleanup();
  }
});

test("concurrent quota updates and config writes complete and persist together", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    const pool = new AccountPoolManager(file, legacy);
    await pool.addOrUpdateAccount({ email: "quota@example.com", refresh: "refresh" });
    const id = pool.allAccounts[0].id;
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => pool.updateAccountQuota(id, { fetchedAt: index })),
      pool.updateConfig({ visionModel: "gemini-3.8-flash" }),
    ]);

    const reloaded = new AccountPoolManager(file, legacy);
    await reloaded.init();
    assert.equal(reloaded.allAccounts[0].quota.fetchedAt, 7);
    assert.equal(reloaded.visionModel, "gemini-3.8-flash");
  } finally {
    await cleanup();
  }
});
