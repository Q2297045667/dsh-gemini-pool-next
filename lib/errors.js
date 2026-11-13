/**
 * Structured failure classification for the Antigravity adapter.
 *
 * Cloud Code Assist reports a failure in several shapes: a JSON Google RPC
 * envelope on a non-2xx response, the same envelope double-encoded as a JSON
 * string, an in-band `{error}` object inside an HTTP 200 SSE stream, a plain
 * text body, or an HTML routing page. The pool routes and cools down accounts
 * on `LlmError.code`, so exactly one module must normalize every shape into one
 * precise, actionable failure: a real cause, the model/entity and endpoint it
 * happened on, a redacted backend excerpt, the rejected field when the backend
 * names one, and a concrete next step.
 *
 * This module is pure — no I/O and no diagnostics bookkeeping. The adapter
 * passes in what it observed and records the returned structured object.
 */
import { LlmError, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { redactSecrets } from "./diagnostics.js";

/** Longest backend excerpt kept in a rendered message. */
export const MAX_BACKEND_MESSAGE_CHARS = 500;
/** Hard ceiling for one rendered LlmError message. */
export const MAX_ERROR_MESSAGE_CHARS = 1500;

const MAX_JSON_DECODE_DEPTH = 3;

/** Failure classes with stable LlmError codes (the pool routes on these). */
const CODE_RATE_LIMIT = "RATE_LIMIT";
const CODE_AUTH = "AUTH";
const CODE_MODEL_NOT_FOUND = "MODEL_NOT_FOUND";
const CODE_NOT_FOUND = "NOT_FOUND";
const CODE_INVALID_REQUEST = "INVALID_REQUEST";
const CODE_SERVER = "SERVER";
const CODE_OVERLOADED = "OVERLOADED";
const CODE_TIMEOUT = "TIMEOUT";
const CODE_TRANSPORT = "TRANSPORT";
const CODE_CONFLICT = "CONFLICT";
const CODE_ENDPOINT_UNSUPPORTED = "ENDPOINT_UNSUPPORTED";
const CODE_UNKNOWN = "ANTIGRAVITY_ERROR";

const RPC_BAD_REQUEST = "google.rpc.BadRequest";
const RPC_ERROR_INFO = "google.rpc.ErrorInfo";
const RPC_RETRY_INFO = "google.rpc.RetryInfo";
const RPC_QUOTA_FAILURE = "google.rpc.QuotaFailure";
const RPC_HELP = "google.rpc.Help";

/** Wording that identifies an exhausted account quota rather than a rate limit. */
const QUOTA_WORDING =
  /individual quota|quota (?:reached|exceeded|exhausted|used up|spent)|exceeded (?:the |your |its )?quota|insufficient (?:quota|balance|credits?)|resource has been exhausted|out of (?:credits?|budget)|usage limit|weekly limit|five hour limit|5-hour limit/i;

/** Wording that identifies a credential/plan rejection rather than a bad request. */
const AUTH_WORDING =
  /API key not valid|API_KEY_INVALID|invalid_grant|invalid authentication|access token (?:expired|invalid)|unauthenticated|login required|permission denied/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bounded(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** True when a body is an HTML page rather than an API payload. */
export function isHtmlDocument(text) {
  const value = String(text ?? "").trimStart();
  return /^<!doctype\s+html/i.test(value) || /^<html[\s>]/i.test(value);
}

function emptyPayload() {
  return {
    kind: "empty",
    code: undefined,
    status: "",
    message: "",
    details: emptyDetails(),
  };
}

function emptyDetails() {
  return {
    fieldViolations: [],
    retryAfterMs: undefined,
    errorInfo: undefined,
    quotaViolations: [],
    links: [],
  };
}

function textPayload(text, kind) {
  return withInferredStatus({
    kind,
    code: undefined,
    status: "",
    message: String(text ?? ""),
    details: emptyDetails(),
  });
}

/**
 * Decode a JSON body, including double-encoded JSON (`"{\"error\":…}"`).
 * Returns `{ kind: "value" }` with the parsed value or `{ kind: "text" }` when
 * the input is not JSON at all (plain text or an HTML page).
 */
function decodeJson(text) {
  let raw = text;
  for (let depth = 0; depth <= MAX_JSON_DECODE_DEPTH; depth += 1) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return depth === 0 ? undefined : { kind: "text", value: raw };
    }
    if (typeof parsed !== "string") return { kind: "value", value: parsed };
    raw = parsed;
  }
  return { kind: "text", value: raw };
}

