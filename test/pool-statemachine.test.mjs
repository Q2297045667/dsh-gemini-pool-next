import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-test-"));
  const accountsFile = join(dir, "accounts.json");
  const legacyFile = join(dir, "legacy.json");
  const manager = new AccountPoolManager(accountsFile, legacyFile);
  await manager.init();
  return {
    manager,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("markCooldown applies exponential backoff sequence and caps at cooldownMaxMs", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "test@example.com",
      refresh: "dummy_refresh",
      access: "dummy_access",
    });
    const status1 = await manager.getStatus();
    const accId = status1.accounts[0].id;

    await manager.updateConfig({
      cooldownMs: 1000,
      cooldownMaxMs: 4000,
      disableThreshold: 10,
    });

    // 1st failure: 1000 * 2^0 = 1000ms
    const t0 = Date.now();
    await manager.markCooldown(accId, undefined, "fail 1");
    let acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 1);
    assert.equal(acc.status, "active");
    assert.ok(acc.cooldownRemainingMs > 500 && acc.cooldownRemainingMs <= 1100);

    // 2nd failure: 1000 * 2^1 = 2000ms
    await manager.markCooldown(accId, undefined, "fail 2");
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 2);
    assert.ok(acc.cooldownRemainingMs > 1500 && acc.cooldownRemainingMs <= 2100);

    // 3rd failure: 1000 * 2^2 = 4000ms (capped at cooldownMaxMs 4000)
    await manager.markCooldown(accId, undefined, "fail 3");
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 3);
    assert.ok(acc.cooldownRemainingMs > 3500 && acc.cooldownRemainingMs <= 4100);

    // 4th failure: 1000 * 2^3 = 8000ms -> capped at 4000ms
    await manager.markCooldown(accId, undefined, "fail 4");
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 4);
    assert.ok(acc.cooldownRemainingMs > 3500 && acc.cooldownRemainingMs <= 4100);
  } finally {
    await cleanup();
  }
});

test("account transitions to disabled status when reaching disableThreshold", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "dis@example.com",
      refresh: "dummy_refresh",
      access: "dummy_access",
    });
    const accId = (await manager.getStatus()).accounts[0].id;
    await manager.updateConfig({ disableThreshold: 3 });

    await manager.markCooldown(accId, undefined, "err 1");
    assert.equal((await manager.getStatus()).accounts[0].status, "active");

    await manager.markCooldown(accId, undefined, "err 2");
    assert.equal((await manager.getStatus()).accounts[0].status, "active");

    await manager.markCooldown(accId, undefined, "err 3");
    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.status, "disabled");
    assert.equal(acc.failureCount, 3);
  } finally {
    await cleanup();
  }
});

test("clearCooldown and enableAccount reset failureCount, cooldownUntil, and status to active", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "reset@example.com",
      refresh: "dummy_refresh",
      access: "dummy_access",
    });
    const accId = (await manager.getStatus()).accounts[0].id;
    await manager.updateConfig({ disableThreshold: 2 });

    await manager.markCooldown(accId, undefined, "fail 1");
    await manager.markCooldown(accId, undefined, "fail 2");
    let acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.status, "disabled");

    // test enableAccount
    await manager.enableAccount(accId);
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.status, "active");
    assert.equal(acc.failureCount, 0);
    assert.equal(acc.cooldownRemainingMs, 0);

    // mark cooldown again and test clearCooldown
    await manager.markCooldown(accId, undefined, "fail again");
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 1);
    await manager.clearCooldown(accId);
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.status, "active");
    assert.equal(acc.failureCount, 0);
    assert.equal(acc.cooldownRemainingMs, 0);
  } finally {
    await cleanup();
  }
});

test("getCandidateAccounts excludes disabled accounts and puts cooling accounts at the end", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({ email: "a1@example.com", refresh: "r1", access: "a1" });
    await manager.addOrUpdateAccount({ email: "a2@example.com", refresh: "r2", access: "a2" });
    await manager.addOrUpdateAccount({ email: "a3@example.com", refresh: "r3", access: "a3" });

    const status = await manager.getStatus();
    const id1 = status.accounts[0].id;
    const id2 = status.accounts[1].id;
    const id3 = status.accounts[2].id;

    // Set a2 cooling, a3 disabled
    await manager.updateConfig({ disableThreshold: 2 });
    await manager.markCooldown(id2, 10000, "cooling");
    await manager.markCooldown(id3, undefined, "err 1");
    await manager.markCooldown(id3, undefined, "err 2");

    const candidates = await manager.getCandidateAccounts("gemini");
    const emails = candidates.map((c) => c.email);
    assert.deepEqual(emails, ["a1@example.com", "a2@example.com"]);
    assert.ok(!emails.includes("a3@example.com"));

    // All disabled throws error
    await manager.markCooldown(id1, undefined, "err 1");
    await manager.markCooldown(id1, undefined, "err 2");
    await manager.markCooldown(id2, undefined, "err 2"); // a2 reached threshold too
    await assert.rejects(
      async () => await manager.getCandidateAccounts("gemini"),
      /所有账号已被禁用/,
    );
  } finally {
    await cleanup();
  }
});

