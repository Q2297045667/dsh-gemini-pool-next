/**
 * Static model catalog and pure model helpers for the Antigravity adapter.
 * Extracted verbatim from lib/index.js (no behavior change).
 */

export const ROUTING = {
  // Google AI Pro flagship. With a current client fingerprint the backend
  // advertises one entity per thinking level: gemini-4-argon-low/medium/high.
  "gemini-4-argon": {
    off: "gemini-4-argon-high",
    routing: {
      minimal: "gemini-4-argon-low",
      low: "gemini-4-argon-low",
      medium: "gemini-4-argon-medium",
      high: "gemini-4-argon-high",
      xhigh: "gemini-4-argon-high",
    },
    defaultRequestId: "gemini-4-argon-high",
  },
  // A current fingerprint advertises the per-level Gemini 3.8 entities, so the
  // static table prefers them; older fingerprints only expose the rollout-era
  // tiered entity, which the live resolver in lib/index.js still reaches as a
  // fallback (a tiered entity selects its level through thinkingConfig).
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-low",
    routing: {
      minimal: "gemini-3.8-flash-low",
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
      xhigh: "gemini-3.8-flash-high",
    },
    defaultRequestId: "gemini-3.8-flash-low",
  },
  // Claude 5.5 models (Google AI Pro paid / Ultra / Enterprise). The backend
  // advertises the thinking entities verbatim with dash versions: claude-*-5-5-high.
  "claude-opus-5.5": {
    off: "claude-opus-5-5-high",
    routing: {
      minimal: "claude-opus-5-5-low",
      low: "claude-opus-5-5-low",
      medium: "claude-opus-5-5-medium",
      high: "claude-opus-5-5-high",
      xhigh: "claude-opus-5-5-high",
    },
    defaultRequestId: "claude-opus-5-5-high",
  },
  "claude-sonnet-5.5": {
    off: "claude-sonnet-5-5-high",
    routing: {
      minimal: "claude-sonnet-5-5-low",
      low: "claude-sonnet-5-5-low",
      medium: "claude-sonnet-5-5-medium",
      high: "claude-sonnet-5-5-high",
      xhigh: "claude-sonnet-5-5-high",
    },
    defaultRequestId: "claude-sonnet-5-5-high",
  },
  "claude-opus-4-6": {
    off: "claude-opus-4-6-thinking",
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
      xhigh: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  // Live fetchAvailableModels advertises the bare id (display: Thinking), not
  // a separate *-thinking entity, for Sonnet 4.6.
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-pro-agent",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-pro-agent",
  },
  "gemini-3.1-flash-image": {
    off: "gemini-3.1-flash-image",
    routing: {
      minimal: "gemini-3.1-flash-image",
      low: "gemini-3.1-flash-image",
      medium: "gemini-3.1-flash-image",
      high: "gemini-3.1-flash-image",
      xhigh: "gemini-3.1-flash-image",
    },
    defaultRequestId: "gemini-3.1-flash-image",
  },
  "gemini-3-flash": {
    off: "gemini-3-flash",
    routing: {
      minimal: "gemini-3-flash",
      low: "gemini-3-flash",
      medium: "gemini-3-flash",
      high: "gemini-3-flash",
      xhigh: "gemini-3-flash",
    },
    defaultRequestId: "gemini-3-flash",
  },
  "gemini-2.5-pro": {
    off: "gemini-2.5-pro",
    routing: {
      minimal: "gemini-2.5-pro",
      low: "gemini-2.5-pro",
      medium: "gemini-2.5-pro",
      high: "gemini-2.5-pro",
      xhigh: "gemini-2.5-pro",
    },
    defaultRequestId: "gemini-2.5-pro",
  },
  "gemini-2.5-flash": {
    off: "gemini-2.5-flash",
    routing: {
      minimal: "gemini-2.5-flash",
      low: "gemini-2.5-flash",
      medium: "gemini-2.5-flash",
      high: "gemini-2.5-flash",
      xhigh: "gemini-2.5-flash",
    },
    defaultRequestId: "gemini-2.5-flash",
  },
  // Flash-Lite entities are advertised as bare ids (no per-level siblings),
  // so they never carry a thinking level.
  "gemini-3.5-flash-lite": {
    off: "gemini-3.5-flash-lite",
    routing: {
      minimal: "gemini-3.5-flash-lite",
      low: "gemini-3.5-flash-lite",
      medium: "gemini-3.5-flash-lite",
      high: "gemini-3.5-flash-lite",
      xhigh: "gemini-3.5-flash-lite",
    },
    defaultRequestId: "gemini-3.5-flash-lite",
  },
  "gemini-3.1-flash-lite": {
    off: "gemini-3.1-flash-lite",
    routing: {
      minimal: "gemini-3.1-flash-lite",
      low: "gemini-3.1-flash-lite",
      medium: "gemini-3.1-flash-lite",
      high: "gemini-3.1-flash-lite",
      xhigh: "gemini-3.1-flash-lite",
    },
    defaultRequestId: "gemini-3.1-flash-lite",
  },
  "gemini-2.5-flash-lite": {
    off: "gemini-2.5-flash-lite",
    routing: {
      minimal: "gemini-2.5-flash-lite",
      low: "gemini-2.5-flash-lite",
      medium: "gemini-2.5-flash-lite",
      high: "gemini-2.5-flash-lite",
      xhigh: "gemini-2.5-flash-lite",
    },
    defaultRequestId: "gemini-2.5-flash-lite",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
      xhigh: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};
