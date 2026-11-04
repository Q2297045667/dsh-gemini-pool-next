/**
 * Google Antigravity (Gemini) account-pool adapter for DeepSeek Harness.
 *
 * This plugin is intentionally shaped like a DSH Web plugin: Cordis loads this
 * module, `apply()` registers a harness LlmAdapter, and OAuth credentials live
 * under DSH home. It does not require an external Antigravity CLI.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { sanitizeText } from "./text.js";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  requestImageHandleText,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { AccountPoolManager, accountsPoolPath } from "./pool.js";
import { createImageGenerateTool } from "./image-tool.js";
import { createVisionTool } from "./vision-tool.js";
import { createVisionBridge, isVisionBridgeHookLive, VISION_BRIDGE_EVENT } from "./vision-bridge.js";
import { registerCommands } from "./commands.js";
import {
  diagnostics,
  redactSecrets,
  safeError,
  setLastEndpoint,
  setLastStatus,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastAvailableModels,
  setLastMatchedModelDebug,
  setLastError,
  getAntigravityDiagnostics,
} from "./diagnostics.js";

export { redactSecrets, getAntigravityDiagnostics };
import {
  MODELS,
  baseModelMatcher,
  canonicalModelId,
  compareAntigravityModels,
  effortLadder,
  familyFallbackBases,
  getMaxOutputTokens,
  inferModelShape,
  modelById,
  reasoningLevelsForModel,
  runtimeEntityCandidates,
  splitEntityId,
  staticRequestModelId,
  thinkingLevelForEffort,
} from "./models.js";

export { compareAntigravityModels };
import {
  escapeHtml,
  remainingPercent,
  progressBar,
  formatReset,
  formatQuotaSummary,
} from "./text-and-format.js";

export { formatQuotaSummary };




export const PROVIDER = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const name = "dsh-gemini-pool-next";
export const inject = ["llm"];

const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const PROBE_TIMEOUT_MS = 30000;
const DISCOVERY_TIMEOUT_MS = 8000;
const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_IMAGE_MAX_PIXELS = 2048 * 2048;
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
const REQUEST_IMAGE_HISTORY_MAX_BASE64_BYTES = 16 * 1024 * 1024;
// Runtime entities to try for one request before giving up on the model.
const RUNTIME_CANDIDATE_LIMIT = 4;

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const REDIRECT_PATH = "/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Transport failures that mean "the request never reached Google". */
const UNREACHABLE_MARKERS = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "fetch failed",
];

/**
 * Where a blocked network has to be fixed. DSH reads these names only from the
 * harness home's `.env`, once at startup — and DSH Desktop's home is not `~/.dsh`.
 * See the README's network section.
 */
export function proxyRemedy() {
  return [
    "If this machine needs a proxy to reach Google, put it in the harness home's .env and restart DSH:",
    "  CLI:         ~/.dsh/.env",
    "  DSH Desktop: %APPDATA%\\dsh-desktop\\harness\\.env (Windows)",
    "               ~/Library/Application Support/dsh-desktop/harness/.env (macOS)",
    "A .env anywhere else is ignored by DSH.",
  ].join("\n");
}

/** Turn a transport failure into an error the operator can act on. */
export function tokenTransportError(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  const detail = code ? `${code}: ${error.message}` : String(error?.message ?? error);
  const unreachable = UNREACHABLE_MARKERS.some((marker) =>
    `${code} ${error?.message ?? ""}`.includes(marker));
  return new Error(
    unreachable
      ? `Cannot reach ${TOKEN_URL} (${detail}).\n${proxyRemedy()}`
      : `Token request to ${TOKEN_URL} failed: ${detail}`,
    { cause: error },
  );
}

/** POST the token endpoint, reporting an unreachable network as such. */
export async function requestToken(init) {
  try {
    return await fetch(TOKEN_URL, init);
  } catch (error) {
    throw tokenTransportError(error);
  }
}
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const DEFAULT_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.';

const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
const GEMINI_ROLE = {
  user: "user",
  model: "model",
};
const TOOL_CALLING_MODE = {
  none: "NONE",
  any: "ANY",
  auto: "AUTO",
  validated: "VALIDATED",
};

const projectCache = new Map();
const entityCache = new Map();
const inFlightEntityLookups = new Map();
let cachedQuota = undefined;
let webLoginFlow = undefined;
let webLoginStart = undefined;

let toolCallCounter = 0;

export function credentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "antigravity-settings.json");
}

const DEFAULT_ENABLED_MODEL_IDS = MODELS.map((model) => model.id);

function antigravityEnv(namePart) {
  return process.env[`ANTIGRAVITY_${namePart}`] || process.env[`NOAGY_${namePart}`];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Cloud Code Assist's v1internal endpoint accepts the proto field spelling
// (thought_signature), whereas model responses use JSON's camelCase spelling.
function thoughtSignatureOf(part) {
  return asString(part?.thoughtSignature) || asString(part?.thought_signature);
}

function nowRequestId() {
  return `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function assertSafeApiBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" ||
    host.endsWith(".googleapis.com") ||
    host.endsWith(".sandbox.googleapis.com");
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function endpointCandidates() {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")) {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

function callbackPort() {
  const raw = antigravityEnv("CALLBACK_PORT");
  if (!raw) return 51121;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ANTIGRAVITY_CALLBACK_PORT: ${raw}`);
  }
  return parsed;
}

function redirectUri() {
  return `http://localhost:${callbackPort()}${REDIRECT_PATH}`;
}

function clientId() {
  return antigravityEnv("CLIENT_ID") || DEFAULT_CLIENT_ID;
}

function clientSecret() {
  return antigravityEnv("CLIENT_SECRET") || DEFAULT_CLIENT_SECRET;
}

/**
 * Client fingerprint the backend gates its catalog on.
 *
 * fetchAvailableModels answers with a *reduced* catalog when the User-Agent is
 * an outdated or off-format build: measured on a Google AI Pro account, the old
 * "antigravity/1.15.8 linux/amd64" fingerprint returns 16 entities with no
 * Gemini 4 Argon and no per-level Gemini 3.8 siblings, while the current hub
 * fingerprint returns 22 entities including gemini-4-argon-{low,medium,high}.
 * That gate — not an entitlement problem — is why the flagship looked missing.
 *
 * Values mirror the current Antigravity hub release. Override with
 * ANTIGRAVITY_USER_AGENT when a newer build is required.
 */
const ANTIGRAVITY_CLIENT_VERSION = "2.24.0";
const ANTIGRAVITY_CLIENT_CHANGELIST = "1000335682";

/**
 * Identity of the catalog fingerprint, persisted with the model settings so a
 * plugin upgrade that raises the client version re-discovers the catalog
 * instead of keeping the reduced model list an older fingerprint produced.
 */
export function catalogClientFingerprint() {
  return `${ANTIGRAVITY_CLIENT_VERSION}/${ANTIGRAVITY_CLIENT_CHANGELIST}`;
}

function defaultUserAgent() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client; os_type=${os}; arch=${arch}; cl=${ANTIGRAVITY_CLIENT_CHANGELIST})`;
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: PLATFORM,
      pluginType: "GEMINI",
    }),
  };
}

function attributionHeaderBag() {
  try {
    return attributionHeaders() || {};
  } catch {
    return {};
  }
}

function jsonOrTextError(text) {
  const parsed = safeJsonParse(text);
  if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  return text;
}

function jsonHeaders(token) {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

function extractProjectId(data) {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token) {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      const data = await safeParseJson(response, "Antigravity discover project failed");
      return extractProjectId(data);
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssistUncached(token) {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      const data = await safeParseJson(response, "Antigravity loadCodeAssist failed");
      const project = extractProjectId(data);
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssist(token) {
  const cached = projectCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    projectCache.delete(token);
    projectCache.set(token, cached);
    return cached.projectId;
  }
  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

function resolveProjectId(options) {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    options.warmedProject ||
    options.credentialProjectId ||
    defaultProjectId(options.email || "antigravity-default")
  );
}

function isUsableRuntimeModelId(id) {
  return /^(gemini-|claude-|gpt-oss-)/i.test(id) && !/\s/.test(id) && !/^MODEL_/i.test(id);
}

/**
 * The account's live entity catalog: every model id `fetchAvailableModels`
 * really advertises. Runtime resolution is built on this set, because the
 * public catalog and the backend entities drift apart in both directions
 * (a project can expose `gemini-3.8-flash-tiered` without any per-level
 * sibling, and it can expose nothing at all for a model the docs still list).
 * Returns undefined when discovery fails so the caller can fall back to the
 * static routing table.
 */
async function fetchAvailableEntities(token, projectId) {
  const cacheKey = `${token}::${projectId}::entities`;
  const cached = entityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inFlight = inFlightEntityLookups.get(cacheKey);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const available = await fetchMergedAvailableModels(token, projectId);
      const ids = new Set();
      const models = isRecord(available?.data?.models) ? available.data.models : {};
      for (const modelId of Object.keys(models)) {
        if (isUsableRuntimeModelId(modelId)) ids.add(modelId);
      }
      if (!ids.size) return undefined;
      const labels = [...ids].slice(0, 16);
      if (labels.length) setLastAvailableModels(labels.join(","));
      return ids;
    } catch (error) {
      setLastError(error);
      return undefined;
    }
  })().then((result) => {
    // A failed discovery is cached briefly: a backend hiccup must not turn
    // every following request into a fresh round-trip.
    const ttl = result ? MODEL_CACHE_TTL_MS : Math.min(MODEL_CACHE_TTL_MS, 60_000);
    entityCache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
    return result;
  });
  inFlightEntityLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightEntityLookups.delete(cacheKey);
  }
}

function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function postJson(path, token, body) {
  let lastErrorText = "";
  const triedEndpoints = [];
  for (const endpoint of endpointCandidates()) {
    triedEndpoints.push(endpoint);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(response.status);
      const text = await response.text();
      const data = safeJsonParse(text) ?? { raw: text };
      if (!response.ok) {
        lastErrorText =
          isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
            ? data.error.message
            : text;
        if (!RETRYABLE_STATUSES.includes(response.status)) {
          throw new Error(`${path} failed (${String(response.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: response.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }  const triedNote = triedEndpoints.length > 1 ? ` (tried endpoints: ${triedEndpoints.join(", ")})` : "";
  throw new Error(`${path} failed${triedNote}: ${lastErrorText || "no endpoint available"}`);
}

async function fetchAvailableModelsFromEndpoint(endpoint, token, projectId) {
  try {
    const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId }),
    });
    const text = await response.text();
    const data = safeJsonParse(text) ?? { raw: text };
    if (!response.ok) {
      const lastErrorText =
        isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
          ? data.error.message
          : text;
      setLastError(lastErrorText);
      return undefined;
    }
    return { endpoint, status: response.status, data };
  } catch (error) {
    setLastError(error);
    return undefined;
  }
}

async function fetchMergedAvailableModels(token, projectId) {
  const results = await Promise.all(
    endpointCandidates().map((endpoint) => fetchAvailableModelsFromEndpoint(endpoint, token, projectId)),
  );
  const mergedModels = {};
  let defaultAgentModelId;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    if (isRecord(result.data) && isRecord(result.data.models)) {
      Object.assign(mergedModels, result.data.models);
    }
    if (isRecord(result.data) && typeof result.data.defaultAgentModelId === "string") {
      defaultAgentModelId = result.data.defaultAgentModelId;
    }
  }

  if (!lastEndpoint) throw new Error("/v1internal:fetchAvailableModels failed: no endpoint available");
  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: { models: mergedModels, defaultAgentModelId },
  };
}

function parseQuotaSummary(data) {
  const summary = isRecord(data) ? data : {};
  const groups = [];
  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    if (!isRecord(group)) continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket)) continue;
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const models = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const quotaInfo = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

export function compareAntigravityModelOptions(a, b) {
  const aEnabled = Boolean(a?.enabled);
  const bEnabled = Boolean(b?.enabled);
  if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
  return compareAntigravityModels(a, b);
}

