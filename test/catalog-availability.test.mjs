import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsableRuntimeModelId, parseCatalogModels } from "../lib/index.js";

function modelsPayload(entries) {
  const models = {};
  for (const [id, info] of Object.entries(entries)) models[id] = info;
  return { models };
}

/** The disabled placeholder the sandbox endpoint serves on a Pro account. */
const CARBON_DISABLED = {
  displayName: "Gemini 4 Carbon",
  supportsImages: true,
  supportsThinking: true,
  minThinkingBudget: 128,
  recommended: true,
  maxTokens: 1048576,
  maxOutputTokens: 262144,
  disabled: true,
  model: "MODEL_PLACEHOLDER_M670",
  apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
  modelProvider: "MODEL_PROVIDER_GOOGLE",
  supportsVideo: true,
  tagTitle: "Unavailable",
  tagDescription: "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
  thinkingLevel: 2,
};

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

test("a disabled placeholder yields an unavailable Carbon entry with the backend reason", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", quotaInfo: { remainingFraction: 0.4 } },
    "gemini-4-carbon-disabled": CARBON_DISABLED,
  }));
  const byId = new Map(catalog.map((model) => [model.id, model]));

  // The placeholder is not a catalog model of its own.
  assert.equal(byId.get("gemini-4-carbon-disabled"), undefined);
  assert.ok(!catalog.some((model) => model.id.includes("-disabled")), "no disabled entity may become a catalog model");

  // The consolidated public model stays visible but unavailable.
  const carbon = byId.get("gemini-4-carbon");
  assert.ok(carbon, "the consolidated Gemini 4 Carbon entry must stay in the catalog");
  assert.equal(carbon.available, false);
  assert.equal(carbon.remainingFraction, undefined);
  assert.equal(carbon.unavailableReason, "Gemini 4 Carbon is currently available to Ultra plan subscribers.");
  assert.equal(carbon.contextWindow, 1048576);
  assert.equal(carbon.maxTokens, 262144);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);
  assert.match(carbon.description, /Ultra/i);

  // Every other model keeps its own availability untouched.
  assert.equal(byId.get("gemini-4-argon").available, true);
  assert.equal(byId.get("gemini-4-argon").remainingFraction, 0.4);
  assert.equal(byId.get("gemini-3.8-flash").available, true);
  assert.equal(byId.get("gemini-3.5-flash").available, false);
});

test("non-disabled carbon entities make Carbon available and pin its levels", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)" },
    "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)", quotaInfo: { remainingFraction: 0.55 } },
    "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)" },
  }));
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const carbon = byId.get("gemini-4-carbon");
  assert.equal(carbon.available, true);
  assert.equal(carbon.remainingFraction, 0.55);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(carbon.unavailableReason, undefined);
  // The per-level entities are matched into the base model, never raw rows.
  assert.deepEqual(catalog.filter((model) => model.id.startsWith("gemini-4-carbon-")).map((model) => model.id), []);
});

test("tagTitle 'Unavailable' alone keeps an entity out of the catalog", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-4-carbon-high": {
      displayName: "Gemini 4 Carbon (High)",
      tagTitle: "Unavailable",
      tagDescription: "Ultra only.",
    },
  }));
  const byId = new Map(catalog.map((model) => [model.id, model]));
  assert.equal(byId.get("gemini-4-carbon-high"), undefined);
  const carbon = byId.get("gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.equal(carbon.unavailableReason, "Ultra only.");
});

test("infoRaw.disabled on a level entity is not availability evidence", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", disabled: true },
  }));
  const carbon = catalog.find((model) => model.id === "gemini-4-carbon");
  assert.equal(carbon.available, false);
  assert.ok(!catalog.some((model) => model.id === "gemini-4-carbon-high"));
});

test("a disabled entity without a public base never leaks as a raw model", () => {
  const catalog = parseCatalogModels(modelsPayload({
    "gemini-5-orion-disabled": { displayName: "Gemini 5 Orion", disabled: true },
    "gemini-3.8-flash-low": {},
  }));
  assert.ok(!catalog.some((model) => model.id.includes("disabled")));
});

test("isUsableRuntimeModelId rejects disabled placeholders and keeps normal entities", () => {
  assert.equal(isUsableRuntimeModelId("gemini-4-carbon-disabled"), false);
  assert.equal(isUsableRuntimeModelId("gemini-4-carbon"), true);
  assert.equal(isUsableRuntimeModelId("gemini-4-carbon-high"), true);
  assert.equal(isUsableRuntimeModelId("claude-opus-5-5-high"), true);
  assert.equal(isUsableRuntimeModelId("gpt-oss-120b-medium"), true);
  assert.equal(isUsableRuntimeModelId("MODEL_PLACEHOLDER_M670"), false);
  assert.equal(isUsableRuntimeModelId("chat_20706"), false);
  assert.equal(isUsableRuntimeModelId("has whitespace"), false);
});
