/**
 * Static model catalog and pure model helpers for the Antigravity adapter.
 * Extracted verbatim from lib/index.js (no behavior change).
 */

export const ROUTING = {
  // Google AI Pro flagship (revamped Antigravity catalog). The backend
  // advertises one entity per thinking level: gemini-4-argon-high.
  "gemini-4-argon": {
    off: "gemini-4-argon-high",
    routing: {
      minimal: "gemini-4-argon-high",
      low: "gemini-4-argon-high",
      medium: "gemini-4-argon-high",
      high: "gemini-4-argon-high",
      xhigh: "gemini-4-argon-high",
    },
    defaultRequestId: "gemini-4-argon-high",
  },
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
      minimal: "claude-opus-5-5-high",
      low: "claude-opus-5-5-high",
      medium: "claude-opus-5-5-high",
      high: "claude-opus-5-5-high",
      xhigh: "claude-opus-5-5-high",
    },
    defaultRequestId: "claude-opus-5-5-high",
  },
  "claude-sonnet-5.5": {
    off: "claude-sonnet-5-5-high",
    routing: {
      minimal: "claude-sonnet-5-5-high",
      low: "claude-sonnet-5-5-high",
      medium: "claude-sonnet-5-5-high",
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
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-low",
    routing: {
      minimal: "gemini-3.7-flash-low",
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      xhigh: "gemini-3.7-flash-high",
    },
    defaultRequestId: "gemini-3.7-flash-low",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-high",
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
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536,
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
    reasoningEfforts: ["high"],
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
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
    reasoningEfforts: ["low", "medium", "high"],
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
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
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
export function baseModelMatcher(baseId) {
  switch (baseId) {
    case "gemini-4-argon":
      return (text) => /gemini[- ]4[- ]argon/i.test(text);
    case "claude-opus-5.5":
      return (text) => /claude[- ]opus[- ]5[-.]5/i.test(text);
    case "claude-sonnet-5.5":
      return (text) => /claude[- ]sonnet[- ]5[-.]5/i.test(text);
    case "gemini-3.8-flash":
      return (text) => /gemini[- ]3\.8[- ]flash/i.test(text);
    case "gemini-3.7-flash":
      return (text) => /gemini[- ]3\.7[- ]flash/i.test(text);
    case "gemini-3.6-flash":
      return (text) => /gemini[- ]3\.6[- ]flash/i.test(text);
    case "gemini-3.5-flash":
      return (text) => /gemini[- ]3\.5[- ]flash|gemini[- ]3[- ]flash[- ]agent/i.test(text);
    case "gemini-3.1-pro":
      return (text) => /gemini[- ]3\.1[- ]pro|gemini[- ]pro[- ]agent/i.test(text);
    case "gemini-3.1-flash-image":
      return (text) => /gemini[- ]3\.1[- ]flash[- ]image/i.test(text);
    case "gemini-3-flash":
      return (text) => /^gemini[- ]3[- ]flash$/i.test(text);
    case "gemini-2.5-pro":
      return (text) => /gemini[- ]2\.5[- ]pro/i.test(text);
    case "gemini-2.5-flash":
      return (text) => /gemini[- ]2\.5[- ]flash|gemini[- ]3\.1[- ]flash[- ]lite/i.test(text);
    case "claude-sonnet-4-6":
      return (text) => /claude[- ]sonnet[- ]4[-.]6\b/i.test(text);
    case "claude-opus-4-6":
      return (text) => /claude[- ]opus[- ]4[-.]6\b/i.test(text);
    case "gpt-oss-120b":
      return (text) => /gpt[- ]oss/i.test(text);
    default:
      return (text) => String(text || "").toLowerCase().includes(baseId.toLowerCase());
  }
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