export function parseCatalogModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const rawModels = [];
  for (const [modelId, infoRaw] of Object.entries(modelsObj)) {
    if (!isUsableRuntimeModelId(modelId)) continue;
    if (!isRecord(infoRaw)) continue;
    if (infoRaw.isInternal || String(modelId).startsWith("chat_") || String(modelId).startsWith("tab_")) continue;
    const quotaInfo = isRecord(infoRaw.quotaInfo) ? infoRaw.quotaInfo : {};
    const inferred = inferModelShape(modelId, infoRaw);
    rawModels.push({
      id: modelId,
      name: inferred.name,
      inputModalities: inferred.inputModalities,
      contextWindow: inferred.contextWindow,
      maxTokens: inferred.maxTokens,
      reasoningEfforts: inferred.reasoningEfforts,
      available: true,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider:
        typeof infoRaw.modelProvider === "string"
          ? infoRaw.modelProvider
          : typeof infoRaw.apiProvider === "string"
            ? infoRaw.apiProvider
            : undefined,
    });
  }

  const matchedRawIds = new Set();
  const consolidated = [];

  for (const base of MODELS) {
    const matcher = baseModelMatcher(base.id);
    const matching = rawModels.filter((r) => matcher(r.id) || matcher(r.name));
    for (const m of matching) matchedRawIds.add(m.id);
    const quotaItem = matching.find((m) => typeof m.remainingFraction === "number") || matching[0];
    consolidated.push({
      ...base,
      // Offer exactly the thinking levels this account can pin: per-level
      // entities for Claude 5.5, every tiered level for gemini-3.8-flash-tiered,
      // and the catalog ceiling for a bare-only entity.
      reasoningEfforts: reasoningLevelsForModel(base.id, matching.map((model) => model.id)),
      available: matching.length > 0,
      ...(quotaItem ? {
        remainingFraction: quotaItem.remainingFraction,
        resetTime: quotaItem.resetTime,
        modelProvider: quotaItem.modelProvider,
      } : {}),
    });
  }

  for (const raw of rawModels) {
    if (!matchedRawIds.has(raw.id)) {
      consolidated.push(raw);
    }
  }

  consolidated.sort(compareAntigravityModels);
  return consolidated;
}

function parseTier(value) {
  if (!isRecord(value)) return undefined;
  if (!value.id && !value.name) return undefined;
  return {
    id: value.id ? String(value.id) : undefined,
    name: value.name ? String(value.name) : undefined,
    description: value.description ? String(value.description) : undefined,
  };
}

export function getCachedQuota() {
  return cachedQuota;
}

function getAntigravityRequestModelId(modelId, effort) {
  return staticRequestModelId(modelId, effort);
}

/**
 * Static fallback chain used only when the account's live entity catalog is
 * unreachable (offline, discovery failure, ...). It walks the public catalog
 * order of the same family instead of decrementing a hand-written version, so
 * a model that the backend never advertised cannot trap the request on an id
 * that is guaranteed to 404.
 */
function staticRuntimeFallbacks(modelId, effort) {
  const candidates = [getAntigravityRequestModelId(modelId, effort)];
  for (const fallbackBase of familyFallbackBases(modelId)) {
    const runtimeModel = getAntigravityRequestModelId(fallbackBase, effort);
    if (runtimeModel && !candidates.includes(runtimeModel)) candidates.push(runtimeModel);
  }
  return candidates.filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * The wire-level thinking level for one runtime entity. The revamped catalog
 * advertises per-level entities (gemini-4-argon-high, gemini-3.8-flash-low/
 * medium/high) whose suffix names the level; the rollout-era tiered entities
 * select the level from the requested effort instead. Returns undefined when
 * the entity carries no explicit level (e.g. Claude thinking entities, which
 * encode thinking in the model id itself).
 */
function thinkingLevelForRuntimeModel(runtimeModel, effort) {
  const split = splitEntityId(runtimeModel);
  // Only Gemini entities take thinkingConfig.thinkingLevel; an Anthropic
  // entity encodes its level in the id and rejects the field.
  if (!/^gemini/i.test(split.base)) return undefined;
  // A tiered entity is the only entity whose level is chosen per request; a
  // -low/-medium/-high sibling already pins it and must not repeat it (Gemini 4
  // Argon rejects mismatched/extra thinking options).
  if (split.kind === "tiered") return thinkingLevelForEffort(effort);
  return undefined;
}

function reasoningInfo(model) {
  if (!model.reasoningEfforts.length) return {};
  return {
    reasoning: {
      efforts: model.reasoningEfforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}

function resolveReasoning(model, effort) {
  if (effort === undefined || effort === "off") return effort;
  if (model.reasoningEfforts && model.reasoningEfforts.includes(effort)) return effort;
  // If user selected an unsupported effort level, fallback to "high" (or available highest)
  if (model.reasoningEfforts && model.reasoningEfforts.includes("high")) return "high";
  return (model.reasoningEfforts && model.reasoningEfforts[0]) || "high";
}

function hasImages(messages) {
  return messages.some((message) => {
    try {
      return contentHasImage(message.content);
    } catch {
      return false;
    }
  });
}

function sanitizeToolCallId(id, fallbackName) {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId, runtimeModel) {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function parseArguments(raw) {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") return {};
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return isRecord(parsed) ? parsed : {};
}

function imageBlockToPart(block, requestImages) {
  if (!isRecord(block) || block.type !== "image") return undefined;
  const attachment = isRecord(block.attachment) ? block.attachment : undefined;
  const attachmentId = attachment ? asString(attachment.attachmentId) : undefined;
  if (attachmentId) {
    const version = requestImages.get(attachmentId);
    if (!version) {
      throw new LlmError(`Antigravity request image ${attachmentId} was not prepared.`, "INVALID_REQUEST");
    }
    return {
      inlineData: {
        mimeType: version.mediaType,
        data: Buffer.from(version.data).toString("base64"),
      },
    };
  }
  let data = asString(block.data) || asString(block.base64);
  const source = isRecord(block.source) ? block.source : undefined;
  if (!data && source) data = asString(source.data) || asString(source.base64);
  let mimeType =
    asString(block.mimeType) ||
    asString(block.mediaType) ||
    (source ? asString(source.mimeType) || asString(source.mediaType) : undefined) ||
    "image/png";

  if (!data && isRecord(block.attachment)) {
    const attachment = block.attachment;
    if (attachment.mediaType) mimeType = asString(attachment.mediaType) || mimeType;
    const attachmentId = asString(attachment.attachmentId) || asString(attachment.id);
    if (attachmentId) {
      const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(attachmentId);
      if (match) {
        const sha256 = match[1].toLowerCase();
        const filePath = dshHomePath("attachments", "v1", "objects", sha256.slice(0, 2), sha256);
        try {
          if (existsSync(filePath)) {
            data = readFileSync(filePath).toString("base64");
          }
        } catch {
          // Ignore read errors
        }
      }
    }
    if (!data && typeof attachment.path === "string" && existsSync(attachment.path)) {
      try {
        data = readFileSync(attachment.path).toString("base64");
      } catch {
        // Ignore read errors
      }
    }
  }

  if (!data && (block.path || block.attachmentId)) {
    const directId = asString(block.attachmentId);
    if (directId) {
      const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(directId);
      if (match) {
        const sha256 = match[1].toLowerCase();
        const filePath = dshHomePath("attachments", "v1", "objects", sha256.slice(0, 2), sha256);
        try {
          if (existsSync(filePath)) {
            data = readFileSync(filePath).toString("base64");
          }
        } catch {}
      }
    }
    if (!data && typeof block.path === "string" && existsSync(block.path)) {
      try {
        data = readFileSync(block.path).toString("base64");
      } catch {}
    }
  }

  if (data?.startsWith("data:")) {
    const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
    if (match) {
      mimeType = match[1] || mimeType;
      data = match[2] || "";
    }
  }
  return data ? { inlineData: { mimeType, data } } : undefined;
}

function contentToUserParts(content, requestImages) {
  if (typeof content === "string") {
    return content.trim() ? [{ text: sanitizeText(content) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text") {
      // Claude (through the Cloud Code shim) rejects text content blocks that
      // are empty or whitespace-only, so such blocks never reach the wire.
      if (!String(block.text ?? "").trim()) continue;
      parts.push({ text: sanitizeText(block.text) });
    } else if (isRecord(block) && block.type === "image") {
      const imagePart = imageBlockToPart(block, requestImages);
      if (imagePart) {
        const attachment = isRecord(block.attachment) ? block.attachment : undefined;
        const attachmentId = attachment ? asString(attachment.attachmentId) : undefined;
        const version = attachmentId ? requestImages.get(attachmentId) : undefined;
        // Keep image-only messages as explicit user turns. Without a text part,
        // Antigravity can treat the request as ending on the preceding model turn.
        parts.push({ text: version ? requestImageHandleText(attachment, version) : "Image attached." });
        parts.push(imagePart);
      }
    }
  }
  return parts;
}

function toolResultText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return sanitizeText(block.text);
      if (block.type === "tool-result") return toolResultText(block.content);
      return "";
    })
    .join("");
}

function replayBlockFor(message, index) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}

function replayRuntimeModelOf(message) {
  const state = message?.source?.replayState;
  if (isRecord(state) && state.kind === "antigravity" && state.version === 1 && state.provider === PROVIDER) {
    return asString(state.runtimeModel);
  }
  return undefined;
}

const BASE64_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature) {
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return BASE64_SIGNATURE_PATTERN.test(signature);
}

/**
 * Gemini 3.x/4.x refuse a replayed functionCall without a valid
 * thought_signature; Gemini 2.x and the Claude/GPT shims do not.
 */
function geminiRequiresThoughtSignature(runtimeModel) {
  const id = String(runtimeModel || "");
  if (!id.startsWith("gemini-")) return false;
  const match = id.match(/^gemini-(\d+)/);
  if (match) return Number.parseInt(match[1], 10) >= 3;
  return true;
}

function assistantParts(message, model, runtimeModel, toolNames, requiresSig, droppedToolCallIds) {
  const parts = [];
  if (!Array.isArray(message.content)) return parts;
  const source = message.source;
  const isSameModel = isRecord(source) && source.kind === "model" && source.model === model.id;

  // A Gemini 3.x/4.x request may only replay tool calls the very same runtime
  // entity produced with a valid signature; everything else is demoted to text.
  const toolCallBlocks = message.content
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => isRecord(block) && block.type === "tool-call");
  const signatures = toolCallBlocks.map(({ index }) => replayBlockFor(message, index)?.thoughtSignature);
  const groupIsSigned =
    requiresSig &&
    isSameModel &&
    replayRuntimeModelOf(message) === runtimeModel &&
    signatures.length > 0 &&
    isValidThoughtSignature(signatures[0]) &&
    signatures.every((signature) => !signature || isValidThoughtSignature(signature));

  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block)) continue;
    const replay = replayBlockFor(message, index);
    if (block.type === "text" && String(block.text || "").trim()) {
      parts.push({ text: sanitizeText(block.text) });
    } else if (block.type === "reasoning" && String(block.text || "").trim()) {
      if (replay?.type === "reasoning" && replay.thinkingSignature && isSameModel && replayRuntimeModelOf(message) === runtimeModel) {
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
          thought_signature: replay.thinkingSignature,
        });
      } else {
        parts.push({ text: sanitizeText(block.text) });
      }
    } else if (block.type === "tool-call") {
      const toolId = String(block.id || "");
      toolNames.set(toolId, block.name);
      if (requiresSig && !groupIsSigned) {
        const argsText = (() => {
          try { return JSON.stringify(parseArguments(block.arguments)); } catch { return "{}"; }
        })();
        if (toolId) {
          droppedToolCallIds.set(toolId, argsText);
          droppedToolCallIds.set(sanitizeToolCallId(toolId, block.name), argsText);
        } else {
          droppedToolCallIds.set(`empty:${block.name}`, argsText);
        }
        continue;
      }
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...(toolCallIdNeeded(model.id, runtimeModel)
            ? { id: sanitizeToolCallId(toolId, block.name) }
            : {}),
        },
        ...(replay?.type === "tool-call" && replay.thoughtSignature
          ? { thought_signature: replay.thoughtSignature }
          : {}),
      });
    }
  }
  return parts;
}

function turnHasFunctionCalls(entry) {
  return Boolean(entry && entry.role === GEMINI_ROLE.model && entry.parts.some((part) => isRecord(part) && "functionCall" in part));
}

function turnHasFunctionResponses(entry) {
  return Boolean(entry && entry.parts.some((part) => isRecord(part) && "functionResponse" in part));
}

