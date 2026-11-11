import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODELS,
  ROUTING,
  baseModelMatcher,
  canonicalModelId,
  compareAntigravityModels,
  familyFallbackBases,
  getMaxOutputTokens,
  inferModelShape,
  modelById,
  reasoningLevelsForModel,
  runtimeEntityCandidates,
  splitEntityId,
  staticRequestModelId,
} from "../lib/models.js";

/** The entities a paid (Google AI Pro) project advertises with a current fingerprint. */
const LIVE_ENTITIES = new Set([
  "claude-opus-5-5-high",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-sonnet-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-tiered",
  "gemini-4-argon-high",
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gpt-oss-120b-medium",
]);

test("the revamped Pro catalog lists the four requested models", () => {
  for (const id of ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5.5", "claude-sonnet-5.5"]) {
    assert.ok(modelById(id), "model " + id + " must be catalogued");
  }
  const argon = modelById("gemini-4-argon");
  assert.deepEqual(argon.inputModalities, ["text", "image"]);
  assert.equal(argon.contextWindow, 1048576);
  assert.equal(argon.maxTokens, 65536);
  // The flagship advertises one entity per level (low/medium/high).
  assert.deepEqual(argon.reasoningEfforts, ["low", "medium", "high"]);
});

test("reasoning models offer every thinking level the backend can pin", () => {
  // More levels per model is the point of the reasoning control: the adapter
  // maps each level onto a real entity (Claude 5.5, lite models), onto
  // thinkingConfig (tiered Gemini), or keeps the declared ceiling when the
  // account only advertises a bare entity.
  const expected = {
    "gemini-4-argon": ["low", "medium", "high"],
    "gemini-3.8-flash": ["minimal", "low", "medium", "high"],
    "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
    "gemini-3-flash": ["minimal", "low", "medium", "high"],
    "gemini-3.5-flash-lite": ["low", "medium", "high"],
    "gemini-3.1-flash-lite": ["low", "medium", "high"],
    "claude-opus-5.5": ["low", "medium", "high"],
    "claude-sonnet-5.5": ["low", "medium", "high"],
    "gpt-oss-120b": ["medium"],
  };
  for (const [id, levels] of Object.entries(expected)) {
    assert.deepEqual(modelById(id).reasoningEfforts, levels, id);
  }
  const order = ["minimal", "low", "medium", "high", "xhigh"];
  for (const model of MODELS) {
    const indexes = model.reasoningEfforts.map((level) => order.indexOf(level));
    assert.ok(indexes.every((index) => index >= 0), model.id + " declared an unknown level");
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), model.id + " levels must be ordered");
  }
});

test("new model routing resolves to the backend-advertised entities", () => {
  const argon = ROUTING["gemini-4-argon"];
  // Each effort keeps its own entity; only "off" falls back to the flagship level.
  assert.equal(argon.off, "gemini-4-argon-high");
  assert.equal(argon.routing.low, "gemini-4-argon-low");
  assert.equal(argon.routing.minimal, "gemini-4-argon-low");
  assert.equal(argon.routing.medium, "gemini-4-argon-medium");
  assert.equal(argon.routing.high, "gemini-4-argon-high");
  assert.equal(ROUTING["claude-opus-5.5"].defaultRequestId, "claude-opus-5-5-high");
  assert.equal(ROUTING["claude-sonnet-5.5"].defaultRequestId, "claude-sonnet-5-5-high");
  // Gemini 3.8 exposes per-level siblings under a current client fingerprint.
  assert.equal(ROUTING["gemini-3.8-flash"].off, "gemini-3.8-flash-low");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.low, "gemini-3.8-flash-low");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.medium, "gemini-3.8-flash-medium");
  assert.equal(ROUTING["gemini-3.8-flash"].routing.high, "gemini-3.8-flash-high");
  // Generations the backend never advertised are gone from the catalog.
  assert.equal(ROUTING["gemini-3.7-flash"], undefined);
  assert.equal(modelById("gemini-3.7-flash"), undefined);
  assert.equal(modelById("gemini-3.6-flash"), undefined);
  // Claude 5.5 exposes one entity per level, so each effort keeps its own id.
  assert.equal(ROUTING["claude-opus-5.5"].routing.low, "claude-opus-5-5-low");
  assert.equal(ROUTING["claude-opus-5.5"].routing.medium, "claude-opus-5-5-medium");
  assert.equal(ROUTING["claude-opus-5.5"].routing.high, "claude-opus-5-5-high");
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
  assert.ok(baseModelMatcher("gemini-3.8-flash")("gemini-3.8-flash-tiered"));
  // Reflected regression: 3.8 matching must not alias 3.7 entities.
  assert.ok(!baseModelMatcher("gemini-3.8-flash")("gemini-3.7-flash-low"));
});