function normalizeType(raw) {
  const text = asString(raw) || "";
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/** Parse a protobuf Duration (JSON `"1.5s"` or `{seconds,nanos}`) into ms. */
function durationToMs(value) {
  if (isRecord(value)) {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (!Number.isFinite(seconds) && !Number.isFinite(nanos)) return undefined;
    return Math.max(0, Math.round(seconds * 1000 + nanos / 1e6));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 1000));
  }
  if (typeof value !== "string") return undefined;
  const match = /^([\d.]+)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] || "s").toLowerCase();
  const factor = unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1000;
  return Math.max(0, Math.round(amount * factor));
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfterHeader(value) {
  const text = asString(value)?.trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function parseFieldViolations(raw) {
  const violations = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry)) continue;
    const field = asString(entry.field);
    if (!field) continue;
    violations.push({ field, description: bounded(redactSecrets(asString(entry.description) || ""), 240) });
  }
  return violations;
}

function parseQuotaViolations(raw) {
  const violations = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry)) continue;
    const subject = asString(entry.subject) || "";
    const description = asString(entry.description) || "";
    if (!subject && !description) continue;
    violations.push({ subject: bounded(subject, 160), description: bounded(redactSecrets(description), 240) });
  }
  return violations;
}

function parseLinks(raw) {
  const links = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry)) continue;
    const url = asString(entry.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    links.push({ description: bounded(asString(entry.description) || url, 160), url: bounded(url, 400) });
  }
  return links;
}

function parseDetails(raw) {
  const details = emptyDetails();
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const type = normalizeType(entry["@type"]);
    if (type === RPC_BAD_REQUEST) {
      details.fieldViolations.push(...parseFieldViolations(entry.fieldViolations));
    } else if (type === RPC_RETRY_INFO) {
      details.retryAfterMs ??= durationToMs(entry.retryDelay);
    } else if (type === RPC_ERROR_INFO) {
      details.errorInfo = {
        reason: asString(entry.reason) || "",
        domain: bounded(asString(entry.domain) || "", 120),
        metadata: isRecord(entry.metadata) ? { ...entry.metadata } : undefined,
      };
    } else if (type === RPC_QUOTA_FAILURE) {
      details.quotaViolations.push(...parseQuotaViolations(entry.violations));
    } else if (type === RPC_HELP) {
      details.links.push(...parseLinks(entry.links));
    }
  }
  return details;
}

/**
 * gRPC status implied by the message wording. In-band SSE error frames often
 * carry only a message ("429 RESOURCE_EXHAUSTED: Individual quota reached"), so
 * the classifier would otherwise lose the quota/rate-limit dimension entirely.
 */
const MESSAGE_STATUS = [
  [/RESOURCE_EXHAUSTED/i, "RESOURCE_EXHAUSTED"],
  [/INVALID_ARGUMENT/i, "INVALID_ARGUMENT"],
  [/UNAUTHENTICATED/i, "UNAUTHENTICATED"],
  [/PERMISSION_DENIED/i, "PERMISSION_DENIED"],
  [/NOT_FOUND/i, "NOT_FOUND"],
  [/INTERNAL/i, "INTERNAL"],
  [/UNAVAILABLE/i, "UNAVAILABLE"],
];

/** Fill in the gRPC status and leading HTTP code a bare message implies. */
function withInferredStatus(payload) {
  let next = payload;
  if (!next.status) {
    const matched = MESSAGE_STATUS.find(([pattern]) => pattern.test(next.message));
    if (matched) next = { ...next, status: matched[1] };
  }
  if (next.code === undefined) {
    const leading = /^\s*(\d{3})\b/.exec(next.message);
    if (leading) next = { ...next, code: Number(leading[1]) };
  }
  return next;
}

function parseEnvelope(record) {
  const envelope = isRecord(record.error) ? record.error : record;
  if (typeof record.error === "string" && !envelope.message) {
    return textPayload(record.error, "json");
  }
  const status =
    (asString(envelope.status) || asString(record.status) || "").toUpperCase();
  return withInferredStatus({
    kind: "json",
    code: asNumber(envelope.code) ?? asNumber(record.code),
    status,
    message: asString(envelope.message) || asString(record.message) || "",
    details: parseDetails(envelope.details ?? record.details),
  });
}