function pushToolResult(contents, result, toolNames, model, runtimeModel, requiresSig, droppedToolCallIds) {
  const toolCallId = String(result.toolCallId || "");
  const toolName = toolNames.get(toolCallId) || "unknown";
  // A tool that prints nothing (or only a newline/space) must still produce
  // non-whitespace text: the Claude backend rejects the whole request with
  // "messages: text content blocks must contain non-whitespace text", and its
  // tool_result carries this text straight through.
  const rawOutput = toolResultText(result.content);
  const responseText = rawOutput.trim() ? rawOutput : (result.isError ? "Tool failed" : "(no output)");

  // When the matching tool call was demoted to text (no valid signature), its
  // result must be plain text too: an orphaned functionResponse is rejected.
  const droppedArgs = requiresSig
    ? (droppedToolCallIds.get(toolCallId) ??
       droppedToolCallIds.get(sanitizeToolCallId(toolCallId, toolName)) ??
       (toolCallId === "" ? droppedToolCallIds.get(`empty:${toolName}`) : undefined))
    : undefined;
  if (droppedArgs !== undefined) {
    const label = droppedArgs === "{}" ? `\`${toolName}\`` : `\`${toolName}\` (${droppedArgs})`;
    contents.push({ role: GEMINI_ROLE.user, parts: [{ text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) }] });
    return;
  }

  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError ? { error: responseText } : { output: responseText },
      ...(toolCallIdNeeded(model.id, runtimeModel)
        ? { id: sanitizeToolCallId(toolCallId, toolName) }
        : {}),
    },
  };
  const last = contents[contents.length - 1];
  if (turnHasFunctionResponses(last)) {
    // Same tool turn: the shim expects every result of one assistant turn in a
    // single following message.
    last.parts.push(part);
    return;
  }
  // The Claude backend requires a tool_result in the message DIRECTLY after its
  // tool_use, so a result that arrives after an intervening user turn is
  // spliced in ahead of that turn instead of appending after it.
  if (last?.role === GEMINI_ROLE.user && turnHasFunctionCalls(contents[contents.length - 2])) {
    contents.splice(contents.length - 1, 0, { role: GEMINI_ROLE.user, parts: [part] });
    return;
  }
  contents.push({ role: GEMINI_ROLE.user, parts: [part] });
}

function convertMessages(options, model, runtimeModel, requestImages) {
  const contents = [];
  const toolNames = new Map();
  const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
  const droppedToolCallIds = new Map();
  for (const message of options.messages) {
    if (message.role === "assistant") {
      const parts = assistantParts(message, model, runtimeModel, toolNames, requiresSig, droppedToolCallIds);
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts });
      continue;
    }
    // DSH delivers a tool result as its own role:"tool" message carrying the
    // call id in `toolCallId` (and in `source.callId`); the old converter only
    // understood tool-result blocks embedded in a user message, so results went
    // out as plain user text and Claude answered 400 "tool_use ids were found
    // without tool_result blocks immediately after".
    if (message.role === "tool") {
      pushToolResult(contents, {
        toolCallId: message.toolCallId ?? (isRecord(message.source) ? message.source.callId : ""),
        content: message.content,
        isError: message.isError === true,
      }, toolNames, model, runtimeModel, requiresSig, droppedToolCallIds);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const nonResultContent = content.filter((block) => !isRecord(block) || block.type !== "tool-result");
    const userParts = contentToUserParts(nonResultContent, requestImages);
    if (message.role === "system") {
      if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
      continue;
    }
    if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
    for (const block of content) {
      if (isRecord(block) && block.type === "tool-result") {
        pushToolResult(contents, block, toolNames, model, runtimeModel, requiresSig, droppedToolCallIds);
      }
    }
  }
  return ensureSendableContents(contents);
}

/**
 * Drops whitespace-only text parts and the turns they leave empty. The Claude
 * backend behind Cloud Code answers such a request with 400
 * `messages: text content blocks must contain non-whitespace text`, and an
 * empty or model-final contents array is rejected as well.
 */
function ensureSendableContents(contents) {
  const cleaned = [];
  for (const entry of contents) {
    if (!entry || !Array.isArray(entry.parts)) continue;
    const parts = entry.parts.filter((part) => {
      if (!isRecord(part) || !("text" in part)) return true;
      return String(part.text ?? "").trim().length > 0;
    });
    if (parts.length === 0) continue;
    const previous = cleaned[cleaned.length - 1];
    // Consecutive same-role turns collapse instead of relying on the shim to
    // merge them; tool responses keep their own turn shape.
    if (previous && previous.role === entry.role && !entry.parts.some((part) => isRecord(part) && "functionResponse" in part)) {
      previous.parts.push(...parts);
      continue;
    }
    cleaned.push({ role: entry.role, parts });
  }
  if (cleaned.length === 0) return [{ role: GEMINI_ROLE.user, parts: [{ text: "Continue" }] }];
  // A conversation has to open on a user turn and end on one, otherwise the
  // Claude backend rejects the request as malformed.
  if (cleaned[0].role === GEMINI_ROLE.model) {
    cleaned.unshift({ role: GEMINI_ROLE.user, parts: [{ text: "Continue" }] });
  }
  // Every functionCall must be answered in the very next turn, so a history
  // that ends on an unanswered tool call (an interrupted turn) gets placeholder
  // results rather than a bare "Continue" turn the Claude backend rejects.
  const lastEntry = cleaned[cleaned.length - 1];
  if (turnHasFunctionCalls(lastEntry)) {
    cleaned.push({
      role: GEMINI_ROLE.user,
      parts: lastEntry.parts
        .filter((part) => isRecord(part) && "functionCall" in part)
        .map((part) => ({
          functionResponse: {
            name: part.functionCall.name,
            response: { error: "The tool call was interrupted before it returned a result." },
            ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
          },
        })),
    });
    return cleaned;
  }
  if (cleaned[cleaned.length - 1].role === GEMINI_ROLE.model) {
    cleaned.push({ role: GEMINI_ROLE.user, parts: [{ text: "Continue" }] });
  }
  return cleaned;
}

function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((entry) => typeof entry === "string" && entry !== "null");
}

function normalizeCustomToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(toolChoice) {
  if (toolChoice === "none") return TOOL_CALLING_MODE.none;
  if (toolChoice === "any" || toolChoice === "required") return TOOL_CALLING_MODE.any;
  return TOOL_CALLING_MODE.auto;
}

function buildRequest(options, model, projectId, runtimeModel, effort, requestImages) {
  const request = {
    contents: convertMessages(options, model, runtimeModel, requestImages),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(String(options.system ?? "").trim() ? [{ text: sanitizeText(options.system) }] : []),
      ],
    },
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinkingLevel = thinkingLevelForRuntimeModel(runtimeModel, effort);
  if (thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel };
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const usesLegacyToolSchema = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const tools = convertTools(options.tools, usesLegacyToolSchema);
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } }
        : { functionCallingConfig: { mode: TOOL_CALLING_MODE.validated } };
    } else if (options.toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } };
    }
  }
  if (options.sessionId) request.sessionId = String(options.sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: nowRequestId(),
  };
}

function mapUsage(usage) {
  const inputTokens = Math.max(0, (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0));
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedContentTokenCount > 0 ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
  };
}

function classifyAntigravityError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
  return "ANTIGRAVITY_ERROR";
}

