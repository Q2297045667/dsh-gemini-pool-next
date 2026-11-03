import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/antigravity-login.mjs", import.meta.url));

for (const hasCredentials of [false, true]) {
  test(`CLI logout succeeds with ${hasCredentials ? "pooled and legacy credentials" : "an empty harness home"}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "gemini-cli-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const storages = join(home, "storages");
    const legacyFile = join(storages, "antigravity-oauth.json");
    const poolFile = join(storages, "antigravity-pool-accounts.json");
    if (hasCredentials) {
      await mkdir(storages);
      await writeFile(legacyFile, JSON.stringify({ access: "fake-access", refresh: "fake-refresh" }));
      await writeFile(poolFile, JSON.stringify({ accounts: [{ id: "test-account", email: "cli@example.com", access: "fake-access", refresh: "fake-refresh" }] }));
    }
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, "--logout"], {
      env: { ...process.env, DSH_HOME: home }, timeout: 5000,
    });
    assert.match(stdout, /Removed all Antigravity accounts/);
    assert.equal(stderr, "");
    await assert.rejects(readFile(legacyFile), { code: "ENOENT" });
    if (hasCredentials) assert.deepEqual(JSON.parse(await readFile(poolFile, "utf8")).accounts, []);
  });
}