test("matching is structural, so a sibling variant never makes another model available", () => {
  // A lite/flash-lite sibling is a different model, not an alias.
  assert.equal(baseModelMatcher("gemini-3.5-flash")("gemini-3.5-flash-lite"), false);
  assert.equal(baseModelMatcher("gemini-2.5-flash")("gemini-2.5-flash-lite"), false);
  assert.equal(baseModelMatcher("gemini-2.5-flash")("gemini-3.1-flash-lite"), false);
  assert.equal(baseModelMatcher("gemini-3.1-flash-lite")("gemini-3.1-flash-lite"), true);
  // The legacy -thinking sibling still belongs to its base model.
  assert.equal(baseModelMatcher("gemini-2.5-flash")("gemini-2.5-flash-thinking"), true);
  // Agents-era aliases stay attached to the model they stand for.
  assert.equal(baseModelMatcher("gemini-3.5-flash")("gemini-3-flash-agent"), true);
  assert.equal(baseModelMatcher("gemini-3-flash")("gemini-3-flash-agent"), false);
  assert.equal(baseModelMatcher("gemini-3.1-pro")("gemini-pro-agent"), true);
  // Text and image models never share rows.
  assert.equal(baseModelMatcher("gemini-3-flash")("gemini-3.1-flash-image"), false);
});