/**
 * Parse any error body the backend produces into a normalized payload.
 *
 * Tolerates: Google RPC JSON envelopes, double-encoded JSON strings, in-band
 * error objects, plain text, HTML pages and empty bodies.
 */
export function parseErrorPayload(body) {
  if (body === undefined || body === null) return emptyPayload();
  if (isRecord(body)) return parseEnvelope(body);
  const text = String(body);
  if (!text.trim()) return emptyPayload();
  const decoded = decodeJson(text);
  if (decoded?.kind === "value") {
    if (isRecord(decoded.value)) return parseEnvelope(decoded.value);
    // A JSON scalar (`null`, `"text"`) carries no envelope; keep its text.
    return textPayload(String(decoded.value), "text");
  }
  const source = decoded?.kind === "text" ? decoded.value : text;
  if (isHtmlDocument(source)) return { ...emptyPayload(), kind: "html" };
  return textPayload(source, "text");
}

/**
 * True when the response means "this endpoint does not serve this method":
 * an HTML page, or a non-JSON body on a routing-miss status (404/410). A real
 * entity miss answers with a JSON Google RPC envelope instead.
 */
export function isEndpointUnsupportedResponse(status, body) {
  const kind = parseErrorPayload(body).kind;
  if (kind === "html") return true;
  return kind !== "json" && (status === 404 || status === 410);
}

function endpointLabel(endpoint) {
  const text = asString(endpoint);
  if (!text) return "";
  try {
    return new URL(text).host;
  } catch {
    return text.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  }
}

function transportTextOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const causeCode = value?.cause?.code ?? value?.code;
  const detail = value?.message ? String(value.message) : String(value);
  return causeCode ? `${detail} (${causeCode})` : detail;
}

function formatDelay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Reset wording the backend puts in a quota message, e.g. "in 2h 30m". */
function resetWordingOf(text) {
  const value = String(text ?? "");
  const match =
    /(?:resets?|refreshes?)\s+(?:in|after)\s+([^.\n;]+)/i.exec(value) ||
    /please wait\s+([^.\n;]+)/i.exec(value);
  return match?.[1]?.trim() || "";
}

/** Retry delay the backend embeds in the message when no RetryInfo is present. */
function retryDelayFromText(text) {
  const match = /(?:retry|try again|wait)\s+(?:in|after)\s+([\d.]+)\s*(ms|s|seconds?|m|minutes?)/i.exec(
    String(text ?? ""),
  );
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2].toLowerCase();
  const factor = unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1000;
  return Math.max(0, Math.round(amount * factor));
}

function endpointList(tried) {
  const labels = (Array.isArray(tried) ? tried : []).map(endpointLabel).filter(Boolean);
  return labels.length ? labels.join(", ") : "no endpoint";
}

function subjectPhrase({ entity, model }) {
  const hasEntity = Boolean(entity);
  const hasModel = Boolean(model);
  if (hasEntity && hasModel && entity !== model) return `entity "${entity}" (model "${model}")`;
  if (hasEntity) return `entity "${entity}"`;
  if (hasModel) return `model "${model}"`;
  return "";
}

function forSubject(state) {
  const phrase = subjectPhrase(state);
  return phrase ? ` for ${phrase}` : "";
}

function onEndpoint(state) {
  const label = endpointLabel(state.endpoint);
  return label ? ` on ${label}` : "";
}

/** "the stream request" / "the request" — avoids "the request request". */
function operationRequest(state) {
  return state.operation && state.operation !== "request" ? `the ${state.operation} request` : "the request";
}

/** "HTTP 429 RESOURCE_EXHAUSTED" (or the gRPC status / "no response"). */
function statusLabel(state) {
  const http = asNumber(state.httpStatus);
  if (http !== undefined) return `HTTP ${http}${state.grpcStatus ? ` ${state.grpcStatus}` : ""}`;
  if (state.grpcStatus) return state.grpcStatus;
  return "no response";
}

/**
 * True when the failure proves an exhausted quota rather than a transient
 * rate limit. Resource-exhausted wording counts: Google uses it for quota
 * exhaustion too, and the pool must cool the account down for it.
 */
function hasQuotaEvidence(state) {
  if (state.parsed.status === "RESOURCE_EXHAUSTED") return true;
  if (state.parsed.details.quotaViolations.length > 0) return true;
  return QUOTA_WORDING.test(state.haystack);
}

