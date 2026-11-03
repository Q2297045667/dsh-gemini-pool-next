/**
 * Vision bypass tool: lets text-only host models read images through the
 * Antigravity pool (a Gemini model describes the image in text).
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 15000;
const URL_MAX_REDIRECTS = 3;

const defaultLookup = (hostname, options) => dns.lookup(hostname, options);

// Host placeholders carry "sha256:<hex>"; 8 hex chars are enough to disambiguate
// objects while staying copyable from the placeholder text.
const ATTACHMENT_HASH_RE = /^(?:sha256:)?([a-fA-F0-9]{8,64})$/;
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

const EXTENSION_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const DEFAULT_VISION_PROMPT =
  "Describe this image in detail, including any visible text, layout, and notable elements.";

function mediaTypeForFilename(name) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "image/png";
  return EXTENSION_MEDIA_TYPES[name.slice(dot).toLowerCase()] || "image/png";
}

// Attachment objects carry no extension and local files may be mislabeled:
// magic bytes beat both guesses.
function sniffImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "GIF8") {
    return "image/gif";
  }
  return null;
}

// Same containment rule as the image generation tool: the model may only
// read files from the workspace or the DSH attachments store. Everything
// else is an arbitrary-file-read path to Google and is refused.
function isInsideRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSizeLimit(base64) {
  const byteLength = Buffer.byteLength(base64, "base64");
  if (byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`image exceeds size limit: ${byteLength} bytes > ${MAX_INPUT_IMAGE_BYTES} bytes`);
  }
}

// The SSRF boundary for http(s) image sources: only globally routable public
// addresses pass. The first URL test ever added must stay the localhost
// refusal (see test/vision-url.test.mjs).
function isForbiddenAddress(address) {
  const value = String(address).toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
    if (a === 192 && (b === 168 || (b === 0 && (octets[2] === 0 || octets[2] === 2)))) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) return true;
    if (a === 203 && b === 0 && octets[2] === 113) return true; // documentation
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const unwrapped = value.replace(/^\[|\]$/g, "");
  if (isIP(unwrapped) !== 6) return true;
  const v6 = new URL(`http://[${unwrapped}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(v6);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isForbiddenAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Only 2000::/3 is global unicast; reject local, compatible, multicast,
  // unspecified and reserved IPv6 ranges, plus the documentation prefix.
  return !/^[23]/.test(v6) || v6.startsWith("2001:db8:");
}

/**
 * Validate an http(s) image URL: scheme must be http/https and every address
 * the hostname resolves to must be public. The host fetch transport performs
 * its own DNS resolution, so this preflight cannot pin the connection's IP.
 */
async function assertPublicHttpUrl(ref, lookup) {
  let url;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`Invalid image URL: ${ref}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported image URL protocol "${url.protocol}"; only http(s) is allowed.`);
  }
  // Bracketed IPv6 literals must be unwrapped before dns.lookup.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = await lookup(hostname, { all: true });
  for (const record of records || []) {
    if (isForbiddenAddress(record.address)) {
      throw new Error(
        `image URL host "${url.hostname}" resolves to a non-public address (${record.address}); only public http(s) URLs are supported.`,
      );
    }
  }
  if (!records || records.length === 0) {
    throw new Error(`image URL host "${url.hostname}" did not resolve to any address.`);
  }
  return url;
}

/**
 * Download an image from a public http(s) URL: manual redirects (each hop
 * re-checked), 15s timeout, image/* content type only, 10 MiB cap enforced
 * both by content-length pre-check and streamed byte counting.
 */
async function fetchImageFromUrl(ref, lookup) {
  let url = await assertPublicHttpUrl(ref, lookup);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`image URL redirect from "${url.href}" has no Location header.`);
      if (redirects >= URL_MAX_REDIRECTS) {
        throw new Error(`image URL "${ref}" exceeded ${URL_MAX_REDIRECTS} redirects.`);
      }
      url = await assertPublicHttpUrl(new URL(location, url).href, lookup);
      continue;
    }
    if (!response.ok) {
      throw new Error(`image URL request failed: HTTP ${response.status} for ${url.href}`);
    }
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`image URL "${url.href}" returned Content-Type "${contentType || "none"}"; only image/* responses are accepted.`);
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`image exceeds size limit: ${declared} bytes > ${MAX_INPUT_IMAGE_BYTES} bytes`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_INPUT_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image exceeds size limit: > ${MAX_INPUT_IMAGE_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const mimeType = contentType || "image/png";
    return { base64: Buffer.concat(chunks).toString("base64"), mimeType };
  }
}

/**
 * Resolve the tool's `image` argument to { base64, mimeType }.
 * Accepts, in order: an attachment hash prefix (looked up under
 * attachmentsRoot, the DSH attachments object store), a public http(s) URL
 * (fetched with SSRF guards), a data: URL, or a local file path.
 */