function friendlyAntigravityError(status, text) {
  const message = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      return "Antigravity login expired or credentials are invalid. Next: run /antigravity-login, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(message)) {
      return `Antigravity request format was rejected by the backend (${message}). Next: switch to a simpler model or update the plugin.`;
    }
    return `Bad request from Antigravity. Backend said: ${message}`;
  }
  if (status === 401) return "Antigravity authentication failed. Next: run /antigravity-login, then retry.";
  if (status === 403) return `Antigravity denied this request. Backend said: ${message}`;
  if (status === 404) return `Antigravity could not find the requested model/resource. Backend said: ${message}`;
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) return "Antigravity reported a conflict. Next: retry once or start a new chat session.";
  if (status === 429) {
    const wait = message.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/quota/i.test(message)) return `Quota reached.${wait ? ` Please wait ${wait}.` : ""}`;
    return `Rate limited by Antigravity.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) return "Antigravity had an internal server error. Next: retry or switch models.";
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry.";
  if (status === 503) return /No capacity available/i.test(message)
    ? "This model has no capacity right now. Next: retry later or switch models."
    : "Antigravity is temporarily unavailable. Next: retry or switch models.";
  if (status === 504) return "Antigravity timed out upstream. Next: retry.";
  return message || "Antigravity request failed";
}

function formatRequestDiagnostics(extra) {
  return `endpoint=${diagnostics.endpoint || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${diagnostics.matchedModelDebug || "none"}, available=${diagnostics.availableModels || "unknown"}`;
}

function finishReasonOf(rawReason, hasToolCall, hasContent, errorMessage) {
  if (errorMessage && isContextWindowExceededError(errorMessage)) {
    return { kind: "error", failure: { message: errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  if (!hasContent) {
    return {
      kind: "error",
      failure: { message: "Antigravity returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
    };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "MAX_TOKENS") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "STOP") return { kind: "stop" };
  return {
    kind: "error",
    failure: { message: `Antigravity finished with reason ${rawReason}`, code: "ANTIGRAVITY_FINISH_REASON" },
  };
}

function replayStateOf(model, runtimeModel, replayBlocks, replayModelId) {
  return {
    kind: "antigravity",
    version: 1,
    provider: PROVIDER,
    // The host stamps the assistant message with the *requested* model id, so
    // replay metadata must use the same id even when this attempt ran on a
    // substituted model; otherwise the next turn drops every thought signature.
    model: replayModelId || model.id,
    runtimeModel,
    blocks: replayBlocks,
  };
}

function processStreamChunk(chunk, state) {
  const responseData = isRecord(chunk.response) ? chunk.response : chunk;
  const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
  const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const out = [];

  const closeCurrentBlock = () => {
    if (!state.currentBlock) return;
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      out.push({
        type: "block-end",
        index,
        block: { type: "text", text: state.currentBlock.text },
      });
    } else {
      out.push({
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      });
    }
    state.currentBlock = null;
  };

  for (const part of parts) {
    if (!isRecord(part)) continue;

    const inline = isRecord(part.inlineData) ? part.inlineData : isRecord(part.inline_data) ? part.inline_data : undefined;
    if (inline && typeof inline.data === "string") {
      closeCurrentBlock();
      const rawMime = asString(inline.mimeType) || "image/png";
      if (!/^image\/(png|jpeg|webp)$/.test(rawMime)) {
        throw new LlmError(`Antigravity returned an unsupported image mime type: ${rawMime}`, "UNSUPPORTED_CONTENT");
      }
      const mime = rawMime;
      const b64 = inline.data;
      const imgMarkdown = `\n\n![Generated Image](data:${mime};base64,${b64})\n\n`;
      state.currentBlock = {
        type: "text",
        text: imgMarkdown,
        thinkingSignature: undefined,
        textSignature: undefined,
      };
      state.blocks.push(state.currentBlock);
      state.replayBlocks.push({ type: "text" });
      out.push({ type: "block-start", index: state.blocks.length - 1, blockType: "text" });
      out.push({ type: "text-delta", index: state.blocks.length - 1, text: imgMarkdown });
      state.hasContent = true;
    }

    if (part.text !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        closeCurrentBlock();
        state.currentBlock = {
          type: blockType,
          text: "",
          thinkingSignature: undefined,
          textSignature: undefined,
        };
        state.blocks.push(state.currentBlock);
        state.replayBlocks.push({ type: blockType });
        out.push({ type: "block-start", index: state.blocks.length - 1, blockType });
      }
      const delta = sanitizeText(part.text);
      state.currentBlock.text += delta;
      state.hasContent = true;
      const thoughtSignature = thoughtSignatureOf(part);
      if (isThinking && thoughtSignature) {
        state.currentBlock.thinkingSignature = thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = thoughtSignature;
      } else if (!isThinking && thoughtSignature) {
        state.currentBlock.textSignature = thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = thoughtSignature;
      }
      out.push({
        type: isThinking ? "reasoning-delta" : "text-delta",
        index: state.blocks.length - 1,
        text: delta,
      });
    }
    if (isRecord(part.functionCall)) {
      closeCurrentBlock();
      const toolName = asString(part.functionCall.name) || "";
      const toolId = sanitizeToolCallId(part.functionCall.id || "", toolName);
      const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
      const argsText = JSON.stringify(args);
      const index = state.blocks.length;
      const block = { type: "tool-call", id: ToolCallId(toolId), name: toolName, arguments: argsText };
      state.blocks.push(block);
      const thoughtSignature = thoughtSignatureOf(part);
      state.replayBlocks.push({
        type: "tool-call",
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
      state.hasContent = true;
      state.hasToolCall = true;
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id: ToolCallId(toolId),
        ...(toolName ? { name: toolName } : {}),
        argumentsDelta: argsText,
      });
      out.push({ type: "block-end", index, block });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (isRecord(responseData.usageMetadata)) state.usage = responseData.usageMetadata;
  return out;
}

// All generation paths share framing, error handling, and reader cleanup.
async function* streamResponseFrames(response) {
  if (!response.body) throw new LlmError("Antigravity response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const parseLine = (line) => {
    if (!line.startsWith("data:")) return undefined;
    const chunk = safeJsonParse(line.slice(5).trim());
    if (!isRecord(chunk)) return undefined;
    const error = chunk.error ?? chunk.response?.error;
    if (isRecord(error)) {
      const message = redactSecrets([error.code, error.status, error.message || JSON.stringify(error)]
        .filter((value) => value !== undefined).join(" "));
      throw new LlmError(message, classifyAntigravityError(message));
    }
    return chunk;
  };
  try {
    while (!done) {
      const result = await reader.read();
      done = result.done;
      buffer += done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const chunk = parseLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (chunk) yield chunk;
      }
    }
    const chunk = parseLine(buffer);
    if (chunk) yield chunk;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* streamResponseToChunks(response, model, runtimeModel, state, replayModelId) {
  for await (const chunk of streamResponseFrames(response)) {
    yield* processStreamChunk(chunk, state);
  }
  if (state.currentBlock) {
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      yield { type: "block-end", index, block: { type: "text", text: state.currentBlock.text } };
    } else {
      yield {
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      };
    }
    state.currentBlock = null;
  }

  if (!state.hasContent) return;
  yield { type: "usage", usage: mapUsage(state.usage || {}) };
  yield {
    type: "finish",
    reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
    replayState: replayStateOf(model, runtimeModel, state.replayBlocks, replayModelId),
  };
}

function createStreamState() {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: null,
    finishReason: undefined,
    usage: undefined,
    hasContent: false,
    hasToolCall: false,
  };
}

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text) {
  const redacted = redactSecrets(text).trim();
  const parsed = safeJsonParse(redacted);
  if (isRecord(parsed)) {
    const parts = [parsed.error, parsed.error_description].filter(
      (part) => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function getUserEmail(token) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    return asString(data.email);
  } catch {
    return undefined;
  }
}

function startCallbackServer(expectedState, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("OAuth login aborted"));
    let settled = false;
    let timeout;
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => rejectCode(new Error("OAuth login aborted")));
      server.close();
    };
    const callbackUrl = redirectUri();
    const server = createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, oauthCallbackHeaders("text/plain; charset=utf-8"));
        response.end("Method Not Allowed");
        return;
      }
      const url = new URL(request.url || "", callbackUrl);
      if (url.pathname !== REDIRECT_PATH) {
        response.writeHead(404, oauthCallbackHeaders());
        response.end("Antigravity OAuth callback route not found.");
        return;
      }
      const providerError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (providerError) {
        const safe = escapeHtml(providerError.slice(0, 200));
        response.writeHead(400, oauthCallbackHeaders());
        response.end(`Antigravity authentication failed: ${safe}`);
        finish(() => rejectCode(new Error(`OAuth error: ${providerError.slice(0, 200)}`)));
        return;
      }
      if (!code || !state) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: missing code or state.");
        finish(() => rejectCode(new Error("Missing code or state in OAuth callback")));
        return;
      }
      if (state !== expectedState) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: invalid state.");
        finish(() => rejectCode(new Error("OAuth state mismatch")));
        return;
      }
      response.writeHead(200, oauthCallbackHeaders());
      response.end("Antigravity authentication complete. You can close this window and return to DSH.");
      finish(() => resolveCode({ code, state }));
    });
    server.on("error", reject);
    server.on("close", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    });
    server.listen(callbackPort(), resolveCallbackHost(), () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
        server.close();
      }, OAUTH_CALLBACK_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

export function openBrowser(url) {
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
    child.once("error", () => {});
    child.unref();
  } catch {
    // Best effort only.
  }
}

export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
  };
}

export function terminalInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type !== "auth_url") return;
      console.log(event.instructions || "Open the following URL to sign in:");
      console.log(event.url);
      openBrowser(event.url);
    },
  };
}

export async function loginAntigravity(interaction = browserInteraction()) {
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state, interaction.signal);
  try {
    const callbackUrl = redirectUri();
    const authParams = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: callbackUrl,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    interaction.notify?.({
      type: "auth_url",
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete Google sign-in. DSH will capture the local callback.",
    });

    const { code, state: returnedState } = await waitForCode();
    if (returnedState !== state) throw new Error("OAuth state mismatch");
    if (interaction.signal?.aborted) throw new Error("OAuth login aborted");

    return await exchangeOAuthCode(code, verifier, callbackUrl, interaction.signal);
  } finally {
    server.close();
  }
}

function credentialSummary(credentials) {
  if (!credentials) return { authenticated: false };
  return {
    authenticated: true,
    email: credentialEmail(credentials),
    projectId: credentialProjectId(credentials),
    expires: credentials.expires,
  };
}

function validateTokenData(data) {
  if (!asString(data?.access_token) || !Number.isFinite(data?.expires_in) || data.expires_in <= 0) {
    throw new Error("OAuth token response is missing a valid access_token or expires_in");
  }
}

async function exchangeOAuthCode(code, verifier, callbackUrl, signal) {
  const tokenResponse = await requestToken({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
    signal,
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
    );
  }
  const tokenData = await tokenResponse.json();
  validateTokenData(tokenData);
  if (!tokenData.refresh_token) {
    throw new Error("No refresh token received. Re-run login and allow offline access.");
  }
  const [email, discoveredProject] = await Promise.all([
    getUserEmail(tokenData.access_token),
    loadCodeAssist(tokenData.access_token),
  ]);
  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
    email,
  };
}

export async function beginWebLogin(poolManager, modelSettings) {
  if (webLoginStart) return webLoginStart;
  webLoginStart = beginWebLoginUncached(poolManager, modelSettings);
  try {
    return await webLoginStart;
  } finally {
    webLoginStart = undefined;
  }
}

async function beginWebLoginUncached(poolManager, modelSettings) {
  if (webLoginFlow?.status === "pending") {
    return {
      status: webLoginFlow.status,
      authUrl: webLoginFlow.authUrl,
      startedAt: webLoginFlow.startedAt,
    };
  }

  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  const callbackUrl = redirectUri();
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  const flow = {
    status: "pending",
    authUrl: `${AUTH_URL}?${authParams.toString()}`,
    startedAt: Date.now(),
    error: "",
  };
  webLoginFlow = flow;

  void (async () => {
    try {
      const { code, state: returnedState } = await waitForCode();
      if (returnedState !== state) throw new Error("OAuth state mismatch");
      const credentials = await exchangeOAuthCode(code, verifier, callbackUrl);
      await poolManager.addOrUpdateAccount(credentials);
      try {
        const newAcc = poolManager.allAccounts.find((a) => a.email === credentialEmail(credentials));
        if (newAcc) await fetchQuotaForAccount(newAcc, poolManager, modelSettings);
      } catch (err) {
        console.warn("[Antigravity Pool] Post-login quota fetch error:", err);
      }
      flow.status = "complete";
      flow.email = credentialEmail(credentials);
      flow.completedAt = Date.now();
      cachedQuota = undefined;
    } catch (error) {
      flow.status = "error";
      flow.error = safeError(error);
      flow.completedAt = Date.now();
    } finally {
      server.close();
    }
  })();

  return {
    status: flow.status,
    authUrl: flow.authUrl,
    startedAt: flow.startedAt,
  };
}

export function getWebLoginStatus() {
  if (!webLoginFlow) return { status: "idle" };
  return {
    status: webLoginFlow.status,
    startedAt: webLoginFlow.startedAt,
    completedAt: webLoginFlow.completedAt,
    email: webLoginFlow.email,
    error: webLoginFlow.error,
  };
}

function credentialProjectId(credentials) {
  return asString(credentials?.projectId);
}

function credentialEmail(credentials) {
  return asString(credentials?.email);
}

async function safeParseJson(response, context) {
  try {
    return await response.json();
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: response is not valid JSON (status ${response.status}): ${rawMsg}`);
  }
}
function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshAntigravityToken(credentials) {
  if (!credentials?.refresh) throw new Error("Missing Antigravity refresh token. Run /antigravity-login.");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await requestToken({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: credentials.refresh,
        grant_type: "refresh_token",
      }).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = await safeParseJson(response, "Antigravity token refresh failed");
  validateTokenData(data);
  const existingProjectId = credentialProjectId(credentials);
  const discoveredProject = existingProjectId ? undefined : await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      existingProjectId || discoveredProject || defaultProjectId(email || "antigravity-default"),
  };
}

export function getApiKey(credentials) {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

export class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = credentialPath()) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(credentials) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async delete() {
    await this.#chain.catch(() => {});
    try {
      await unlink(this.#file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function normalizeModelSettings(raw) {
  const enabledModelIds = Array.isArray(raw?.enabledModelIds)
    ? raw.enabledModelIds.filter((id) => typeof id === "string" && id.length > 0 && !/\s/.test(id))
    : DEFAULT_ENABLED_MODEL_IDS;
  return {
    enabledModelIds: [...new Set(enabledModelIds)],
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    catalogModels: Array.isArray(raw?.catalogModels)
      ? raw.catalogModels.filter((model) => isRecord(model) && typeof model.id === "string" && model.id.length > 0)
      : [],
    catalogClient: typeof raw?.catalogClient === "string" ? raw.catalogClient : "",
  };
}

export class FileModelSettingsStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = modelSettingsPath()) {
    this.#file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return normalizeModelSettings(isRecord(parsed) ? parsed : undefined);
    } catch (error) {
      if (error && error.code === "ENOENT") return normalizeModelSettings(undefined);
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeModelSettings(settings);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
    return this.read();
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) return this.write(updated);
      return current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  setEnabledModelIds(enabledModelIds) {
    return this.modify((current) => ({ ...current, enabledModelIds }));
  }

  setCatalogModels(catalogModels, options = {}) {
    return this.modify((current) => ({
      ...current,
      catalogModels,
      ...(Array.isArray(options.enabledModelIds) ? { enabledModelIds: options.enabledModelIds } : {}),
    }));
  }
}

function enabledModelSet(settings) {
  return new Set(normalizeModelSettings(settings).enabledModelIds);
}

function catalogModelsOf(settings) {
  const normalized = normalizeModelSettings(settings);
  return normalized.catalogModels.length
    ? normalized.catalogModels.map((model) => ({ ...modelById(model.id), ...model }))
    : MODELS;
}

function configuredModels(settings) {
  const enabled = enabledModelSet(settings);
  const enabledModels = catalogModelsOf(settings).filter((model) => enabled.has(model.id));
  // Never advertise a model the pool cannot serve; an all-unavailable catalog
  // (no quota fetched yet for any account) keeps the raw selection so a fresh
  // install still exposes a model list.
  const available = enabledModels.filter((model) => model.available !== false);
  return (available.length ? available : enabledModels).sort(compareAntigravityModels);
}

function modelFromSettings(settings, modelId) {
  return catalogModelsOf(settings).find((model) => model.id === modelId) || modelById(modelId) || inferModelShape(modelId);
}

export async function loginAndSave(interaction = browserInteraction()) {
  const poolManager = new AccountPoolManager();
  await poolManager.init();
  const credentials = await loginAntigravity(interaction);
  await poolManager.addOrUpdateAccount(credentials);
  try {
    const email = credentialEmail(credentials);
    const newAcc = poolManager.allAccounts.find((a) => a.email === email);
    if (newAcc) {
      await fetchQuotaForAccount(newAcc, poolManager, new FileModelSettingsStore(modelSettingsPath()));
    }
  } catch (err) {
    console.warn("[Antigravity Pool] Post-login quota fetch error:", err);
  }
  return credentials;
}


// Coalesce concurrent refreshes of the same account. Google rotates the
// refresh_token on every refresh, so two in-flight refreshes racing on the
// same (old) refresh_token can invalidate each other and brick the account.
// Keyed by account id (falling back to email/refresh) so parallel requests and
// the background liveness probe share one in-flight refresh instead of firing
// several against the token endpoint at once.
const inFlightTokenRefreshes = new Map();

function refreshAccountTokenOnce(account, poolManager) {
  const key = account.id || account.email || account.refresh;
  const existing = inFlightTokenRefreshes.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const refreshed = await refreshAntigravityToken(account);
    await poolManager.addOrUpdateAccount(refreshed);
    return refreshed;
  })().finally(() => {
    inFlightTokenRefreshes.delete(key);
  });
  inFlightTokenRefreshes.set(key, pending);
  return pending;
}

export async function ensureApiKeyForAccount(account, poolManager) {
  if (!account?.refresh) {
    throw new LlmError("Invalid account in pool: missing refresh token", "AUTH");
  }
  let current = account;
  if (needsRefresh(current)) {
    current = await refreshAccountTokenOnce(current, poolManager);
  }
  let warmedProject = null;
  if (!credentialProjectId(current) && !antigravityEnv("PROJECT_ID")) {
    warmedProject = await loadCodeAssist(current.access);
    if (warmedProject) {
      current.projectId = warmedProject;
      await poolManager.addOrUpdateAccount(current);
    }
  }
  const projectId = resolveProjectId({
    credentialProjectId: credentialProjectId(current),
    email: credentialEmail(current),
    warmedProject,
  });
  setLastProjectId(projectId);
  return { token: current.access, projectId, email: credentialEmail(current) };
}

