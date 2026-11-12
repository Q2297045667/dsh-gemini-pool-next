// Builds test/fixtures/status-value.json from the LIVE /antigravity-pool-next/api/status response,
// with all personally identifying values replaced by synthetic ones of the same shape.
//
// The fixture is committed, so it must never contain the real account email, account id,
// or tokens. Structure (keys, nesting, model ids, quota bucket names) is preserved verbatim
// because that is exactly what the render path needs to be exercised against.
//
// Usage: node test/fixtures/build-fixture.mjs [--port 3080]

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? process.argv[portArg + 1] : "3080";

const REDACTIONS = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "user@example.com"],
  [/\bacc_[A-Za-z0-9]+/g, "acc_0000000"],
  [/\b(ya29|1\/\/)[A-Za-z0-9._-]+/g, "REDACTED_TOKEN"],
];

function scrub(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

const url = `http://127.0.0.1:${PORT}/antigravity-pool-next/api/status`;
const response = await fetch(url, { method: "GET" });
if (!response.ok) {
  throw new Error(`status probe failed: HTTP ${response.status} from ${url}`);
}
const body = await response.json();
if (!body || body.ok !== true || !body.value) {
  throw new Error(`unexpected status envelope from ${url}: ${JSON.stringify(body).slice(0, 200)}`);
}

const scrubbed = scrub(body.value);

// Fail loudly rather than silently committing PII.
const serialized = JSON.stringify(scrubbed, null, 2);
const leaked = serialized.match(/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/g);
if (leaked) {
  throw new Error(`refusing to write fixture: unscrubbed email(s) present: ${leaked.join(", ")}`);
}

const target = join(here, "..", "test", "fixtures", "status-value.json");
writeFileSync(target, serialized + "\n", "utf8");

console.log(`wrote ${target}`);
console.log(`  accounts: ${Array.isArray(scrubbed.accounts) ? scrubbed.accounts.length : 0}`);
console.log(`  models:   ${scrubbed.models && Array.isArray(scrubbed.models.options) ? scrubbed.models.options.length : 0}`);
console.log(`  quota:    ${scrubbed.accounts && scrubbed.accounts[0] ? (scrubbed.accounts[0].quota ? "present" : "null") : "n/a"}`);