function quotaWindowOf(text) {
  const value = String(text ?? "");
  if (/\bindividual\b/i.test(value)) return "individual ";
  if (/weekly/i.test(value)) return "weekly ";
  if (/five[\s-]?hour|5[\s-]?hour|5h\b/i.test(value)) return "five-hour ";
  return "";
}

function quotaHint(state) {
  const window = quotaWindowOf(state.haystack);
  const reset = state.resetText ? ` — it resets ${state.resetText}` : "";
  const delay = formatDelay(state.retryAfterMs);
  const retry = delay ? ` Retry after ~${delay}.` : "";
  return (
    `wait for the ${window}quota window${reset}, switch to a model/account with remaining quota, ` +
    `or add an account; the pool cools this account down and rotates automatically.${retry}`
  );
}

function rateLimitHint(state) {
  const delay = formatDelay(state.retryAfterMs);
  return delay
    ? `retry after ~${delay}; the pool rotates to another account automatically.`
    : "retry shortly; the pool rotates to another account automatically.";
}

function authHint(state) {
  const links = state.parsed.details.links;
  const help = links.length ? ` (${links[0].url})` : "";
  return `run /antigravity-login to refresh the sign-in; if it still fails, this account's plan may not include the model — check /antigravity-quota${help}.`;
}

const INVALID_REQUEST_HINTS = [
  {
    pattern: /thought[_ ]?signature/i,
    hint: "the replayed reasoning signature was rejected — start a new chat so the history is re-sent without the stale signature, or switch model.",
  },
  {
    pattern: /tool[_ ]?(?:use|result|call)|function[_ ]?(?:call|response)|tool_result|tool_use/i,
    hint: "the tool call/result pairing was rejected — start a new turn so the adapter can re-send the paired tool result.",
  },
  {
    pattern: /non-whitespace|whitespace only|whitespace-only|text content blocks?/i,
    hint: "an empty or whitespace-only text block reached the backend — update the plugin; the adapter already drops those blocks.",
  },
  {
    pattern: /thinking[_ ]?(?:level|config|budget)/i,
    hint: "the selected thinking level is not supported by this model — pick another reasoning effort or switch model.",
  },
  {
    pattern: /invalid json payload|unknown name/i,
    hint: "the request shape was rejected — switch to a simpler model or update the plugin.",
  },
];

function invalidRequestHint(state) {
  const field = state.parsed.details.fieldViolations[0]?.field || "";
  if (/thinking/i.test(field)) {
    return "the selected thinking level is not supported by this model — pick another reasoning effort or switch model.";
  }
  if (/tool|function|schema/i.test(field)) {
    return "the tool schema was rejected — simplify the tool parameters or retry without tools.";
  }
  const matched = INVALID_REQUEST_HINTS.find((entry) => entry.pattern.test(state.haystack));
  if (matched) return matched.hint;
  return "fix the request payload shown above and retry; if it persists, switch model or update the plugin.";
}