export async function resolveImageInput(
  imageRef,
  { attachmentsRoot = dshHomePath("attachments", "v1", "objects"), lookup = defaultLookup } = {},
) {
  const ref = typeof imageRef === "string" ? imageRef.trim() : "";
  if (!ref) {
    throw new Error("image must be an attachment hash prefix, an http(s) URL, a local file path, or a data: URL.");
  }

  const hashMatch = ATTACHMENT_HASH_RE.exec(ref);
  if (hashMatch) {
    const hex = hashMatch[1].toLowerCase();
    const bucket = resolvePath(attachmentsRoot, hex.slice(0, 2));
    const entries = existsSync(bucket)
      ? (await readdir(bucket)).filter((name) => name.toLowerCase().startsWith(hex))
      : [];
    if (entries.length === 0) {
      throw new Error(`No attachment found for hash prefix "${ref}" under ${attachmentsRoot}.`);
    }
    if (entries.length > 1) {
      throw new Error(
        `Attachment hash prefix "${ref}" is ambiguous: ${entries.length} objects share it. Use a longer prefix.`,
      );
    }
    const objectPath = await realpath(resolvePath(bucket, entries[0]));
    if (!isInsideRoot(objectPath, await realpath(attachmentsRoot))) {
      throw new Error("attachment objects must stay inside the DSH attachments store.");
    }
    const bytes = await readFile(objectPath);
    const base64 = bytes.toString("base64");
    assertSizeLimit(base64);
    return { base64, mimeType: sniffImageMediaType(bytes) || mediaTypeForFilename(entries[0]) };
  }

  // Any "scheme://" form goes through the guarded URL path, where non-http(s)
  // protocols are refused and http(s) hosts must resolve to public addresses.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    return fetchImageFromUrl(ref, lookup);
  }

  if (ref.startsWith("data:")) {
    const match = DATA_URL_RE.exec(ref);
    if (!match) {
      throw new Error('Invalid data: URL (expected "data:<mime>;base64,<payload>").');
    }
    assertSizeLimit(match[2]);
    return { base64: match[2], mimeType: match[1] };
  }

  const filePath = resolvePath(ref);
  // Containment: the model is untrusted input. Only workspace files and the
  // DSH attachments store may be read; anything else is an arbitrary file
  // read that would be uploaded to Google.
  const workspaceRoot = process.cwd();
  if (!isInsideRoot(filePath, workspaceRoot) && !isInsideRoot(filePath, dshHomePath("attachments"))) {
    throw new Error(
      `local image paths must stay inside the workspace (${workspaceRoot}) or the DSH attachments store; refused: ${ref}`,
    );
  }
  if (!existsSync(filePath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }
  const resolvedFile = await realpath(filePath);
  const workspaceReal = await realpath(workspaceRoot);
  if (!isInsideRoot(resolvedFile, workspaceReal)) {
    const attachmentsReal = await realpath(dshHomePath("attachments")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!attachmentsReal || !isInsideRoot(resolvedFile, attachmentsReal)) {
      throw new Error(`local image paths must stay inside the workspace or the DSH attachments store; refused: ${ref}`);
    }
  }
  const bytes = await readFile(resolvedFile);
  const base64 = bytes.toString("base64");
  assertSizeLimit(base64);
  return { base64, mimeType: sniffImageMediaType(bytes) || mediaTypeForFilename(filePath) };
}

export function createVisionTool(poolManager, sendVisionRequestFn) {
  return {
    name: "antigravity_read_image",
    description:
      "Read an image and return a detailed text description generated by Gemini from the Antigravity pool, for models that cannot see images. " +
      "When you see a placeholder like [image omitted because this model accepts text only; attachment sha256:<hex>], extract the hex after " +
      "'sha256:' and pass it as the image argument. " +
      "Do not use this tool when the current model accepts image input itself. " +
      "Accepts an attachment hash prefix, a local file path inside the workspace, a data: URL, or an http(s) URL — remote URLs are fetched " +
      "with SSRF guards (public addresses only, image responses only).",
    parameters: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            "attachment hash prefix (the hex after 'sha256:' in the image placeholder), a local file path inside the workspace, a data: URL, or an http(s) image URL",
        },
        prompt: {
          type: "string",
          description: "What to look for or answer about the image. Defaults to a full description.",
        },
      },
      required: ["image"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          image: { type: "string" },
          account: { type: "string" },
        },
      },
      // The host calls render(exec.arguments, value): the execute result is
      // the second argument.
      render: (args, value) => [
        {
          type: "text",
          text: `Image description (via ${value.account}):\n\n${value.description}`,
        },
      ],
    },
    execute: async (args) => {
      const imageRef = String(args.image || "").trim();
      if (!imageRef) {
        throw new Error("image must be an attachment hash prefix, an http(s) URL, a local file path, or a data: URL.");
      }
      const { base64, mimeType } = await resolveImageInput(imageRef);
      const result = await sendVisionRequestFn(base64, mimeType, args.prompt || DEFAULT_VISION_PROMPT);
      if (!result?.text) {
        throw new Error(result?.error || "Failed to describe the image through the Antigravity pool.");
      }
      return { description: result.text, image: args.image, account: result.accountEmail };
    },
  };
}