test("manual mode locks to the selected account and never switches a disabled selection", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({ email: "m1@example.com", refresh: "r1", access: "a1" });
    await manager.addOrUpdateAccount({ email: "m2@example.com", refresh: "r2", access: "a2" });
    const status = await manager.getStatus();
    const id1 = status.accounts[0].id;
    const id2 = status.accounts[1].id;

    await manager.updateConfig({
      schedulingMode: "manual",
      activeAccountId: id1,
      disableThreshold: 2,
    });

    assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [id1]);
    // Cooling remains a single-account retry, never an implicit backup.
    await manager.markCooldown(id1, 10000, "cooling");
    assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [id1]);

    // A disabled manual selection is unavailable, even when a backup is healthy.
    await manager.markCooldown(id1, undefined, "err");
    await assert.rejects(() => manager.getCandidateAccounts("gemini"), /手动指定的账号已被禁用/);
    assert.equal((await manager.getStatus()).activeAccountId, id1);

    // Switching strategies restores normal healthy-account failover.
    for (const schedulingMode of ["auto", "primary-backup"]) {
      await manager.updateConfig({ schedulingMode });
      assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [id2]);
    }
    // Older files can contain a missing selection; preserve their healthy fallback.
    await manager.updateConfig({ schedulingMode: "manual", activeAccountId: "missing-account" });
    assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [id2]);
  } finally {
    await cleanup();
  }
});

test("config whitelist read and write persists correctly", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.updateConfig({
      schedulingMode: "primary-backup",
      cooldownMs: 45000,
      cooldownMaxMs: 1800000,
      disableThreshold: 8,
      probeIntervalMs: 120000,
      unsupportedKey: "ignored",
    });

    const status = await manager.getStatus();
    assert.equal(status.schedulingMode, "primary-backup");
    assert.equal(status.cooldownMs, 45000);
    assert.equal(status.cooldownMaxMs, 1800000);
    assert.equal(status.disableThreshold, 8);
    assert.equal(status.probeIntervalMs, 120000);
    assert.equal(status.unsupportedKey, undefined);
  } finally {
    await cleanup();
  }
});

test("primary-backup scheduling tries each account once when the primary is cooling", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({ email: "primary@example.com", refresh: "r1" });
    await manager.addOrUpdateAccount({ email: "backup@example.com", refresh: "r2" });
    const [primary, backup] = manager.allAccounts;
    await manager.updateConfig({ schedulingMode: "primary-backup" });
    await manager.markCooldown(primary.id, 60000, "rate limited");

    assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [backup.id, primary.id]);
    await manager.clearCooldown(primary.id);
    assert.deepEqual((await manager.getCandidateAccounts()).map((account) => account.id), [primary.id, backup.id]);
  } finally {
    await cleanup();
  }
});

test("auto scheduling uses live quota buckets and legacy limits for the requested category", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({ email: "weekly-empty@example.com", refresh: "r1" });
    await manager.addOrUpdateAccount({ email: "healthy@example.com", refresh: "r2" });
    const [empty, healthy] = manager.allAccounts;
    const group = (name, weekly, fiveHour) => ({
      name,
      limits: [
        { label: "Weekly", remainingFraction: weekly },
        { label: "5-hour", remainingFraction: fiveHour },
      ],
    });
    await manager.updateAccountQuota(empty.id, {
      groups: [group("Gemini", 0, 1), group("Claude & GPT", 1, 1)]
        .map(({ name, limits }) => ({ displayName: name, buckets: limits })),
    });
    await manager.updateAccountQuota(healthy.id, {
      groups: [group("Gemini", 0.5, 0.5), group("Claude & GPT", 0.5, 0)],
    });

    assert.deepEqual((await manager.getCandidateAccounts("gemini")).map((account) => account.id), [healthy.id, empty.id]);
    assert.deepEqual((await manager.getCandidateAccounts("claude")).map((account) => account.id), [empty.id, healthy.id]);
  } finally {
    await cleanup();
  }
});