export const RUNTIME_MAX_OUTPUT_TOKENS = {
  "gemini-4-argon": 65536,
  "gemini-4-argon-high": 65536,
  "gemini-3.8-flash": 65536,
  // Retain rollout-era tiered ids for compatibility with pinned runtime
  // overrides; the live catalog advertises the explicit level entities.
  "gemini-3.8-flash-tiered": 65536,
  "gemini-3.8-flash-low": 65536,
  "gemini-3.8-flash-medium": 65536,
  "gemini-3.8-flash-high": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-lite": 65536,
  "gemini-3.1-flash-lite": 65536,
  "gemini-2.5-flash-lite": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-5.5": 64000,
  "claude-opus-5-5-high": 64000,
  "claude-sonnet-5.5": 64000,
  "claude-sonnet-5-5-high": 64000,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "claude-sonnet-4-6-thinking": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};
export const MODELS = [
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
    description: "Removed by Antigravity on 2026-11-18; will stop working then.",
    deprecated: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
    description: "Removed by Antigravity on 2026-11-18; will stop working then.",
    deprecated: true,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    inputModalities: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ["medium"],
  },
];
function extractModelVersion(model) {
  const name = String(model?.name || "");
  const id = String(model?.id || model?.modelId || "");
  const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || id.match(/\b(\d+(?:\.\d+)+)\b/);
  if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || name.match(/\b(\d+(?:\.\d+)+)\b/);
  if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  return [0];
}

function compareVersionsDesc(v1, v2) {
  const len = Math.max(v1.length, v2.length);
  for (let i = 0; i < len; i++) {
    const num1 = v1[i] !== undefined ? v1[i] : 0;
    const num2 = v2[i] !== undefined ? v2[i] : 0;
    if (num1 !== num2) return num2 - num1;
  }
  return 0;
}

function getFamilyOrder(model) {
  const text = `${model?.id || ""} ${model?.name || ""}`.toLowerCase();
  if (text.includes("gemini")) return 1;
  if (text.includes("claude")) return 2;
  if (text.includes("gpt")) return 3;
  return 4;
}

function getVariantScore(model) {
  const text = `${model?.name || ""} ${model?.id || ""}`.toLowerCase();
  if (text.includes("ultra")) return 1;
  if (text.includes("pro") && !text.includes("lite")) return 2;
  if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
  if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
  if (text.includes("image")) return 5;
  if (text.includes("lite") && !text.includes("thinking")) return 6;
  if (text.includes("lite") && text.includes("thinking")) return 7;
  return 10;
}
export function compareAntigravityModels(a, b) {
  const famA = getFamilyOrder(a);
  const famB = getFamilyOrder(b);
  if (famA !== famB) return famA - famB;

  const verA = extractModelVersion(a);
  const verB = extractModelVersion(b);
  const verComp = compareVersionsDesc(verA, verB);
  if (verComp !== 0) return verComp;

  const variantA = getVariantScore(a);
  const variantB = getVariantScore(b);
  if (variantA !== variantB) return variantA - variantB;

  return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
}
export function modelNameFromId(id) {
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bOss\b/g, "OSS");
}