function verifyVerdict(state) {
  const subject = forSubject(state);
  const where = onEndpoint(state);
  const status = statusLabel(state);

  if (state.parsed.kind === "html") {
    return {
      kind: "endpoint-unsupported",
      code: CODE_ENDPOINT_UNSUPPORTED,
      headline: `no Antigravity endpoint served ${operationRequest(state)} (last ${status} was an HTML page); tried: ${endpointList(state.triedEndpoints)}`,
      hint: "the endpoints do not expose this method — check ANTIGRAVITY_BASE_URL and the network proxy, and update the plugin if Google moved the method.",
    };
  }

  if (state.httpStatus === undefined && !state.grpcStatus) {
    const timedOut = /timed?\s*out|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(state.transportText);
    if (timedOut) {
      return {
        kind: "timeout",
        code: CODE_TIMEOUT,
        headline: `Antigravity timed out before answering${where}${subject}`,
        hint: "retry the same request; if it repeats, check this machine's network/proxy access to Google.",
      };
    }
    return {
      kind: "transport",
      code: CODE_TRANSPORT,
      headline: `Cannot reach the Antigravity backend${where}${subject}`,
      hint: "retry; if it keeps failing, make sure this machine can reach Google (proxy .env per README) and run /antigravity-doctor.",
    };
  }

  if (state.httpStatus === 429 || state.parsed.status === "RESOURCE_EXHAUSTED" || state.parsed.details.quotaViolations.length) {
    if (hasQuotaEvidence(state)) {
      return {
        kind: "quota",
        code: QUOTA_EXCEEDED_CODE,
        headline: `Antigravity quota exhausted${subject}${where} (${status})`,
        hint: quotaHint(state),
      };
    }
    return {
      kind: "rate-limit",
      code: CODE_RATE_LIMIT,
      headline: `Antigravity rate limited ${operationRequest(state)}${subject}${where} (${status})`,
      hint: rateLimitHint(state),
    };
  }

  if (state.httpStatus === 401 || state.httpStatus === 403 || AUTH_WORDING.test(state.haystack)) {
    return {
      kind: "auth",
      code: CODE_AUTH,
      headline: `Antigravity rejected the account credentials${subject}${where} (${status})`,
      hint: authHint(state),
    };
  }

  if (state.endpointUnsupported) {
    return {
      kind: "endpoint-unsupported",
      code: CODE_ENDPOINT_UNSUPPORTED,
      headline: `no Antigravity endpoint served ${operationRequest(state)} (last ${status}); tried: ${endpointList(state.triedEndpoints)}`,
      hint: "the endpoints do not expose this method — check ANTIGRAVITY_BASE_URL and the network proxy, and update the plugin if Google moved the method.",
    };
  }

  if (state.httpStatus === 404 || state.parsed.status === "NOT_FOUND") {
    const known = Boolean(state.model || state.entity);
    return {
      kind: "not-found",
      code: known ? CODE_MODEL_NOT_FOUND : CODE_NOT_FOUND,
      headline: `Antigravity did not find ${subjectPhrase(state) || "the requested entity"}${where} (${status})`,
      hint: `the catalog may be stale or this plan may not serve the model — run /antigravity-quota to re-discover the catalog, or switch model.`,
    };
  }

  if (state.httpStatus === 400 || state.httpStatus === 422 || state.parsed.status === "INVALID_ARGUMENT") {
    return {
      kind: "invalid-request",
      code: CODE_INVALID_REQUEST,
      headline: `Antigravity rejected ${operationRequest(state)}${subject}${where} (${status})`,
      hint: invalidRequestHint(state),
    };
  }

  const grpc = state.grpcStatus;
  if (state.httpStatus === 408 || grpc === "DEADLINE_EXCEEDED") {
    return {
      kind: "timeout",
      code: CODE_TIMEOUT,
      headline: `Antigravity did not answer in time${subject}${where} (${status})`,
      hint: "retry the same request; if it repeats, switch model.",
    };
  }

  if (state.httpStatus === 409 || grpc === "ABORTED" || grpc === "ALREADY_EXISTS") {
    return {
      kind: "conflict",
      code: CODE_CONFLICT,
      headline: `Antigravity reported a conflict${subject}${where} (${status})`,
      hint: "retry once, or start a new chat if the conflict repeats.",
    };
  }

  if (state.httpStatus >= 500 || ["INTERNAL", "UNAVAILABLE", "UNKNOWN", "DATA_LOSS"].includes(grpc)) {
    const capacity = /capacity|overloaded|unavailable|try again later/i.test(state.haystack);
    if (state.httpStatus === 503 || state.httpStatus === 529 || grpc === "UNAVAILABLE" || capacity) {
      return {
        kind: "overloaded",
        code: CODE_OVERLOADED,
        headline: `Antigravity is out of capacity${subject}${where} (${status})`,
        hint: "retry later or switch model — this is backend capacity, not your quota.",
      };
    }
    return {
      kind: "server",
      code: CODE_SERVER,
      headline: `Antigravity backend failed${subject}${where} (${status})`,
      hint: "retry the request; if it repeats, switch model or update the plugin.",
    };
  }

  return {
    kind: "unknown",
    code: CODE_UNKNOWN,
    headline: `Antigravity request failed${subject}${where} (${status})`,
    hint: "retry once; if it persists, run /antigravity-doctor and include the trace id.",
  };
}