export async function fetchQuotaForAccount(account, poolManager, modelSettings) {
  const { token, projectId: credentialProjectId } = await ensureApiKeyForAccount(account, poolManager);
  const [assistResult, summary] = await Promise.all([
    postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }).catch(() => null),
    postJson("/v1internal:retrieveUserQuotaSummary", token, {}),
  ]);

  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    credentialProjectId,
    warmedProject: discoveredProject ?? null,
  });
  setLastProjectId(projectId);

  const available = await fetchMergedAvailableModels(token, projectId);
  const { groups, description } = parseQuotaSummary(summary.data);
  const { models, defaultAgentModelId } = parseModels(available.data);
  const catalogModels = parseCatalogModels(available.data);
  const assistData = isRecord(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : "PRO";

  const quota = {
    projectId,
    endpoint: summary.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    models,
    catalogModels,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };

  await poolManager.updateAccountQuota(account.id, quota, planLabel);

  if (modelSettings) {
    await modelSettings.modify(async (current) => {
      // Read the pool inside the settings transaction: parallel account
      // refreshes must preserve the full catalog and current user selection.
      const status = await poolManager.getStatus();
      const mergedCatalog = getBestCatalogQuota(status.accounts)?.catalogModels || catalogModels;
      const isFirstTime = current.catalogModels.length === 0 && current.updatedAt === 0;
      const catalogIds = new Set(mergedCatalog.map((model) => model.id));
      // A model that no account in the pool serves must not stay selectable:
      // leaving it enabled is what produced "No account ... supports model"
      // and the follow-up 404s for entities the backend never advertised.
      const availableIds = new Set(
        mergedCatalog.filter((model) => model.available !== false).map((model) => model.id),
      );
      const enabledModelIds = isFirstTime
        ? [...availableIds]
        : current.enabledModelIds.filter((id) => catalogIds.has(id) && (availableIds.size === 0 || availableIds.has(id)));
      return {
        ...current,
        catalogModels: mergedCatalog,
        enabledModelIds,
        catalogClient: catalogClientFingerprint(),
      };
    });
  }

  return quota;
}

/**
 * Minimal liveness probe for a disabled account. It deliberately reuses the
 * same streaming request path that real traffic uses
 * (requestAntigravityChunksWithAccount -> streamGenerateContent), because a
 * quota-metadata query can keep succeeding for an account that is in fact
 * rate limited. A single tiny prompt with maxTokens 1 keeps the extra cost of
 * each probe cycle negligible.
 */
export async function probeAccountLiveness(account, poolManager, modelSettings) {
  const settings = await modelSettings.read();
  // Probe with the pool's primary TEXT model. gemini-3.8-flash is on every
  // plan tier of the revamped catalog, so it is the reliable default even for
  // accounts without flagship (Pro-only) models enabled.
  const enabled = enabledModelSet(settings);
  const probeModelId = enabled.has("gemini-3.8-flash")
    ? "gemini-3.8-flash"
    : (configuredModels(settings).find((model) => !model.id.endsWith("-image"))?.id ?? "gemini-3.8-flash");
  const model = modelFromSettings(settings, probeModelId);
  const tokenInfo = await ensureApiKeyForAccount(account, poolManager);
  const iterator = requestAntigravityChunksWithAccount(
    {
      model: model.id,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      maxTokens: 1,
    },
    model,
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    tokenInfo,
    undefined,
  )[Symbol.asyncIterator]();
  try {
    // Fully consume so upstream errors (429 etc.) surface here rather than
    // being swallowed by an early return.
    while (!(await iterator.next()).done) {
      // Drain.
    }
  } finally {
    try {
      await iterator.return(undefined);
    } catch {
      // The generator is already finished or errored; nothing to release.
    }
  }
}

export function getBestCatalogQuota(accounts) {
  if (!accounts || !accounts.length) return undefined;
  const catalogMap = new Map();
  let latestFetchedAt = 0;
  for (const acc of accounts) {
    if (!acc.quota) continue;
    if (acc.quota.fetchedAt > latestFetchedAt) latestFetchedAt = acc.quota.fetchedAt;
    if (Array.isArray(acc.quota.catalogModels)) {
      for (const cm of acc.quota.catalogModels) {
        const existing = catalogMap.get(cm.id);
        if (
          !existing ||
          (existing.available === false && cm.available !== false) ||
          ((existing.available !== false) === (cm.available !== false) &&
            (cm.remainingFraction ?? -1) > (existing.remainingFraction ?? -1))
        ) {
          catalogMap.set(cm.id, cm);
        }
      }
    }
  }
  return {
    catalogModels: [...catalogMap.values()],
    fetchedAt: latestFetchedAt,
  };
}

function isQuotaOrRateLimitError(error) {
  if (!error) return false;
  if (isQuotaExceededError(error)) return true;
  const msg = String(error?.message || error);
  // "quota" alone is too broad: a malformed-request 400 can mention the word
  // (e.g. "quota field unknown") without being exhaustion. Require either an
  // explicit rate-limit signal or a quota *condition* phrasing.
  return /\b429\b|RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|rate.?limit|quota (?:reached|exceeded|exhausted|used up)|exceeded.*quota|individual quota|has been exhausted/i.test(
    msg,
  );
}

function accountSupportsModel(account, modelId) {
  return account.quota?.catalogModels?.find((model) => model.id === modelId)?.available !== false;
}

/**
 * Pick the best replacement for a model no selected account supports. The
 * catalog keeps entries for models the backend no longer serves (so a stale
 * session selection still resolves), but a request must never be sent for an
 * entity the account does not have: doing so is exactly the 404 the user sees
 * as "Antigravity could not find the requested model/resource".
 */
function pickSubstituteModelId(candidates, category, modelId) {
  const available = new Map();
  for (const account of candidates) {
    for (const entry of account.quota?.catalogModels || []) {
      if (!entry?.id || entry.available === false) continue;
      available.set(entry.id, entry);
    }
  }
  if (!available.size) return undefined;
  const requested = canonicalModelId(modelId);
  const wantsImage = requested.endsWith("-image");
  const wantsGpt = requested.startsWith("gpt-oss");
  const wantsClaude = category === "claude" || requested.startsWith("claude-");
  const entries = [...available.values()].filter((entry) => {
    const canonical = canonicalModelId(entry.id);
    // A text model must never be asked to draw.
    return wantsImage ? canonical.endsWith("-image") : !canonical.endsWith("-image");
  });
  const sameFamily = entries.filter((entry) => {
    const canonical = canonicalModelId(entry.id);
    if (wantsGpt) return canonical.startsWith("gpt-oss");
    return wantsClaude ? canonical.startsWith("claude-") : !canonical.startsWith("claude-");
  });
  // Same family first; a pool that simply has no model of that family still
  // serves the request from its closest available line of the same kind.
  const options = sameFamily.length ? sameFamily : entries;
  options.sort(compareAntigravityModels);
  return options[0]?.id;
}

/**
 * Resolve the model one request should actually use, plus the accounts that
 * can serve it. An unavailable model is transparently replaced by the best
 * available sibling so a stale session selection degrades instead of failing.
 */
async function resolveModelRoute(poolManager, category, modelId) {
  const candidates = await poolManager.getCandidateAccounts(category);
  if (!candidates.length) return { modelId, accounts: [], substitutedFrom: undefined };
  const supported = candidates.filter((account) => accountSupportsModel(account, modelId));
  if (supported.length) return { modelId, accounts: supported, substitutedFrom: undefined };
  const substitute = pickSubstituteModelId(candidates, category, modelId);
  if (substitute) {
    const substituteAccounts = candidates.filter((account) => accountSupportsModel(account, substitute));
    if (substituteAccounts.length) {
      console.warn(
        `[Antigravity Pool] Model "${modelId}" is not available on any selected account; using "${substitute}" instead.`,
      );
      return { modelId: substitute, accounts: substituteAccounts, substitutedFrom: modelId };
    }
  }
  throw new Error(`No account in the current pool selection supports model "${modelId}".`);
}

/**
 * Runtime entities (and, for tiered entities, thinking levels) to try for one
 * request, best first. The live catalog decides: a per-level sibling when the
 * account has one, the tiered entity when that is what it advertises, the bare
 * id otherwise, then the next best model of the same family.
 */
async function resolveRuntimeCandidates(token, projectId, model, effort) {
  const override = antigravityEnv("RUNTIME_MODEL")?.trim();
  if (override) return [{ model: override, effort }];

  const entities = await fetchAvailableEntities(token, projectId);
  const candidates = [];
  const push = (entry) => {
    if (!entry.model || !isUsableRuntimeModelId(entry.model)) return;
    if (candidates.some((existing) => existing.model === entry.model && existing.effort === entry.effort)) return;
    candidates.push(entry);
  };

  if (entities?.size) {
    for (const entityId of runtimeEntityCandidates(model.id, effort, entities)) {
      // A tiered entity serves every level through thinkingConfig, so an
      // unsupported level can step down instead of falling to another model.
      const levels = splitEntityId(entityId).kind === "tiered" ? effortLadder(effort).slice(0, 2) : [effort];
      for (const level of levels) push({ model: entityId, effort: level });
      if (candidates.length >= RUNTIME_CANDIDATE_LIMIT) break;
    }
  }

  if (!candidates.length) {
    for (const runtimeModel of staticRuntimeFallbacks(model.id, effort)) {
      push({ model: runtimeModel, effort });
      if (candidates.length >= RUNTIME_CANDIDATE_LIMIT) break;
    }
  }
  if (!candidates.length) push({ model: getAntigravityRequestModelId(model.id, effort), effort });
  return candidates.slice(0, RUNTIME_CANDIDATE_LIMIT);
}

async function fetchStreamResponse(endpoint, headers, body, signal) {
  try {
    return await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    setLastError(error);
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    throw error;
  }
}

function inspectImageBlocks(blocks, refs, state) {
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "image") {
      const attachment = isRecord(block.attachment) ? block.attachment : undefined;
      const attachmentId = attachment ? asString(attachment.attachmentId) : undefined;
      if (attachmentId) refs.set(attachmentId, attachment);
      else state.hasInlineImage = true;
    } else if (block.type === "tool-result" && Array.isArray(block.content)) {
      inspectImageBlocks(block.content, refs, state);
    }
  }
}

function inspectRequestImages(messages) {
  const refs = new Map();
  const state = { hasInlineImage: false };
  for (const message of messages) inspectImageBlocks(message.content, refs, state);
  return { refs, hasInlineImage: state.hasInlineImage };
}

function requestImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/**
 * Keep retained request images within the inline-base64 history budget: walk
 * messages from newest to oldest and replace images beyond the budget with
 * text placeholders, preserving the most recent images. Self-contained so
 * it behaves identically across dsh-llm versions — the 0.2.x line removed the
 * old offloadRequestImagesWithPolicy helper this previously rode on.
 */
function projectRequestImageBudget(messages) {
  const budgetBytes = REQUEST_IMAGE_HISTORY_MAX_BASE64_BYTES;
  let used = 0;
  let overflow = false;

  const sizeBlock = (block) => {
    const attachment = isRecord(block?.attachment) ? block.attachment : {};
    const raw =
      Number.isFinite(attachment.bytes) && attachment.bytes >= 0
        ? attachment.bytes
        : REQUEST_IMAGE_MAX_BYTES;
    return Math.ceil(Math.min(raw, REQUEST_IMAGE_MAX_BYTES) / 3) * 4;
  };

  const projectBlocks = (blocks) => {
    let changed = false;
    const next = blocks.slice();
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (!isRecord(block)) continue;
      if (block.type === "tool-result" && Array.isArray(block.content)) {
        const content = projectBlocks(block.content);
        if (content !== block.content) {
          changed = true;
          next[index] = { ...block, content };
        }
        continue;
      }
      if (block.type !== "image") continue;
      used += sizeBlock(block);
      if (overflow || used > budgetBytes) {
        overflow = true;
        changed = true;
        next[index] = { type: "text", text: "[image omitted: too many images in history]" };
      }
    }
    return changed ? next : blocks;
  };

  const projected = messages.slice();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!Array.isArray(message?.content)) continue;
    const content = projectBlocks(message.content);
    if (content !== message.content) projected[index] = { ...message, content };
  }
  return overflow ? projected : messages;
}