export function inferModelShape(modelId, info = {}) {
  const id = String(modelId);
  const staticModel = modelById(id);
  if (staticModel) return staticModel;
  const lower = id.toLowerCase();
  const maxTokens = getMaxOutputTokens(id, id);
  const inputModalities = info.supportsImages || /gemini|claude/i.test(id) ? ["text", "image"] : ["text"];
  const reasoningEfforts = lower.includes("gpt-oss")
    ? ["medium"]
    : lower.includes("claude")
      ? ["high"]
      : lower.includes("pro")
        ? ["low", "high"]
        : lower.includes("gemini")
          ? ["low", "medium", "high"]
          : [];
  let name = info.displayName || info.label || info.modelName || modelNameFromId(id);
  if (id === "gemini-3.8-flash-tiered") {
    name = "Gemini 3.8 Flash";
  }
  if (id === "gemini-3.7-flash-tiered") {
    name = "Gemini 3.7 Flash";
  }
  // Revamped-catalog entities carry the thinking level in the id suffix; the
  // human-facing name should stay the base model name (with the dotted
  // version spelling the catalog uses, e.g. Claude Sonnet 5.5).
  const levelSuffix = /-(low|medium|high)$/.exec(lower);
  if (levelSuffix && /^(gemini-4-argon|gemini-3\.\d-flash|claude-(opus|sonnet)-5-5)/.test(lower)) {
    const base = id.slice(0, -(levelSuffix[1].length + 1));
    name = modelNameFromId(base.replace(/^claude-(opus|sonnet)-5-5$/, "claude-$1-5.5"));
  }
  const idVer = extractModelVersion({ id });
  const nameVer = extractModelVersion({ name });
  if (
    idVer[0] !== 0 &&
    nameVer[0] !== 0 &&
    (idVer[0] !== nameVer[0] || (idVer[1] !== undefined && nameVer[1] !== undefined && idVer[1] !== nameVer[1]))
  ) {
    name = modelNameFromId(id);
  }
  return {
    id,
    name,
    inputModalities,
    contextWindow: lower.includes("claude") ? 200000 : lower.includes("gpt-oss") ? 131072 : 1048576,
    maxTokens,
    reasoningEfforts,
  };
}
/**
 * Canonical comparison key for a model or backend entity id: lowercase, with
 * the dotted version spelling collapsed to dashes so the catalog's
 * `claude-opus-5.5` and the backend's `claude-opus-5-5-high` share one base.
 */
export function canonicalModelId(id) {
  return String(id || "").trim().toLowerCase().replace(/\./g, "-");
}

/** Thinking levels a backend entity can be pinned to, weakest first. */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Levels a *tiered* entity exposes through thinkingConfig: one entity serves
 * every level because the request names the level instead of the id.
 */
export const TIERED_THINKING_LEVELS = ["minimal", "low", "medium", "high"];

/**
 * Backend entity ids whose base model cannot be derived from the id itself
 * (agents-era aliases that predate the per-model naming).
 */
const ENTITY_BASE_ALIASES = {
  "gemini-pro-agent": "gemini-3-1-pro",
  "gemini-3-flash-agent": "gemini-3-5-flash",
};

const ALIAS_ENTITIES_BY_BASE = {};
for (const [entityId, baseId] of Object.entries(ENTITY_BASE_ALIASES)) {
  (ALIAS_ENTITIES_BY_BASE[baseId] ||= []).push(entityId);
}

