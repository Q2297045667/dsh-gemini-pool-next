/**
 * Image generation tool for Google Antigravity / Gemini image models.
 */
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

function isInsideRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Generated images are UI assets; 20 MiB is far above any legitimate render. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

async function existingRealAncestor(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return existingRealAncestor(dirname(path));
  }
}

function sanitizeImageFilename(value) {
  if (value === undefined || value === null || value === "") return null;
  const base = String(value).split(/[\\/]/).pop();
  if (!/^[\w.-]+$/.test(base)) {
    throw new Error(`image filename must contain only letters, digits, dot, dash or underscore, got: ${value}`);
  }
  return /\.(png|jpe?g|webp)$/i.test(base) ? base : `${base}.png`;
}

export function createImageGenerateTool(poolManager, sendImageRequestFn) {
  return {
    name: "antigravity_image_generate",
    description:
      "Generate frontend image assets using Google Antigravity (Gemini 3.1 Flash Image) from the multi-account pool. Automatically saves to workspace assets folder and returns relative path for use in HTML/React code.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate, including style, lighting, subjects, and colors.",
        },
        filename: {
          type: "string",
          description: "Optional output filename, e.g. hero-bg.png, feature-chart.png. Defaults to generated name.",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory relative to project root. Defaults to assets/images.",
        },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          prompt: { type: "string" },
          markdown: { type: "string" },
          mimeType: { type: "string" },
        },
      },
      // The host calls render(exec.arguments, value): the execute result is
      // the second argument.
      render: (args, value) => [
        {
          type: "text",
          text: `Generated image: ${value.path}\n\n${value.markdown}`,
        },
      ],
    },
    execute: async (args) => {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("Image prompt must not be empty.");

      const root = process.cwd();
      const configDir = poolManager.imageOutputDir;
      const rawDir = args.output_dir || configDir || "./assets/images";
      const absDir = resolve(root, rawDir);
      const isUserConfiguredDir = Boolean(configDir) && absDir === resolve(root, configDir);
      if (!isUserConfiguredDir && !isInsideRoot(absDir, root)) {
        throw new Error(`image output_dir must resolve inside the project root, got: ${rawDir}`);
      }
      const realRoot = await realpath(root);
      if (!isUserConfiguredDir && !isInsideRoot(await existingRealAncestor(absDir), realRoot)) {
        throw new Error(`image output_dir must resolve inside the project root, got: ${rawDir}`);
      }

      const hash = createHash("md5").update(prompt + Date.now()).digest("hex").slice(0, 8);
      const requestedFilename = sanitizeImageFilename(args.filename) ?? `img-${hash}.png`;

      // Call Google Cloud Code Assist through the pool
      const result = await sendImageRequestFn(prompt);
      if (!result?.base64) {
        throw new Error(result?.error || "Failed to generate image from Google Antigravity.");
      }
      const mimeType = String(result.mimeType || "image/png").split(";")[0].trim().toLowerCase();
      const extension = Object.hasOwn(IMAGE_EXTENSIONS, mimeType) ? IMAGE_EXTENSIONS[mimeType] : undefined;
      if (!extension) throw new Error(`Unsupported generated image type: ${mimeType}`);
      const filename = requestedFilename.replace(/\.(png|jpe?g|webp)$/i, extension);
      const targetPath = join(rawDir, filename);
      const absPath = resolve(root, targetPath);

      const bytes = Buffer.from(result.base64, "base64");
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `generated image exceeds size limit: ${bytes.length} bytes > ${MAX_IMAGE_BYTES} bytes`,
        );
      }

      await mkdir(dirname(absPath), { recursive: true });
      if (!isUserConfiguredDir && !isInsideRoot(await realpath(dirname(absPath)), realRoot)) {
        throw new Error(`image output_dir must resolve inside the project root, got: ${rawDir}`);
      }
      const existing = await lstat(absPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw new Error(`image output file must not be a symbolic link: ${targetPath}`);
      await writeFile(absPath, bytes, {
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      });

      return {
        path: targetPath,
        absolutePath: absPath,
        filename,
        prompt,
        mimeType,
        usedAccount: result.accountEmail,
        markdown: `![${filename}](${targetPath})`,
      };
    },
  };
}