/**
 * Classify one observed failure into the single structured object the adapter
 * renders and records.
 *
 * @param {object} context
 * @param {number} [context.httpStatus] HTTP status of the response, when one arrived.
 * @param {string|object} [context.body] Raw body text or an in-band error object.
 * @param {string} [context.endpoint] Endpoint that produced the failure.
 * @param {string[]} [context.triedEndpoints] Endpoints attempted for this call.
 * @param {string} [context.model] User-facing model id that was requested.
 * @param {string} [context.entity] Runtime entity actually requested.
 * @param {string} [context.traceId] traceId captured from the failing stream.
 * @param {string} [context.requestId] requestId sent in the failing envelope.
 * @param {string} [context.operation] stream|image|vision|quota|catalog|login|probe.
 * @param {string} [context.label] Prefix for the first line (legacy wording such as "Google API 400").
 * @param {Error|string} [context.transportError] Set when no HTTP response arrived.
 * @param {string} [context.retryAfterHeader] Retry-After header value, when present.
 * @returns {object} structured failure
 */
export function classifyAntigravityFailure(context = {}) {
  const parsed = parseErrorPayload(context.body);
  const state = {
    parsed,
    operation: asString(context.operation) || "request",
    httpStatus: asNumber(context.httpStatus) ?? (parsed.code !== undefined ? parsed.code : undefined),
    grpcStatus: parsed.status || "",
    endpoint: asString(context.endpoint) || "",
    triedEndpoints: Array.isArray(context.triedEndpoints) ? context.triedEndpoints : [],
    model: asString(context.model) || "",
    entity: asString(context.entity) || "",
    traceId: redactSecrets(asString(context.traceId) || ""),
    requestId: asString(context.requestId) || "",
    transportText: redactSecrets(transportTextOf(context.transportError)),
    haystack: [parsed.message, parsed.details.errorInfo?.reason, transportTextOf(context.transportError)]
      .filter(Boolean)
      .join(" | "),
    retryAfterMs:
      parsed.details.retryAfterMs ??
      parseRetryAfterHeader(context.retryAfterHeader) ??
      retryDelayFromText(parsed.message),
    resetText: resetWordingOf(parsed.message),
    endpointUnsupported: isEndpointUnsupportedResponse(
      asNumber(context.httpStatus) ?? parsed.code,
      context.body,
    ),
  };
  const verdict = verifyVerdict(state);
  const backendMessage = bounded(redactSecrets(parsed.message), MAX_BACKEND_MESSAGE_CHARS);
  const lines = [`${asString(context.label) ? `${context.label}: ` : ""}${verdict.headline}`];
  if (parsed.kind === "html") {
    lines.push("Backend returned an HTML error page (this endpoint does not serve the method).");
  } else if (backendMessage) {
    lines.push(`Backend said: ${backendMessage}`);
  }
  const violation = parsed.details.fieldViolations[0];
  if (violation) {
    const extra = parsed.details.fieldViolations.length - 1;
    lines.push(
      `Rejected field: ${violation.field}${violation.description ? ` — ${violation.description}` : ""}` +
        (extra > 0 ? ` (+${extra} more)` : ""),
    );
  }
  if (state.traceId) lines.push(`Trace: ${state.traceId}${state.requestId ? ` (request ${state.requestId})` : ""}`);
  lines.push(`Next: ${verdict.hint}`);
  return {
    kind: verdict.kind,
    code: verdict.code,
    headline: verdict.headline,
    hint: verdict.hint,
    message: redactSecrets(lines.join("\n")).slice(0, MAX_ERROR_MESSAGE_CHARS),
    backendMessage,
    httpStatus: state.httpStatus,
    grpcStatus: state.grpcStatus,
    reason: parsed.details.errorInfo?.reason || "",
    field: violation?.field,
    fieldDescription: violation?.description,
    retryAfterMs: state.retryAfterMs,
    retryAfterText: formatDelay(state.retryAfterMs),
    endpoint: state.endpoint,
    model: state.model,
    entity: state.entity,
    traceId: state.traceId,
    requestId: state.requestId,
    operation: state.operation,
    bodyKind: parsed.kind,
    triedEndpoints: state.triedEndpoints,
  };
}

/**
 * Map one observed failure to the LlmError the adapter throws. The structured
 * object stays available on `error.structured` so callers can quote the
 * endpoint/traceId without re-parsing `message`.
 */
export function createAntigravityError(context = {}) {
  const structured = classifyAntigravityFailure(context);
  const error = new LlmError(
    structured.message,
    structured.code,
    context.cause === undefined ? undefined : { cause: context.cause },
  );
  error.structured = structured;
  error.retryAfterMs = structured.retryAfterMs;
  return error;
}