async function prepareRequestImages(messages, attachments, signal, hasInlineImage) {
  // Inline-base64 blocks carry no durable metadata the budget walk can size
  // exactly; preserve the legacy passthrough path when a request mixes formats.
  const projectedMessages = hasInlineImage ? messages : projectRequestImageBudget(messages);
  const { refs } = inspectRequestImages(projectedMessages);
  const versions = await Promise.all(
    [...refs.values()].map((ref) =>
      attachments.readImageRequest(
        ref,
        {
          ...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_PIXELS),
          maxBytes: REQUEST_IMAGE_MAX_BYTES,
        },
        signal,
      ),
    ),
  );
  const requestImages = new Map();
  for (const [index, attachmentId] of [...refs.keys()].entries()) {
    requestImages.set(attachmentId, versions[index]);
  }
  return { messages: projectedMessages, requestImages };
}

export async function* requestAntigravityChunksWithAccount(options, model, signal, tokenInfo, attachments) {
  const containsImages = hasImages(options.messages);
  if (containsImages && !model.inputModalities.includes("image")) {
    throw new LlmError(`antigravity model "${model.id}" does not support image content`, "UNSUPPORTED_CONTENT");
  }
  const imageInput = containsImages ? inspectRequestImages(options.messages) : undefined;
  if (imageInput?.refs.size && !attachments) {
    throw new LlmError("Antigravity image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
  }

  const prepared = imageInput?.refs.size
    ? await prepareRequestImages(options.messages, attachments, signal, imageInput.hasInlineImage)
    : { messages: options.messages, requestImages: new Map() };
  const requestOptions = prepared.messages === options.messages ? options : { ...options, messages: prepared.messages };

  const { token, projectId } = tokenInfo;
  const effort = resolveReasoning(model, requestOptions.reasoningEffort);
  const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);
  const requestHeaders = {
    ...antigravityHeaders(token),
    ...attributionHeaderBag(),
    ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  let response;
  let lastText = "";
  let runtimeModel = runtimeCandidates[0].model;
  // Declared at request scope (not inside the candidate loop) because the
  // error branch after the loop reads them to build the thrown LlmError.
  let triedEndpoints = [];
  let lastNetworkError = null;

  for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
    if (emptyAttempt > 0) {
      const delay = 500 * 2 ** (emptyAttempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    for (let candidateIndex = 0; candidateIndex < runtimeCandidates.length; candidateIndex++) {
      const candidate = runtimeCandidates[candidateIndex];
      runtimeModel = candidate.model;
      setLastResolvedRuntimeModel(runtimeModel);
      setLastMatchedModelDebug(`${runtimeModel} @ ${candidate.effort ?? "default"}`);
      const body = JSON.stringify(
        buildRequest(requestOptions, model, projectId, runtimeModel, candidate.effort, prepared.requestImages),
      );

      triedEndpoints = [];
      lastNetworkError = null;
      for (const endpoint of endpointCandidates()) {
        triedEndpoints.push(endpoint);
        setLastEndpoint(endpoint);
        try {
          response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
        } catch (err) {
          lastNetworkError = err;
          if (signal?.aborted) throw err;
          continue;
        }
        setLastStatus(response.status);
        if (response.ok) break;
        lastText = await response.text();
        if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
        if (!RETRYABLE_STATUSES.includes(response.status)) break;
      }

      if (response?.ok) break;
      if (
        response &&
        PROBE_RETRYABLE_STATUSES.includes(response.status) &&
        candidateIndex + 1 < runtimeCandidates.length
      ) {
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      const friendly = friendlyAntigravityError(response?.status, lastText || lastNetworkError?.message);
      const triedNote = triedEndpoints.length > 1 ? ` (tried endpoints: ${triedEndpoints.join(", ")})` : "";
      throw new LlmError(
        `Antigravity API error (${response?.status ?? "network error"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}${triedNote}): ${friendly}`,
        classifyAntigravityError(friendly),
      );
    }

    const state = createStreamState();
    for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state, options.model)) {
      yield chunk;
    }
    if (state.hasContent) return;
  }

  throw new LlmError("Antigravity API returned an empty response", EMPTY_RESPONSE_CODE);
}

export class AntigravityPoolAdapter extends LlmAdapter {
  #poolManager;
  #modelSettings;
  #resolveAttachments;

  constructor(poolManager, modelSettings = new FileModelSettingsStore(), resolveAttachments) {
    super();
    this.#poolManager = poolManager;
    this.#modelSettings = modelSettings;
    this.#resolveAttachments = resolveAttachments;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const settings = await this.#modelSettings.read();
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    }));
  }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) return Promise.reject(new LlmError("antigravity model resolution aborted", "ABORTED"));
    const settings = await this.#modelSettings.read();
    const model = modelFromSettings(settings, modelId);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    };
  }

  async *stream(options) {
    const settings = await this.#modelSettings.read();
    const requestedModel = modelFromSettings(settings, options.model);
    const category =
      requestedModel.id.startsWith("claude-") || requestedModel.id.startsWith("gpt-oss-") ? "claude" : "gemini";

    await this.#poolManager.init();
    let route;
    try {
      route = await resolveModelRoute(this.#poolManager, category, requestedModel.id);
    } catch (poolError) {
      // "Every account is disabled/cooling" is an availability problem, not a
      // credential problem: reporting AUTH pushes the user to re-login when
      // they only need to wait or add another account.
      throw new LlmError(poolError.message, "EXHAUSTED");
    }
    if (!route.accounts.length) {
      throw new LlmError("No Google Antigravity accounts configured in pool. Please sign in under Settings > Antigravity.", "AUTH");
    }
    const candidates = route.accounts;
    const model = route.modelId === requestedModel.id ? requestedModel : modelFromSettings(settings, route.modelId);
    const attachments = hasImages(options.messages) ? this.#resolveAttachments?.() : undefined;

    let lastError = null;
    let anyChunkYielded = false;

    for (let i = 0; i < candidates.length; i++) {
      const account = candidates[i];
      const consumer = new AbortController();
      const upstream =
        options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
      const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);

      try {
        const tokenInfo = await ensureApiKeyForAccount(account, this.#poolManager);
        const iterator = requestAntigravityChunksWithAccount(
          options,
          model,
          watchdog.signal,
          tokenInfo,
          attachments,
        )[Symbol.asyncIterator]();

        let exhausted = false;
        try {
          while (true) {
            const result = await watchdog.next(iterator);
            if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
              throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
            }
            if (result.done) {
              exhausted = true;
              break;
            }
            anyChunkYielded = true;
            yield result.value;
          }
        } finally {
          consumer.abort("antigravity stream consumer stopped");
          if (!exhausted) {
            try {
              await iterator.return(undefined);
            } catch {}
          }
          watchdog[Symbol.dispose]();
        }

        await this.#poolManager.clearCooldownUntil(account.id);
        return;
      } catch (error) {
        consumer.abort("antigravity error");
        watchdog[Symbol.dispose]();
        lastError = error;

        if (options.signal?.aborted) {
          throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
        }

        const isQuotaErr = isQuotaOrRateLimitError(error);
        if (isQuotaErr) {
          // Always record the quota failure so the backoff ladder advances.
          await this.#poolManager.markCooldown(account.id, undefined, error.message);
          // Only fail over while the caller has seen nothing yet: switching
          // accounts mid-stream would splice two different responses.
          if (!anyChunkYielded && i + 1 < candidates.length) {
            console.warn(`[Antigravity Pool] Auto-failover from ${account.email} to next account (${candidates[i + 1].email}) due to: ${error.message}`);
            continue;
          }
        }

        throw error;
      }
    }

    if (lastError) throw lastError;
  }
}