test("splitEntityId names the base model and how the level is carried", () => {
  assert.deepEqual(splitEntityId("gemini-3.8-flash-tiered"), {
    base: "gemini-3-8-flash",
    kind: "tiered",
    level: undefined,
  });
  assert.deepEqual(splitEntityId("claude-opus-5-5-medium"), {
    base: "claude-opus-5-5",
    kind: "level",
    level: "medium",
  });
  assert.equal(splitEntityId("gemini-3-flash").kind, "bare");
  assert.equal(splitEntityId("claude-opus-4-6-thinking").kind, "thinking");
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

test("runtime entities follow what the account advertises, never a phantom id", () => {
  const argon = runtimeEntityCandidates("gemini-4-argon", "high", LIVE_ENTITIES);
  assert.equal(argon[0], "gemini-4-argon-high");
  assert.equal(runtimeEntityCandidates("gemini-4-argon", "low", LIVE_ENTITIES)[0], "gemini-4-argon-low");
  assert.equal(runtimeEntityCandidates("gemini-4-argon", "medium", LIVE_ENTITIES)[0], "gemini-4-argon-medium");
  // Nothing the pool does not have can appear in the candidate list.
  assert.ok(argon.every((id) => LIVE_ENTITIES.has(id)));

  // An account without the flagship still lands on an advertised entity of the
  // same family instead of being sent to a phantom id.
  const withoutArgon = new Set([...LIVE_ENTITIES].filter((id) => !id.includes("argon")));
  const fallback = runtimeEntityCandidates("gemini-4-argon", "high", withoutArgon);
  assert.equal(fallback[0], "gemini-3.8-flash-high");
  assert.ok(fallback.every((id) => withoutArgon.has(id)));

  const flash = runtimeEntityCandidates("gemini-3.8-flash", "medium", LIVE_ENTITIES);
  assert.equal(flash[0], "gemini-3.8-flash-medium");

  const opus = runtimeEntityCandidates("claude-opus-5.5", "medium", LIVE_ENTITIES);
  assert.equal(opus[0], "claude-opus-5-5-medium");
  // Step down within the same model before borrowing another one.
  assert.equal(opus[1], "claude-opus-5-5-low");
});

test("per-level siblings win over a tiered entity when the account has both", () => {
  const entities = new Set(["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-tiered"]);
  assert.equal(runtimeEntityCandidates("gemini-3.8-flash", "medium", entities)[0], "gemini-3.8-flash-medium");
  // A requested level the account lacks falls back to the next available level.
  assert.equal(runtimeEntityCandidates("gemini-3.8-flash", "high", entities)[0], "gemini-3.8-flash-medium");
});

test("an image model never resolves onto a text model", () => {
  const entities = new Set(["gemini-3-flash", "gemini-3.1-flash-image"]);
  assert.deepEqual(runtimeEntityCandidates("gemini-3.1-flash-image", "off", entities), ["gemini-3.1-flash-image"]);
});

test("thinking levels reflect the live entities of the account", () => {
  assert.deepEqual(
    reasoningLevelsForModel("claude-opus-5.5", [
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
    ]),
    ["low", "medium", "high"],
  );
  // A tiered entity serves every tiered level through thinkingConfig.
  assert.deepEqual(
    reasoningLevelsForModel("gemini-3.8-flash", ["gemini-3.8-flash-tiered"]),
    ["minimal", "low", "medium", "high"],
  );
  // Bare-only entities keep their declared ceiling and never invent a level.
  assert.deepEqual(reasoningLevelsForModel("gemini-2.5-pro", ["gemini-2.5-pro"]), ["low", "high"]);
  assert.deepEqual(reasoningLevelsForModel("gpt-oss-120b", ["gpt-oss-120b-medium"]), ["medium"]);
});

test("Gemini 4 Carbon is a first-class catalog model capped at 262144", () => {
  const carbon = modelById("gemini-4-carbon");
  assert.ok(carbon, "gemini-4-carbon must be catalogued");
  assert.equal(carbon.name, "Gemini 4 Carbon");
  assert.deepEqual(carbon.inputModalities, ["text", "image"]);
  assert.equal(carbon.contextWindow, 1048576);
  assert.equal(carbon.maxTokens, 262144);
  assert.deepEqual(carbon.reasoningEfforts, ["low", "medium", "high"]);
  assert.match(carbon.description, /Ultra/i);
  // Ultra-only: selectable only once the account's live catalog serves it.
  assert.equal(carbon.available, false);
  // The backend's disabled placeholder is never a public model of its own.
  assert.equal(modelById("gemini-4-carbon-disabled"), undefined);
  assert.equal(modelById("gemini-4-carbon-high"), undefined);
});

test("Gemini 4 Carbon routing mirrors Argon's per-level entities", () => {
  const carbon = ROUTING["gemini-4-carbon"];
  assert.ok(carbon, "gemini-4-carbon must have a routing entry");
  assert.equal(carbon.off, "gemini-4-carbon-high");
  assert.equal(carbon.defaultRequestId, "gemini-4-carbon-high");
  assert.equal(carbon.routing.minimal, "gemini-4-carbon-low");
  assert.equal(carbon.routing.low, "gemini-4-carbon-low");
  assert.equal(carbon.routing.medium, "gemini-4-carbon-medium");
  assert.equal(carbon.routing.high, "gemini-4-carbon-high");
  assert.equal(carbon.routing.xhigh, "gemini-4-carbon-high");
  assert.equal(staticRequestModelId("gemini-4-carbon", "off"), "gemini-4-carbon-high");
  assert.equal(staticRequestModelId("gemini-4-carbon", undefined), "gemini-4-carbon-high");
  assert.equal(staticRequestModelId("gemini-4-carbon", "low"), "gemini-4-carbon-low");
  assert.equal(staticRequestModelId("gemini-4-carbon", "medium"), "gemini-4-carbon-medium");
  assert.equal(staticRequestModelId("gemini-4-carbon", "high"), "gemini-4-carbon-high");
  // The disabled placeholder never gets a routing entry of its own.
  assert.equal(ROUTING["gemini-4-carbon-disabled"], undefined);
});

test("Gemini 4 Carbon keeps its 262144 output ceiling on every entity", () => {
  for (const runtimeModel of [
    "gemini-4-carbon",
    "gemini-4-carbon-low",
    "gemini-4-carbon-medium",
    "gemini-4-carbon-high",
    "gemini-4-carbon-disabled",
  ]) {
    assert.equal(getMaxOutputTokens("gemini-4-carbon", runtimeModel), 262144, runtimeModel);
    assert.equal(getMaxOutputTokens("gemini-4-carbon-disabled", runtimeModel), 262144, runtimeModel);
  }
  // Other models keep their own ceilings.
  assert.equal(getMaxOutputTokens("gemini-4-argon", "gemini-4-argon-high"), 65536);
  assert.equal(getMaxOutputTokens("claude-opus-5.5", "claude-opus-5-5-high"), 64000);
});

test("Gemini 4 Carbon matcher and entity splitter recognise live and disabled ids", () => {
  const matches = baseModelMatcher("gemini-4-carbon");
  assert.ok(matches("gemini-4-carbon"));
  assert.ok(matches("gemini-4-carbon-low"));
  assert.ok(matches("gemini-4-carbon-medium"));
  assert.ok(matches("gemini-4-carbon-high"));
  // The live Pro-plan payload advertises only this placeholder.
  assert.ok(matches("gemini-4-carbon-disabled"));
  // Label matching covers the backend display names.
  assert.ok(matches("Gemini 4 Carbon"));
  assert.ok(matches("Gemini 4 Carbon (High)"));
  // Structural matching still refuses neighbouring models.
  assert.equal(matches("gemini-4-argon-high"), false);
  assert.equal(matches("gemini-3.8-flash-high"), false);
  assert.equal(baseModelMatcher("gemini-4-argon")("gemini-4-carbon-high"), false);

  assert.deepEqual(splitEntityId("gemini-4-carbon-high"), {
    base: "gemini-4-carbon",
    kind: "level",
    level: "high",
  });
  assert.deepEqual(splitEntityId("gemini-4-carbon-disabled"), {
    base: "gemini-4-carbon",
    kind: "disabled",
    level: undefined,
  });
  assert.equal(canonicalModelId("Gemini-4-Carbon-High"), "gemini-4-carbon-high");
  assert.equal(canonicalModelId("gemini-4-carbon-disabled"), "gemini-4-carbon-disabled");

  assert.equal(inferModelShape("gemini-4-carbon").name, "Gemini 4 Carbon");
  assert.equal(inferModelShape("gemini-4-carbon-high").name, "Gemini 4 Carbon");
  assert.equal(inferModelShape("gemini-4-carbon-high").maxTokens, 262144);
  assert.equal(inferModelShape("gemini-4-carbon-disabled").name, "Gemini 4 Carbon");
  assert.equal(inferModelShape("gemini-4-carbon-disabled").maxTokens, 262144);
  assert.deepEqual(inferModelShape("gemini-4-carbon-low").reasoningEfforts, ["low", "medium", "high"]);
});

test("Gemini 4 Carbon is never a fallback target while it is unavailable", () => {
  const argonFallbacks = familyFallbackBases("gemini-4-argon");
  assert.equal(argonFallbacks.includes("gemini-4-carbon"), false);
  // Every other fallback is untouched.
  assert.ok(argonFallbacks.includes("gemini-3.8-flash"));
  // Carbon may still step down onto the rest of its own family.
  assert.ok(familyFallbackBases("gemini-4-carbon").includes("gemini-4-argon"));
  // Offline fallback resolution therefore cannot invent a carbon entity.
  assert.equal(staticRequestModelId("gemini-4-argon", "high"), "gemini-4-argon-high");
});

test("a synthetic entity set containing the disabled placeholder never routes to it", () => {
  // Even if unfiltered payload data reached the resolver, the placeholder is
  // not a candidate id: it never appears in a candidate list.
  assert.deepEqual(runtimeEntityCandidates("gemini-4-carbon", "high", new Set(["gemini-4-carbon-disabled"])), []);
  const mixed = new Set(["gemini-4-carbon-disabled", "gemini-4-argon-high", "gemini-3.8-flash-low"]);
  const candidates = runtimeEntityCandidates("gemini-4-carbon", "high", mixed);
  assert.equal(candidates[0], "gemini-4-argon-high");
  assert.ok(
    candidates.every((id) => id !== "gemini-4-carbon-disabled"),
    "the backend-disabled placeholder must never be requested",
  );
  // Other models are unaffected by the placeholder in the set.
  assert.equal(runtimeEntityCandidates("gemini-4-argon", "high", mixed)[0], "gemini-4-argon-high");
});

test("usable Gemini 4 Carbon entities route per level like Argon", () => {
  const entities = new Set(["gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high"]);
  assert.deepEqual(runtimeEntityCandidates("gemini-4-carbon", "high", entities), [
    "gemini-4-carbon-high",
    "gemini-4-carbon-medium",
    "gemini-4-carbon-low",
  ]);
  assert.equal(runtimeEntityCandidates("gemini-4-carbon", "medium", entities)[0], "gemini-4-carbon-medium");
  assert.equal(runtimeEntityCandidates("gemini-4-carbon", "low", entities)[0], "gemini-4-carbon-low");
  assert.equal(runtimeEntityCandidates("gemini-4-carbon", "off", entities)[0], "gemini-4-carbon-high");
  assert.deepEqual(reasoningLevelsForModel("gemini-4-carbon", [...entities]), ["low", "medium", "high"]);
  // A requested level the account lacks steps down within carbon first.
  const short = new Set(["gemini-4-carbon-low", "gemini-4-carbon-medium"]);
  assert.equal(runtimeEntityCandidates("gemini-4-carbon", "high", short)[0], "gemini-4-carbon-medium");
  // The level suffix pins the level, so no thinking option may ride along.
  assert.equal(splitEntityId("gemini-4-carbon-high").kind, "level");
});
