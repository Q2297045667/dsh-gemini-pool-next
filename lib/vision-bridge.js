/**
 * Vision bridge: rewrites image blocks into pool-generated text descriptions
 * at the agent/pre-step waterfall, giving text-only models seamless vision.
 *
 * Why pre-step and not llm/stream (Refs #7): the cordis waterfall's `next`
 * is a zero-argument closure over the original listener arguments, and the
 * llm/stream built-in ignores call arguments entirely (it closes over the
 * original `options`) — so an override passed to `next({...options, messages})`
 * on llm/stream is silently discarded and the rewrite never reaches the
 * provider. agent/pre-step hands the listener the step's DECISION after
 * `await next()`; returning `{ ...decision, messages }` is the host-consumed
 * channel (the same pattern the host's own installModelSelection uses), so
 * the rewritten messages become the actual request source for every session
 * regardless of when it was created.
 *
 * Descriptions are cached per image for the process lifetime (session
 * history resends the same image every turn); any failure keeps the original
 * image block so the host's placeholder path still applies (fail-open).
 *
 * Scope: agent/pre-step rewrites the step's NEWLY CLAIMED input (pasted
 * images ride here) plus injected context; images that entered history via
 * tool-result events (e.g. the host read_image tool) are not part of
 * decision.messages and keep the placeholder + antigravity_read_image
 * fallback — the same coverage the reference implementations chose.
 */
import { createHash } from "node:crypto";
import { resolveImageInput } from "./vision-tool.js";

// The host event this bridge rides. Kept next to the probe below so the
// registration and the doctor's liveness check cannot drift apart.
export const VISION_BRIDGE_EVENT = "agent/pre-step";

const ATTACHMENT_ID_RE = /^(?:sha256:)?([a-fA-F0-9]{64})$/i;
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

// Identity tag for the event handler. ctx.on() stores the listener wrapped
// in a traceability Proxy that only traps apply/construct, so symbol
// property reads forward to the tagged function; scanning the host's public
// listener registry for this tag answers "is the bridge on the bus right
// now" (Refs #7) without dispatching anything.
const VISION_BRIDGE_TAG = Symbol.for("dsh-gemini-pool.vision-bridge");

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasImageBlock(messages) {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        Array.isArray(message?.content) && message.content.some((block) => block?.type === "image"),
    )
  );
}

function countImageBlocks(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce(
    (total, message) =>
      total +
      (Array.isArray(message?.content)
        ? message.content.filter((block) => block?.type === "image").length
        : 0),
    0,
  );
}

/**
 * Extract the image source behind an image block. Returns
 * { cacheKey, traceId, mimeType, getBase64 } or null when the block carries
 * no attachment id and no inline data.
 */
function imageSourceOf(block, resolveImage) {
  const attachment = block.attachment;
  const attachmentId = attachment ? asString(attachment.attachmentId) : undefined;
  const idMatch = attachmentId ? ATTACHMENT_ID_RE.exec(attachmentId) : null;
  if (idMatch) {
    const hex = idMatch[1].toLowerCase();
    let resolved;
    const once = async () => resolved || (resolved = await resolveImage(idMatch[0]));
    return {
      cacheKey: hex,
      traceId: `sha256:${hex}`,
      followup: `original attachment: sha256:${hex}; call antigravity_read_image with the 8-char hash prefix to look again`,
      mimeType: asString(attachment.mediaType) || asString(block.mimeType) || asString(block.mediaType),
      getBase64: async () => (await once()).base64,
      getResolvedMimeType: async () => (await once()).mimeType,
    };
  }

  const source = block.source;
  const raw =
    asString(block.data) ||
    asString(block.base64) ||
    (source ? asString(source.data) || asString(source.base64) : undefined);
  if (!raw) return null;

  // Remote image: cache key is the sha256 of the normalized URL so the same
  // picture is described once regardless of where it reappears. Follow-up
  // reads use the URL, since its digest is not a stored attachment id.
  if (/^https?:\/\//i.test(raw)) {
    let normalized;
    try {
      normalized = new URL(raw).href;
    } catch {
      return null;
    }
    const digest = sha256Hex(Buffer.from(normalized));
    let resolved;
    const once = async () => resolved || (resolved = await resolveImage(raw));
    return {
      cacheKey: digest,
      traceId: `sha256:${digest.slice(0, 8)}`,
      followup: `original image URL: ${normalized}; call antigravity_read_image with this URL to look again`,
      mimeType: asString(block.mimeType) || asString(block.mediaType),
      getBase64: async () => (await once()).base64,
      getResolvedMimeType: async () => (await once()).mimeType,
    };
  }

  const dataUrlMatch = DATA_URL_RE.exec(raw);
  if (dataUrlMatch) {
    const digest = sha256Hex(Buffer.from(dataUrlMatch[2], "base64"));
    return {
      cacheKey: digest,
      traceId: `sha256:${digest}`,
      mimeType: asString(block.mimeType) || asString(block.mediaType) || dataUrlMatch[1],
      getBase64: async () => dataUrlMatch[2],
    };
  }

  const digest = sha256Hex(Buffer.from(raw, "base64"));
  return {
    cacheKey: digest,
    traceId: `sha256:${digest}`,
    mimeType: asString(block.mimeType) || asString(block.mediaType) || "image/png",
    getBase64: async () => raw,
  };
}