export async function generateImageThroughPool(prompt, poolManager, modelSettings) {
  await poolManager.init();
  const imageModelId = poolManager.defaultImageModel || "gemini-3.1-flash-image";
  const settings = await modelSettings.read();
  const requestedModel = modelFromSettings(settings, imageModelId);
  let route;
  try {
    route = await resolveModelRoute(poolManager, "gemini", requestedModel.id);
  } catch (poolError) {
    throw new LlmError(poolError.message, "EXHAUSTED");
  }
  if (!route.accounts.length) {
    throw new Error("No Google Antigravity accounts configured in pool.");
  }
  const candidates = route.accounts;
  const model = route.modelId === requestedModel.id ? requestedModel : modelFromSettings(settings, route.modelId);

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const account = candidates[i];
    try {
      const { token, projectId } = await ensureApiKeyForAccount(account, poolManager);
      const effort = "off";
      const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);
      const primary = runtimeCandidates[0] || { model: imageModelId, effort };
      const runtimeModel = primary.model;

      const body = JSON.stringify(
        buildRequest(
          {
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          },
          model,
          projectId,
          runtimeModel,
          primary.effort,
        ),
      );

      const requestHeaders = {
        ...antigravityHeaders(token),
        ...attributionHeaderBag(),
      };

      let response = null;
      let lastText = "";
      const triedEndpoints = [];
      let lastNetworkError = null;
      for (const endpoint of endpointCandidates()) {
        triedEndpoints.push(endpoint);
        try {
          response = await fetchStreamResponse(endpoint, requestHeaders, body);
        } catch (err) {
          lastNetworkError = err;
          continue;
        }
        if (response.ok) break;
        lastText = await response.text();
        if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
        if (!RETRYABLE_STATUSES.includes(response.status)) break;
      }

      if (!response || !response.ok) {
        const triedNote = triedEndpoints.length > 1 ? ` (tried endpoints: ${triedEndpoints.join(", ")})` : "";
        throw new Error(`Google API ${response?.status || 500}${triedNote}: ${lastText || lastNetworkError?.message || "network error"}`);
      }

      for await (const parsed of streamResponseFrames(response)) {
        const candidate = parsed?.candidates?.[0] || parsed?.response?.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          const inline = part.inlineData || part.inline_data;
          if (inline && typeof inline.data === "string" && inline.data) {
            const mimeType = inline.mimeType || inline.mime_type || "image/png";
            if (!/^image\/(png|jpeg|webp)$/.test(mimeType)) {
              throw new LlmError(`Antigravity returned an unsupported image mime type: ${mimeType}`, "UNSUPPORTED_CONTENT");
            }
            await poolManager.clearCooldownUntil(account.id);
            return { base64: inline.data, mimeType, accountEmail: account.email };
          }
        }
      }
      throw new Error(`No image data returned from ${imageModelId}.`);
    } catch (err) {
      lastError = err;
      // Same quota/rate-limit predicate as the streaming path, so a 400 that
      // merely mentions "quota" does not cool the account down.
      if (isQuotaOrRateLimitError(err)) {
        await poolManager.markCooldown(account.id, undefined, err?.message || "");
        if (i + 1 < candidates.length) {
          console.warn(`[Antigravity Pool Image] Account ${account.email} rate limited, switching to next account...`);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError || new Error("Image generation failed across all accounts.");
}

/**
 * Pick the Gemini model that describes images for text-only host models.
 * A configured pool visionModel wins only when it actually accepts images
 * (same criteria as the automatic pick); otherwise the first enabled Gemini
 * model with image input that is not an image-gen model is used; the plain
 * flash model is the last resort.
 */
export function resolveVisionModelId(poolManager, settings) {
  const preferred = poolManager.visionModel;
  if (preferred) {
    const match = catalogModelsOf(settings).find((model) => model.id === preferred);
    const acceptsImages =
      match &&
      match.id.includes("gemini") &&
      Array.isArray(match.inputModalities) &&
      match.inputModalities.includes("image") &&
      !match.id.endsWith("image");
    if (acceptsImages) return preferred;
    if (match) {
      console.warn(
        `[Antigravity Pool Vision] configured visionModel "${preferred}" cannot accept images; using automatic selection.`,
      );
    }
  }
  const visionCapable = configuredModels(settings).filter(
    (model) =>
      model.id.includes("gemini") &&
      Array.isArray(model.inputModalities) &&
      model.inputModalities.includes("image") &&
      !model.id.endsWith("image"),
  );
  // Prefer the flash line for cheap description calls; only fall back to the
  // flagship (e.g. Gemini 4 Argon) when no flash model is enabled.
  const candidate =
    visionCapable.find((model) => model.id.includes("flash")) || visionCapable[0];
  return candidate?.id || "gemini-3.8-flash";
}

export async function requestVisionThroughPool(imageBase64, mimeType, prompt, poolManager, modelSettings) {
  await poolManager.init();
  const settings = await modelSettings.read();
  const visionModelId = resolveVisionModelId(poolManager, settings);
  const requestedModel = modelFromSettings(settings, visionModelId);
  let route;
  try {
    route = await resolveModelRoute(poolManager, "gemini", requestedModel.id);
  } catch (poolError) {
    throw new LlmError(poolError.message, "EXHAUSTED");
  }
  if (!route.accounts.length) {
    throw new Error("No Google Antigravity accounts configured in pool.");
  }
  const candidates = route.accounts;
  const model = route.modelId === requestedModel.id ? requestedModel : modelFromSettings(settings, route.modelId);

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const account = candidates[i];
    try {
      const { token, projectId } = await ensureApiKeyForAccount(account, poolManager);
      // Describing an image is a cheap read-back; no deep thinking needed.
      const effort = "low";
      const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);

      const requestHeaders = {
        ...antigravityHeaders(token),
        ...attributionHeaderBag(),
      };

      // Two-layer retry mirroring the streaming path: a retryable status on
      // the primary runtime candidate falls through to the next one.
      let response = null;
      let lastText = "";
      let runtimeModel = runtimeCandidates[0]?.model || visionModelId;
      let triedEndpoints = [];
      let lastNetworkError = null;
      for (let candidateIndex = 0; candidateIndex < runtimeCandidates.length; candidateIndex++) {
        const runtimeCandidate = runtimeCandidates[candidateIndex];
        runtimeModel = runtimeCandidate.model;
        const body = JSON.stringify(
          buildRequest(
            {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    { type: "image", data: imageBase64, mimeType },
                  ],
                },
              ],
            },
            model,
            projectId,
            runtimeModel,
            runtimeCandidate.effort,
          ),
        );

        triedEndpoints = [];
        lastNetworkError = null;
        for (const endpoint of endpointCandidates()) {
          triedEndpoints.push(endpoint);
          try {
            // Describing an image must never hang a turn; 60s is generous.
            response = await fetchStreamResponse(endpoint, requestHeaders, body, AbortSignal.timeout(VISION_REQUEST_TIMEOUT_MS));
          } catch (err) {
            lastNetworkError = err;
            continue;
          }
          if (response.ok) break;
          lastText = await response.text();
          if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
          if (!RETRYABLE_STATUSES.includes(response.status)) break;
        }

        if (response?.ok) break;
        if (response && PROBE_RETRYABLE_STATUSES.includes(response.status) && candidateIndex + 1 < runtimeCandidates.length) {
          continue;
        }
        break;
      }

      if (!response || !response.ok) {
        const triedNote = triedEndpoints.length > 1 ? ` (tried endpoints: ${triedEndpoints.join(", ")})` : "";
        throw new Error(`Google API ${response?.status || 500}${triedNote}: ${lastText || lastNetworkError?.message || "network error"}`);
      }

      let collected = "";
      for await (const parsed of streamResponseFrames(response)) {
        const candidate = parsed?.candidates?.[0] || parsed?.response?.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          if (part.inlineData || part.inline_data || part.thought) continue;
          if (typeof part.text === "string") collected += part.text;
        }
      }

      if (collected) {
        await poolManager.clearCooldownUntil(account.id);
        return { text: collected, accountEmail: account.email };
      }
      throw new Error(`No text returned from ${visionModelId} for account ${account.email} (status ${response.status}).`);
    } catch (err) {
      lastError = err;
      // Same quota/rate-limit predicate as the streaming path, so a 400 that
      // merely mentions "quota" does not cool the account down.
      if (isQuotaOrRateLimitError(err)) {
        await poolManager.markCooldown(account.id, undefined, err?.message || "");
        if (i + 1 < candidates.length) {
          console.warn(`[Antigravity Pool Vision] Account ${account.email} rate limited, switching to next account...`);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError || new Error("Vision request failed across all accounts.");
}

/**
 * Let the host's image admission gate accept pastes for text-only models:
 * wrap llm.resolveModelInfo so any declared modality list without "image"
 * gains it. Models with unknown modalities (undefined) stay untouched — the
 * host already admits them. Safe to call on the raw service or a cordis
 * traceable proxy (unwrapped via Symbol.for("cordis.original")).
 *
 * isEnabled decides whether the wrapper is installed at all; isEnabledNow is
 * consulted on every call so a visionEnabled config change takes effect
 * without a restart. Returns { dispose, resolveOriginal }: dispose restores
 * the original method, resolveOriginal exposes the unwrapped bound original
 * for callers that must see the host's true model info (the vision bridge's
 * model gate). No-op installs return { dispose: noop, resolveOriginal: null }.
 */
export function installVisionAdmissionShim(llm, isEnabled, isEnabledNow) {
  const noopShim = { dispose: () => {}, resolveOriginal: null };
  if (!isEnabled) return noopShim;
  const ORIGINAL = Symbol.for("cordis.original");
  const target = llm?.[ORIGINAL] ?? llm;
  if (typeof target?.resolveModelInfo !== "function") {
    console.warn("[Antigravity Pool] resolveModelInfo not found on llm service; vision admission shim not installed.");
    return noopShim;
  }
  const original = target.resolveModelInfo.bind(target);
  const wrapped = async function (provider, model, signal) {
    if (isEnabledNow && !isEnabledNow()) return original(provider, model, signal);
    const info = await original(provider, model, signal);
    if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image")) {
      return { ...info, inputModalities: [...info.inputModalities, "image"] };
    }
    return info;
  };
  target.resolveModelInfo = wrapped;
  return {
    dispose: () => {
      if (target.resolveModelInfo === wrapped) target.resolveModelInfo = original;
    },
    resolveOriginal: original,
  };
}

// Vision assembly state surfaced by /antigravity-doctor (Refs #7). A bridge
// that silently does nothing in one profile is undiagnosable unless the doctor
// can say whether the agent/pre-step listener is REALLY on the host's event bus
// and whether the admission shim actually installed in this process. The
// `bridge` string alone is only apply-time bookkeeping; `bridgeLive` probes
// the live bus (events._hooks) on every doctor read, so a handler silently
// dropped after registration — the signature issue #7 reports — downgrades
// the line to "dropped" instead of lying "registered".
const visionRuntimeState = {
  bridge: "unregistered",
  bridgeLive: null,
  shim: "pending",
  enabledNow: null,
};

function visionBridgeStatus() {
  if (visionRuntimeState.bridge !== "registered" || typeof visionRuntimeState.bridgeLive !== "function") {
    return visionRuntimeState.bridge;
  }
  try {
    const live = visionRuntimeState.bridgeLive();
    // undefined = bus layout unreadable (host drift): keep the bookkeeping
    // value rather than reporting a false "dropped".
    return live === undefined ? visionRuntimeState.bridge : live ? "registered" : "dropped";
  } catch {
    return visionRuntimeState.bridge;
  }
}

export function doctorText() {
  const current = getAntigravityDiagnostics();
  return [
    `provider=${PROVIDER}`,
    `lastResolvedRuntimeModel=${current.resolvedRuntimeModel || "none"}`,
    `availableModels=${current.availableModels || "none"}`,
    `matchedModel=${current.matchedModelDebug || "none"}`,
    `lastEndpoint=${current.endpoint || "none"}`,
    `lastStatus=${current.status ?? "none"}`,
    `lastProjectId=${current.projectId || "none"}`,
    `lastError=${current.error ? redactSecrets(current.error) : "none"}`,
    `credentialPath=${credentialPath()}`,
    "transport=native-cloud-code-assist-sse",
    "runtimeCli=not-used",
    "commands=/antigravity-login /antigravity-quota /antigravity-doctor /antigravity-logout",
    `visionEnabled=${visionRuntimeState.enabledNow ? String(visionRuntimeState.enabledNow()) : "unknown"}`,
    `visionBridge=${visionBridgeStatus()}`,
    `visionShim=${visionRuntimeState.shim}`,
  ].join("\n");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method-not-allowed" });
}

function quotaCardRows(quota) {
  const modelRows = (quota.models || [])
    .filter((model) => !/tab_|chat_/i.test(model.modelId))
    .map((model) => ({
      id: model.modelId,
      label: model.displayName || model.modelId,
      remainingPercent: remainingPercent(model.remainingFraction),
      remainingFraction: model.remainingFraction,
      resetLabel: formatReset(model.resetTime),
      resetTime: model.resetTime,
      provider: model.modelProvider,
      recommended: model.recommended,
      supportsThinking: model.supportsThinking,
      supportsImages: model.supportsImages,
    }));
  const bucketRows = (quota.groups || []).flatMap((group) =>
    (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      group: group.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  );
  const groups = (quota.groups || []).map((group) => ({
    displayName: group.displayName,
    description: group.description,
    buckets: (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  }));
  return { modelRows, bucketRows, groups, groupDescription: quota.groupDescription };
}

function publicModelMatchNeedles(modelId) {
  switch (modelId) {
    // Refs #16: each public model matches only its own backend rows. The old
    // 3.8 needles aliased 3.7, so a project without any 3.8 entity could still
    // look "available" (or the wrong quota row) via the 3.7 rows.
    case "gemini-4-argon":
      return ["gemini-4-argon", "gemini 4 argon", "4-argon"];
    case "gemini-3.8-flash":
      return ["gemini-3.8-flash", "gemini 3.8 flash"];
    case "gemini-3.7-flash":
      return ["gemini-3.7-flash", "gemini 3.7 flash"];
    case "gemini-3.6-flash":
      return ["gemini-3.6-flash", "gemini 3.6 flash"];
    case "gemini-3.5-flash":
      return ["gemini-3.5-flash", "gemini 3.5 flash", "gemini-3-flash-agent"];
    case "gemini-3.1-pro":
      return ["gemini-3.1-pro", "gemini 3.1 pro", "gemini-pro-agent"];
    case "claude-opus-5.5":
      return ["claude-opus-5-5", "claude opus 5.5", "claude opus 5-5"];
    case "claude-sonnet-5.5":
      return ["claude-sonnet-5-5", "claude sonnet 5.5", "claude sonnet 5-5"];
    case "claude-sonnet-4-6":
      return ["claude-sonnet-4-6", "claude sonnet 4.6"];
    case "claude-opus-4-6":
      return ["claude-opus-4-6", "claude opus 4.6"];
    case "gpt-oss-120b":
      return ["gpt-oss-120b", "gpt oss 120b"];
    default:
      return [modelId];
  }
}

function rowsForPublicModel(model, quota) {
  if (!quota) return [];
  const { modelRows } = quotaCardRows(quota);
  const needles = publicModelMatchNeedles(model.id);
  return modelRows.filter((row) => {
    const haystack = `${row.id || ""} ${row.label || ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

function publicModelQuotaSummary(model, quota) {
  const rows = rowsForPublicModel(model, quota);
  if (!rows.length) return {};
  const withRemaining = rows.filter((row) => typeof row.remainingFraction === "number");
  const best = (withRemaining.length ? withRemaining : rows).reduce((left, right) => {
    const leftValue = typeof left.remainingFraction === "number" ? left.remainingFraction : -1;
    const rightValue = typeof right.remainingFraction === "number" ? right.remainingFraction : -1;
    return rightValue > leftValue ? right : left;
  });
  return {
    available: true,
    remainingFraction: best.remainingFraction,
    remainingPercent: best.remainingPercent,
    resetLabel: best.resetLabel,
    resetTime: best.resetTime,
  };
}

function modelOptionsPayload(settings, quota) {
  const enabled = enabledModelSet(settings);
  const allModels = [...catalogModelsOf(settings)].sort(compareAntigravityModels);
  const catalogQuotaMap = new Map();
  if (quota?.catalogModels) {
    for (const cm of quota.catalogModels) {
      catalogQuotaMap.set(cm.id, cm);
    }
  }
  const options = allModels.map((model) => {
    const catalogQuota = catalogQuotaMap.get(model.id);
    const fallbackQuota = publicModelQuotaSummary(model, quota);
    const modelQuota = catalogQuota || model;
    const quotaInfo = modelQuota.available === false
      ? { available: false }
      : modelQuota.remainingFraction !== undefined
      ? {
          available: true,
          remainingFraction: modelQuota.remainingFraction,
          remainingPercent: remainingPercent(modelQuota.remainingFraction),
          resetLabel: modelQuota.resetTime ? formatReset(modelQuota.resetTime) : undefined,
          resetTime: modelQuota.resetTime,
        }
      : { ...fallbackQuota, ...(modelQuota.available === true ? { available: true } : {}) };
    return {
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      reasoningEfforts: model.reasoningEfforts,
      enabled: enabled.has(model.id),
      description: typeof model.description === "string" ? model.description : undefined,
      deprecated: model.deprecated === true || undefined,
      ...quotaInfo,
    };
  });
  options.sort(compareAntigravityModelOptions);
  return {
    enabledModelIds: [...enabled],
    options,
  };
}

async function webStatus(poolManager, modelSettings) {
  await poolManager.init();
  const poolStatus = await poolManager.getStatus();
  const settings = await modelSettings.read();
  const bestQuota = getBestCatalogQuota(poolStatus.accounts);
  return {
    schedulingMode: poolStatus.schedulingMode,
    activeAccountId: poolStatus.activeAccountId,
    cooldownMs: poolStatus.cooldownMs,
    cooldownMaxMs: poolStatus.cooldownMaxMs,
    disableThreshold: poolStatus.disableThreshold,
    probeIntervalMs: poolStatus.probeIntervalMs,
    defaultImageModel: poolManager.defaultImageModel,
    imageOutputDir: poolManager.imageOutputDir,
    visionEnabled: poolManager.visionEnabled !== false,
    visionModel: poolManager.visionModel,
    accounts: poolStatus.accounts,
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, bestQuota),
  };
}

/** Web-api endpoints only receive small JSON payloads (ids, mode toggles). */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Statuses worth retrying across endpoints / accounts. Single source of truth:
 * postJson endpoint fallback and the stream candidate loop must stay in sync.
 * 400 is deliberately excluded from RETRYABLE_STATUSES (permanent client error)
 * but included in PROBE_RETRYABLE_STATUSES where a probe may still switch models.
 */
const RETRYABLE_STATUSES = [403, 404, 429, 500, 502, 503, 504];
const PROBE_RETRYABLE_STATUSES = [400, 404, 429, 500, 502, 503, 504];

// Upper bound for one vision description request (URL downloads have their
// own tighter 15s limit inside the tool).
const VISION_REQUEST_TIMEOUT_MS = 60000;

async function readRequestJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error(
        `request body too large: ${total} bytes exceeds limit ${MAX_REQUEST_BODY_BYTES}`,
      ), { statusCode: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = safeJsonParse(text);
  if (!isRecord(parsed)) throw Object.assign(new Error("invalid JSON request body"), { statusCode: 400 });
  return parsed;
}

function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}

export function registerWebApi(ctx, poolManager, modelSettings) {
  // The web API rides the same admission fence as the host's own /api
  // channel: connection.admit() applies the Host/Origin trust fence (403)
  // and the browser-session authentication (401). Unauthenticated requests
  // — another origin, a browser without the DSH session cookie — never
  // reach pool state or credentials. The plugin's settings card runs in
  // the DSH web origin and sends the session cookie, so it is unaffected.
  ctx.inject(["webServer", "connection"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/antigravity/api",
          handler: async (request, response) => {
            const admission = webCtx.connection.admit(request);
            if ("rejection" in admission) {
              const status = admission.rejection;
              response.writeHead(status);
              response.end(status === 401 ? "unauthorized" : "forbidden");
              return;
            }
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/antigravity\/api\/?/, "");
            try {
              if (path === "status" || path === "") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "doctor") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: doctorText() });
              }
              if (path === "login") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const value = await beginWebLogin(poolManager, modelSettings);
                return sendJson(response, 200, { ok: true, value });
              }
              if (path === "quota") {
                if (request.method !== "GET" && request.method !== "POST") {
                  return sendMethodNotAllowed(response);
                }
                await poolManager.init();
                const accounts = poolManager.allAccounts;
                await Promise.allSettled(
                  accounts.map((acc) => fetchQuotaForAccount(acc, poolManager, modelSettings))
                );
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "accounts/remove") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                if (!body.id) return sendJson(response, 400, { ok: false, error: "id is required" });
                await poolManager.removeAccount(body.id);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "accounts/set-primary") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                if (!body.id) return sendJson(response, 400, { ok: false, error: "id is required" });
                await poolManager.setPrimaryAccount(body.id);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "accounts/enable") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                if (!body.id) return sendJson(response, 400, { ok: false, error: "id is required" });
                await poolManager.enableAccount(body.id);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "config") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await poolManager.updateConfig(body);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              if (path === "models") {
                if (request.method === "GET") {
                  const status = await webStatus(poolManager, modelSettings);
                  return sendJson(response, 200, { ok: true, value: status.models });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  const status = await webStatus(poolManager, modelSettings);
                  return sendJson(response, 200, { ok: true, value: status.models });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const status = await poolManager.getStatus();
                for (const acc of status.accounts) {
                  await poolManager.removeAccount(acc.id);
                }
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(poolManager, modelSettings) });
              }
              return sendJson(response, 404, { ok: false, error: "not-found" });
            } catch (error) {
              return sendJson(response, error.statusCode === 400 || error.statusCode === 413 ? error.statusCode : 500,
                { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-gemini-pool-next: web api",
    );
  });
}

export function apply(ctx) {
  const poolManager = new AccountPoolManager();
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  // Dereference the llm service once, while the context is active: touching
  // ctx.llm from a callback after teardown throws "inactive context".
  const llmService = ctx.llm;
  const adapter = new AntigravityPoolAdapter(poolManager, modelSettings, () => ctx.get("attachments"));
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, poolManager, modelSettings);

  // The backend gates its catalog on the client fingerprint, so a catalog
  // discovered by an older fingerprint can be missing models the account is
  // entitled to (Gemini 4 Argon only appears for current clients). Re-discover
  // in the background on boot instead of waiting for a manual quota refresh.
  void (async () => {
    try {
      const settings = await modelSettings.read();
      // Nothing discovered yet (fresh install) or already current: nothing to do.
      const stale = settings.catalogClient
        ? settings.catalogClient !== catalogClientFingerprint()
        : settings.catalogModels.length > 0;
      if (!stale) return;
      await poolManager.init();
      const accounts = poolManager.allAccounts;
      if (!accounts.length) return;
      await Promise.allSettled(
        accounts.map((account) => fetchQuotaForAccount(account, poolManager, modelSettings)),
      );
      emitLlmAdaptersUpdated(ctx);
    } catch (error) {
      setLastError(error);
    }
  })();

  // The README's conversation commands (login/quota/doctor/logout) ride the
  // host `commands` service when the host provides one; the handlers reuse
  // the same in-process functions the web API routes call. On hosts without
  // the service the inject callback simply never fires — commands fall back
  // to the web API routes and the antigravity-login CLI, and plugin load is
  // unaffected.
  try {
    ctx.inject(["commands"], (cmdCtx) => {
      cmdCtx.effect(
        () =>
          registerCommands(cmdCtx, {
            poolManager,
            modelSettings,
            beginLogin: beginWebLogin,
            fetchQuotaForAccount,
            doctorText,
            emitUpdated: () => emitLlmAdaptersUpdated(ctx),
          }),
        "dsh-gemini-pool-next: commands",
      );
    });
  } catch {
    // No commands service on this host: commands stay web-API/CLI only.
  }

  // Schedule after each completed round so slow probes never overlap, and
  // let the host dispose the timer when this plugin unloads.
  ctx.effect(() => {
    let stopped = false;
    let probeTimer;
    const schedule = () => {
      if (stopped) return;
      probeTimer = setTimeout(runProbe, poolManager.probeIntervalMs || 300000);
      probeTimer.unref();
    };
    const runProbe = async () => {
      try {
        await poolManager.init();
        const disabledAccounts = poolManager.allAccounts.filter((account) => account.status === "disabled");
        for (const account of disabledAccounts) {
          if (stopped) break;
          try {
            await probeAccountLiveness(account, poolManager, modelSettings);
            if (stopped) break;
            await poolManager.recordProbeSuccess(account.id);
            console.log(`[Antigravity Pool] Probe succeeded: re-enabled account ${account.email}`);
          } catch (error) {
            console.log(`[Antigravity Pool] Probe failed for account ${account.email}: ${safeError(error)}`);
          }
        }
      } catch (error) {
        console.error("[Antigravity Pool] Probe check error:", safeError(error));
      } finally {
        schedule();
      }
    };
    void poolManager.init().then(schedule, (error) => setLastError(error));
    return () => {
      stopped = true;
      clearTimeout(probeTimer);
    };
  }, "dsh-gemini-pool-next: account probes");

  ctx.inject(["tools"], (toolCtx) => {
    try {
      const imageTool = createImageGenerateTool(poolManager, async (prompt) => {
        return generateImageThroughPool(prompt, poolManager, modelSettings);
      });
      toolCtx.tools.register(imageTool);
      // Registered unconditionally: the visionEnabled switch only governs the
      // admission shim below, not this tool (same standing as imageTool).
      const visionTool = createVisionTool(poolManager, async (imageBase64, mimeType, prompt) => {
        return requestVisionThroughPool(imageBase64, mimeType, prompt, poolManager, modelSettings);
      });
      toolCtx.tools.register(visionTool);
    } catch (e) {
      console.warn("[Antigravity Pool] Optional image tool registration deferred:", e);
    }
  });

  // The vision bridge rides the agent/pre-step waterfall (Refs #7): the
  // listener rewrites the entered step's image blocks into pool descriptions
  // AFTER next() resolves and returns a new decision, which is the channel
  // the host actually consumes — the previous llm/stream registration could
  // only pass its rewrite as an argument to next(), and the cordis waterfall
  // discards next() arguments, so the rewrite never reached the provider.
  // The listener is attached here (context active) but evaluates the switch
  // at step time: visionEnabled may be flipped from the settings page without
  // a restart, so both the bridge and the shim consult the same live
  // predicate. The model gate resolves through the shim's UNwrapped original
  // so the true modalities decide. Route resolution mirrors the host's
  // prepareRequest seeding: the agent's configured provider/model first
  // (fresh sessions), the persisted request header as fallback (resumed or
  // already-stepped sessions). Known lag window (Refs #7, review F1): a UI
  // model switch takes effect at agent/request — AFTER pre-step — so the
  // first step after a switch resolves the OLD route; a vision→text switch
  // leaves that step's paste on the placeholder path (hash fallback still
  // applies), a text→vision switch describes one image unnecessarily; the
  // next step self-heals.
  const visionEnabledNow = () =>
    antigravityEnv("VISION_ENABLED") === "false"
      ? false
      : antigravityEnv("VISION_ENABLED") === "true"
        ? true
        : poolManager.visionEnabled !== false;
  let shimResult = null;
  const bridge = createVisionBridge({
    isEnabled: visionEnabledNow,
    resolveRoute: (payload) => {
      const agent = payload?.agent;
      const header = agent?.session?.requestHeader?.();
      return {
        provider: agent?.options?.provider || header?.config?.provider,
        model: agent?.options?.model || header?.config?.model,
      };
    },
    isTextOnlyModel: async (provider, model) => {
      const resolve = shimResult?.resolveOriginal;
      if (!resolve) {
        console.log(
          "[Antigravity Pool Vision] model gate resolver: unavailable (admission shim not ready yet)",
        );
        return false;
      }
      try {
        const info = await resolve(provider, model);
        return Array.isArray(info?.inputModalities) && !info.inputModalities.includes("image");
      } catch (error) {
        console.log(`[Antigravity Pool Vision] model gate resolver: error (${error?.message || error})`);
        return false;
      }
    },
    describeImage: async (base64, mimeType) =>
      (
        await requestVisionThroughPool(
          base64,
          mimeType,
          "Describe this image in detail, including any visible text, layout, and notable elements.",
          poolManager,
          modelSettings,
        )
      ).text,
  });
  ctx.on(VISION_BRIDGE_EVENT, bridge, { global: true });
  visionRuntimeState.bridge = "registered";
  // Liveness probe for the doctor line above: reads the host's public
  // listener registry, so the reported state reflects the bus at doctor
  // time, not the moment ctx.on returned (Refs #7).
  visionRuntimeState.bridgeLive = () => isVisionBridgeHookLive(ctx.events);
  visionRuntimeState.enabledNow = visionEnabledNow;

  // The shim wrapper is installed unconditionally (inside a cordis effect so
  // the host owns the disposer and context dispose restores resolveModelInfo);
  // every call re-evaluates visionEnabledNow, which reads the env override and
  // the pool config live — a settings-page toggle applies without a restart.
  // The async form (Promise<Disposable>) is a documented effect shape; the
  // shim uses the dereferenced llmService, never ctx.llm. An init failure now
  // records itself in the doctor state instead of leaving a rejected effect
  // (Refs #7): the model gate staying unavailable must be visible.
  ctx.effect(
    () =>
      poolManager
        .init()
        .then(() => {
          shimResult = installVisionAdmissionShim(llmService, true, visionEnabledNow);
          visionRuntimeState.shim = shimResult.resolveOriginal ? "installed" : "noop";
          if (shimResult.resolveOriginal) {
            console.log("[Antigravity Pool] vision admission shim installed; the bridge model gate resolver is live");
          }
          return shimResult.dispose;
        })
        .catch((error) => {
          visionRuntimeState.shim = "init-error";
          console.warn(
            "[Antigravity Pool Vision] pool init failed before the admission shim could install; the bridge model gate stays unavailable:",
            error?.message || error,
          );
          return () => {};
        }),
    "dsh-gemini-pool-next: vision admission shim",
  );
}

apply.inject = ["llm"];

export default apply;
