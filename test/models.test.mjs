import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODELS,
  ROUTING,
  baseModelMatcher,
  compareAntigravityModels,
  getMaxOutputTokens,
  inferModelShape,
  modelById,
} from "../lib/models.js";

test("the revamped Pro catalog lists the four requested models", () => {
  for (const id of ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5.5", "claude-sonnet-5.5"]) {
    assert.ok(modelById(id), "model " + id + " must be catalogued");
  }
  const argon = modelById("gemini-4-argon");
  assert.deepEqual(argon.inputModalities, ["text", "image"]);
  assert.equal(argon.contextWindow, 1048576);
  assert.equal(argon.maxTokens, 65536);
  assert.deepEqual(argon.reasoningEfforts, ["high"]);
});

test("new model routing resolves to the backend-advertised entities", () => {
  const argon = ROUTING["gemini-4-argon"];
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    const resolved =
      effort === "off" || effort === undefined
        ? argon.off
        : argon.routing[effort] ?? argon.defaultRequestId;
    assert.equal(resolved, "gemini-4-argon-high", "gemini-4-argon @ " + effort);
  }
  assert.equal(ROUTING["claude-opus-5.5"].defaultRequestId, "claude-opus-5-5-high");
  assert.equal(ROUTING["claude-sonnet-5.5"].defaultRequestId, "claude-sonnet-5-5-high");
  // gemini-3.8-flash now routes per level instead of the rollout-era tiered id.
  assert.equal(ROUTING["gemini-3.8-flash"].off, "gemini-3.8-flash-low");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.low, "gemini-3.8-flash-low");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.medium, "gemini-3.8-flash-medium");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.high, "gemini-3.8-flash-high");
  assert.equal(ROUTING["gemini-3.7-flash"].routing.high, "gemini-3.7-flash-high");
  // Sonnet 4.6 is advertised by the backend as the bare id (display: Thinking).
  assert.equal(ROUTING["claude-sonnet-4-6"].routing.high, "claude-sonnet-4-6");
  assert.equal(ROUTING["claude-opus-4-6"].routing.high, "claude-opus-4-6-thinking");
});

test("runtime token limits cover the new entities", () => {
  assert.equal(getMaxOutputTokens("gemini-4-argon", "gemini-4-argon-high"), 65536);
  assert.equal(getMaxOutputTokens("claude-opus-5.5", "claude-opus-5-5-high"), 64000);
  assert.equal(getMaxOutputTokens("claude-sonnet-5.5", "claude-sonnet-5-5-high"), 64000);
  assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-medium"), 65536);
});

test("baseModelMatcher matches backend entity ids and labels", () => {
  assert.ok(baseModelMatcher("gemini-4-argon")("gemini-4-argon-high"));
  assert.ok(baseModelMatcher("gemini-4-argon")("Gemini 4 Argon (High)"));
  assert.ok(baseModelMatcher("claude-opus-5.5")("claude-opus-5-5-high"));
  assert.ok(baseModelMatcher("claude-opus-5.5")("Claude Opus 5.5 (Thinking)"));
  assert.ok(baseModelMatcher("claude-sonnet-5.5")("claude-sonnet-5-5-high"));
  assert.ok(baseModelMatcher("gemini-3.8-flash")("gemini-3.8-flash-low"));
  // Reflected regression: 3.8 matching must not alias 3.7 entities.
  assert.ok(!baseModelMatcher("gemini-3.8-flash")("gemini-3.7-flash-low"));
});

test("Claude 4.6 matchers do not borrow availability from another version", () => {
  for (const family of ["opus", "sonnet"]) {
    const matches = baseModelMatcher(`claude-${family}-4-6`);
    assert.ok(matches(`claude-${family}-4-6-thinking`));
    assert.ok(matches(`Claude ${family} 4.6 (Thinking)`));
    assert.equal(matches(`claude-${family}-5-5-high`), false);
    assert.equal(matches(`Claude ${family} 5.5 (Thinking)`), false);
    assert.equal(matches(`claude-${family}-4-5-thinking`), false);
  }
});

test("inferred shapes strip the level suffix of revamped entities", () => {
  assert.equal(inferModelShape("gemini-4-argon-high").name, "Gemini 4 Argon");
  assert.equal(inferModelShape("gemini-3.8-flash-medium").name, "Gemini 3.8 Flash");
  assert.equal(inferModelShape("claude-sonnet-5-5-high").name, "Claude Sonnet 5.5");
  assert.equal(inferModelShape("claude-opus-5-5-high").name, "Claude Opus 5.5");
  assert.ok(inferModelShape("gemini-4-argon-high").inputModalities.includes("image"));
});

test("catalog ordering puts the new flagship first and Claude 5.5 above 4.6", () => {
  const gemini = MODELS.filter((m) => m.id.startsWith("gemini")).sort(compareAntigravityModels);
  assert.equal(gemini[0].id, "gemini-4-argon");
  const claude = MODELS.filter((m) => m.id.startsWith("claude")).sort(compareAntigravityModels);
  assert.ok(claude[0].id.endsWith("5.5"), "expected a 5.5 model first, got " + claude[0].id);
  const opusIdx = claude.findIndex((m) => m.id === "claude-opus-5.5");
  const sonnetIdx = claude.findIndex((m) => m.id === "claude-sonnet-5.5");
  const opus46Idx = claude.findIndex((m) => m.id === "claude-opus-4-6");
  assert.ok(opusIdx < opus46Idx && sonnetIdx < opus46Idx, "5.5 models must sort before 4.6");
});

test("Claude 4.6 models are marked deprecated with the removal date", () => {
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
    const model = modelById(id);
    assert.equal(model.deprecated, true);
    assert.match(model.description, /2026-11-18/);
  }
  assert.equal(modelById("claude-opus-5.5").deprecated, undefined);
});