/**
 * Build the agent/pre-step handler. All knobs are injectable:
 * - isEnabled(): runtime switch (visionEnabled, flipped after pool init)
 * - resolveRoute(payload): { provider, model } the upcoming request will use
 *   (index.js derives it from payload.agent.options / session header)
 * - isTextOnlyModel(provider, model): gate via the unwrapped resolveModelInfo
 * - describeImage(base64, mimeType): pool description call
 * - resolveImage: attachment/inline resolution (tests inject a stub)
 * - log(message): decision-chain diagnostics, one line per decision on the
 *   image path only (Refs #7). Zero lines on a step the bridge never touched
 *   is itself the diagnostic for "the event does not reach the bridge".
 *
 * The modlens/host-model-selection pattern: run AFTER next() so the final
 * message set (post compaction, context injection, sibling listeners) is
 * what gets rewritten, then return a new decision object. Rejected or
 * non-enter decisions ride through untouched; every failure path keeps the
 * original decision (fail-open).
 */
export function createVisionBridge({ isEnabled, resolveRoute, isTextOnlyModel, describeImage, resolveImage = resolveImageInput, log = console.log }) {
  // cacheKey -> Promise<description text>. Storing the promise deduplicates
  // concurrent turns; failures are evicted so a later turn retries.
  const descriptions = new Map();

  function describeCached(cacheKey, load) {
    let pending = descriptions.get(cacheKey);
    if (!pending) {
      pending = (async () => load())().catch((error) => {
        descriptions.delete(cacheKey);
        throw error;
      });
      descriptions.set(cacheKey, pending);
    }
    return pending;
  }

  // Returns the rewritten messages array plus per-image stats, or null
  // messages when nothing changed (every description failed or no image
  // block carried usable data). The stats distinguish those two passthrough
  // reasons so the decision log names the exact exit (Refs #7).
  async function rewriteMessages(messages) {
    const stats = { described: 0, failed: 0, unresolved: 0 };
    const result = await Promise.all(
      messages.map(async (message) => {
        if (!Array.isArray(message?.content) || !message.content.some((block) => block?.type === "image")) {
          return message;
        }
        const content = await Promise.all(
          message.content.map(async (block) => {
            if (!block || block.type !== "image") return block;
            const image = imageSourceOf(block, resolveImage);
            if (!image) {
              stats.unresolved += 1;
              return block;
            }
            let text;
            try {
              text = await describeCached(image.cacheKey, async () =>
                describeImage(await image.getBase64(), image.mimeType || (await image.getResolvedMimeType?.())),
              );
            } catch (error) {
              stats.failed += 1;
              console.warn(
                "[Antigravity Pool Vision] image description failed, keeping the original image block:",
                error?.message || error,
              );
              return block;
            }
            stats.described += 1;
            return {
              type: "text",
              text:
                `[Image, described by Gemini from the Antigravity pool]\n${text}\n` +
                `(${image.followup || `original inline image: ${image.traceId}; this hash is a trace identifier, not a stored attachment`})`,
            };
          }),
        );
        return { ...message, content };
      }),
    );
    return stats.described > 0 ? { messages: result, stats } : { messages: null, stats };
  }

  const handler = async function visionBridge(payload, next) {
    const decision = await next();
    try {
      // Sync gates before any async work: non-enter decisions and
      // image-free steps pass through with zero overhead and zero log lines.
      if (decision?.kind !== "enter") return decision;
      if (!isEnabled?.()) return decision;
      if (!hasImageBlock(decision?.messages)) return decision;
      const route = resolveRoute(payload);
      // Positive control (Refs #7): this line proves the event reached the
      // handler with images, before any decision is made.
      log(`request provider=${route?.provider} model=${route?.model} images=${countImageBlocks(decision.messages)}`);
      let textOnly = false;
      try {
        textOnly = await isTextOnlyModel(route?.provider, route?.model);
      } catch (error) {
        log(`model gate: resolve=error (${error?.message || error})`);
        log("passthrough: reason=gate-error");
        return decision;
      }
      log(`model gate: textOnly=${textOnly}`);
      if (!textOnly) {
        log("passthrough: reason=not-text-only");
        return decision;
      }
      const { messages, stats } = await rewriteMessages(decision.messages);
      if (!messages) {
        log(
          stats.failed > 0
            ? `passthrough: reason=all-describe-failed (${stats.failed} failed)`
            : `passthrough: reason=no-usable-source (${stats.unresolved} unresolved)`,
        );
        return decision;
      }
      log(`rewrote: ${stats.described} image block(s) replaced`);
      return { ...decision, messages };
    } catch (error) {
      console.warn("[Antigravity Pool Vision] bridge error, passing the request through:", error?.message || error);
      return decision;
    }
  };
  handler[VISION_BRIDGE_TAG] = true;
  return handler;
}

/**
 * Probe whether a vision bridge handler is currently registered on the
 * host's event bus (Refs #7).
 *
 * The cordis EventsService keeps every listener record in the public
 * `events._hooks[name]` array, and a `{ global: true }` record is selected
 * by every dispatch regardless of context filtering — so tag presence in
 * that array means the bridge WILL run on the next agent/pre-step dispatch.
 * This separates "registered" bookkeeping (set right after ctx.on) from
 * actual liveness: a handler silently dropped from the bus reads as false
 * here.
 *
 * Returns true (a bridge is on the bus now), false (no bridge on the bus),
 * or undefined when the bus layout cannot be read (host drift); callers
 * should then keep their bookkeeping value instead of reporting a false
 * alarm.
 */
export function isVisionBridgeHookLive(events) {
  const hookTable = events?._hooks;
  if (!hookTable || typeof hookTable !== "object") return undefined;
  // Cordis >= 4.0.6 removes a hook key entirely once its last listener is
  // disposed, so a readable bus without the key is a truthful "no bridge".
  const hooks = hookTable[VISION_BRIDGE_EVENT];
  if (hooks === undefined) return false;
  if (!Array.isArray(hooks)) return undefined;
  return hooks.some((hook) => hook?.callback?.[VISION_BRIDGE_TAG] === true);
}
