import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalogModels } from "../lib/index.js";

function modelsPayload(entries) {
  const models = {};
  for (const [id, info] of Object.entries(entries)) models[id] = info;
  return { models };
}

test("a base model with a matching backend entity is available with its quota", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-4-argon-high": {
      displayName: "Gemini 4 Argon (High)",
      quotaInfo: { remainingFraction: 0.62 },
    },
    "gemini-3.8-flash-low": {
      displayName: "Gemini 3.8 Flash (Low)",
      quotaInfo: { remainingFraction: 0.31 },
    },
    "claude-opus-5-5-high": {
      displayName: "Claude Opus 5.5 (Thinking)",
      quotaInfo: { remainingFraction: 0.8 },
    },
  }));
  const byId = new Map(catalog.map((m) => [m.id, m]));
  assert.equal(byId.get("gemini-4-argon").available, true);
  assert.equal(byId.get("gemini-4-argon").remainingFraction, 0.62);
  assert.equal(byId.get("gemini-3.8-flash").available, true);
  assert.equal(byId.get("gemini-3.8-flash").remainingFraction, 0.31);
  assert.equal(byId.get("claude-opus-5.5").available, true);
  assert.equal(byId.get("claude-opus-5.5").remainingFraction, 0.8);
});

test("a base model without any matching entity is unavailable (Refs #16)", () => {
  // Free-plan account: only the everyday Gemini entities exist.
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-3.5-flash-low": { displayName: "Gemini 3.5 Flash (Low)" },
    "gemini-3-flash": { displayName: "Gemini 3 Flash" },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
  }));
  const byId = new Map(catalog.map((m) => [m.id, m]));
  assert.equal(byId.get("gemini-4-argon").available, false);
  assert.equal(byId.get("gemini-4-argon").remainingFraction, undefined);
  assert.equal(byId.get("claude-opus-5.5").available, false);
  assert.equal(byId.get("claude-sonnet-5.5").available, false);
  // Generations the backend never advertised are not catalogued at all.
  assert.equal(byId.get("gemini-3.7-flash"), undefined);
  assert.equal(byId.get("gemini-3.8-flash").available, true);
  assert.equal(byId.get("gpt-oss-120b").available, true);
});

test("sonnet 4.6 matches its bare backend entity, not a -thinking one", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)" },
  }));
  const entry = catalog.find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(entry, "consolidated sonnet 4.6 entry exists");
  assert.equal(entry.available, true);
  // The thinking-labelled sibling must not leak as a separate base entry.
  assert.ok(!catalog.some((m) => m.id === "claude-sonnet-4-6-thinking"));
});

test("Claude 5.5 entities do not make removed 4.6 models available", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 0.7 } },
    "claude-sonnet-5-5-high": { quotaInfo: { remainingFraction: 0.4 } },
  }));
  for (const family of ["opus", "sonnet"]) {
    const entry = catalog.find((m) => m.id === `claude-${family}-4-6`);
    assert.equal(entry.available, false);
    assert.equal(entry.remainingFraction, undefined);
  }
});

test("internal and chat_ entities are ignored", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "chat_ultra_secret": { displayName: "Secret" },
    "gemini-4-argon-high": { isInternal: true },
  }));
  const raw = catalog.find((m) => m.id === "chat_ultra_secret" || m.id === "gemini-4-argon-high");
  assert.equal(raw, undefined);
});