/**
 * Split a backend entity id into its base model and the way it expresses the
 * thinking level: an explicit `-low|-medium|-high` sibling entity, a
 * `-tiered` entity that takes thinkingConfig, a legacy `-thinking` sibling,
 * an aliased id, or a bare id that carries no level at all.
 */
export function splitEntityId(entityId) {
  const canonical = canonicalModelId(entityId);
  const aliased = ENTITY_BASE_ALIASES[canonical];
  if (aliased) return { base: aliased, kind: "alias", level: undefined };
  const levelMatch = /^(.*)-(minimal|low|medium|high|xhigh)$/.exec(canonical);
  if (levelMatch) return { base: levelMatch[1], kind: "level", level: levelMatch[2] };
  if (canonical.endsWith("-tiered")) {
    return { base: canonical.slice(0, -"-tiered".length), kind: "tiered", level: undefined };
  }
  if (canonical.endsWith("-thinking")) {
    return { base: canonical.slice(0, -"-thinking".length), kind: "thinking", level: undefined };
  }
  return { base: canonical, kind: "bare", level: undefined };
}

function canonicalDisplayName(text) {
  return String(text || "").trim().toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Match a backend entity id (or its human label) against one public model.
 *
 * Matching is structural — the entity must be the base id itself, a level /
 * tiered / thinking sibling of it, or the label `Name (Level)` — instead of a
 * loose family regex. A loose regex made `gemini-3.5-flash` claim
 * `gemini-3.5-flash-lite` rows and `gemini-2.5-flash` claim
 * `gemini-3.1-flash-lite` rows, which reported phantom models as available and
 * then 404'd on the real request.
 */
export function baseModelMatcher(baseId) {
  const canonicalBase = canonicalModelId(baseId);
  const displayBase = canonicalDisplayName(modelById(baseId)?.name || modelNameFromId(baseId));
  return (text) => {
    if (typeof text !== "string" || !text.trim()) return false;
    const raw = text.trim();
    if (canonicalModelId(raw) === canonicalBase) return true;
    const split = splitEntityId(raw);
    if (split.base === canonicalBase && split.kind !== "bare") return true;
    const label = canonicalDisplayName(raw);
    return label === displayBase || label.startsWith(`${displayBase} (`);
  };
}

/**
 * Levels that the live entities of one base model can actually be pinned to.
 * Explicit level siblings win; a tiered entity exposes every tiered level. A
 * bare-only model keeps the catalog's declared ceiling because its level (if
 * any) is fixed by the entity itself.
 */
export function reasoningLevelsForModel(baseId, entityIds) {
  const canonicalBase = canonicalModelId(baseId);
  const declared = modelById(baseId)?.reasoningEfforts ?? [];
  const levels = new Set();
  let tiered = false;
  for (const entityId of entityIds || []) {
    const split = splitEntityId(entityId);
    if (split.base !== canonicalBase) continue;
    if (split.kind === "level") levels.add(split.level);
    else if (split.kind === "tiered") tiered = true;
  }
  if (tiered) for (const level of TIERED_THINKING_LEVELS) levels.add(level);
  if (!levels.size) return declared;
  const ordered = REASONING_LEVELS.filter((level) => levels.has(level));
  return declared.length ? ordered.filter((level) => declared.includes(level)) : ordered;
}

/**
 * Thinking levels worth trying for one requested effort, closest first: the
 * requested level, then the cheaper levels, then the pricier ones.
 */
export function effortLadder(effort) {
  const requested = canonicalModelId(effort);
  const index = REASONING_LEVELS.indexOf(requested);
  if (index < 0) {
    // "off" (or no effort): the backend's own default is the cheapest level.
    return ["low", ...REASONING_LEVELS.filter((level) => level !== "low")];
  }
  const ladder = [REASONING_LEVELS[index]];
  for (let i = index - 1; i >= 0; i--) ladder.push(REASONING_LEVELS[i]);
  for (let i = index + 1; i < REASONING_LEVELS.length; i++) ladder.push(REASONING_LEVELS[i]);
  return ladder;
}

/**
 * Public models to try after `baseId` when its own entities are absent: same
 * family, catalog order, and never across the image/text divide (a text model
 * must not be asked to draw and an image model must not be asked to reason).
 */
export function familyFallbackBases(baseId) {
  const canonicalBase = canonicalModelId(baseId);
  const family = getFamilyOrder({ id: baseId });
  const imageOnly = canonicalBase.endsWith("-image");
  return MODELS.filter((model) => {
    const candidate = canonicalModelId(model.id);
    if (candidate === canonicalBase) return false;
    if (getFamilyOrder(model) !== family) return false;
    return imageOnly ? candidate.endsWith("-image") : !candidate.endsWith("-image");
  }).map((model) => model.id);
}

/**
 * The runtime entity the static routing table prefers for one model and
 * effort. Kept as a pure function so the live resolver and the offline
 * fallback agree on what "the default entity" means.
 */
export function staticRequestModelId(modelId, effort) {
  const route = ROUTING[modelId];
  if (!route) return modelId;
  const routing = route.routing || {};
  const fallback = () =>
    route.off ?? routing.high ?? routing.medium ?? routing.low ?? route.defaultRequestId ?? modelId;
  if (effort === undefined || effort === "off") return fallback();
  if (effort === "xhigh") {
    return routing.xhigh ?? routing.high ?? routing.medium ?? routing.low ?? fallback();
  }
  return routing[effort] ?? fallback();
}

function ladderForBase(baseId, effort, entityIndex, explicitEffort) {
  const canonicalBase = canonicalModelId(baseId);
  const candidates = [];
  const push = (entityId) => {
    const actual = entityIndex.get(canonicalModelId(entityId));
    if (actual && !candidates.includes(actual)) candidates.push(actual);
  };
  // Without an explicit effort the static default entity wins ("high" for
  // Claude 5.5, the tiered entity for Gemini Flash). With one, the exact level
  // sibling is tried first and the static default only as a fallback.
  if (!explicitEffort) push(staticRequestModelId(baseId, effort));
  for (const level of effortLadder(effort)) push(`${canonicalBase}-${level}`);
  if (explicitEffort) push(staticRequestModelId(baseId, effort));
  push(`${canonicalBase}-tiered`);
  push(canonicalBase);
  push(`${canonicalBase}-thinking`);
  for (const alias of ALIAS_ENTITIES_BY_BASE[canonicalBase] || []) push(alias);
  return candidates;
}

/**
 * Backend entity ids to try, best first, for one public model and effort
 * against an account's live entity catalog (`fetchAvailableModels` ids).
 * Returns an empty list when the catalog shares no entity with this family.
 */
export function runtimeEntityCandidates(baseId, effort, entityIds) {
  const entityIndex = entityIds instanceof Map
    ? entityIds
    : new Map([...(entityIds || [])].map((id) => [canonicalModelId(id), id]));
  const explicitEffort = typeof effort === "string" && effort.length > 0 && effort !== "off";
  const candidates = ladderForBase(baseId, effort, entityIndex, explicitEffort);
  for (const fallbackBase of familyFallbackBases(baseId)) {
    for (const entityId of ladderForBase(fallbackBase, effort, entityIndex, explicitEffort)) {
      if (!candidates.includes(entityId)) candidates.push(entityId);
    }
  }
  return candidates;
}

/** Wire-level thinkingConfig.thinkingLevel for one requested effort. */
export function thinkingLevelForEffort(effort) {
  const requested = canonicalModelId(effort);
  if (requested === "minimal") return "MINIMAL";
  if (requested === "low") return "LOW";
  if (requested === "medium") return "MEDIUM";
  if (requested === "high" || requested === "xhigh" || requested === "max") return "HIGH";
  return "LOW";
}
export function getMaxOutputTokens(modelId, runtimeModel) {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
  if (runtimeModel) {
    if (runtimeModel.startsWith("claude-")) return 64000;
    if (runtimeModel.startsWith("gpt-oss-")) return 32768;
    if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
      return 65535;
    }
    if (runtimeModel.startsWith("gemini-")) return 65536;
  }
  return 8192;
}
export function modelById(modelId) {
  return MODELS.find((model) => model.id === modelId);
}
