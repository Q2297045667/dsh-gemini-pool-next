import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createImageGenerateTool } from "../lib/image-tool.js";

async function outputFixture(t) {
  const dir = await mkdtemp(join(process.cwd(), "test", "image-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, output_dir: relative(process.cwd(), dir) };
}

test("image tool render gets its fields from the second argument (arguments, value)", () => {
  const tool = createImageGenerateTool({}, async () => ({ base64: "unused", accountEmail: "unused" }));
  const value = {
    path: "assets/images/hero.png",
    absolutePath: "/tmp/project/assets/images/hero.png",
    filename: "hero.png",
    prompt: "a hero banner",
    markdown: "![hero.png](assets/images/hero.png)",
  };
  // The host calls render(exec.arguments, value): output fields come from the
  // second argument, the tool-call arguments are the first.
  const rendered = tool.output.render({ prompt: "a hero banner" }, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("assets/images/hero.png"));
  assert.ok(rendered[0].text.includes("![hero.png](assets/images/hero.png)"));
  assert.ok(!rendered[0].text.includes("undefined"));
});

test("image generation saves the result and matches the filename to the returned media type", async (t) => {
  const { dir, output_dir } = await outputFixture(t);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const prompts = [];
  const tool = createImageGenerateTool({}, async (prompt) => {
    prompts.push(prompt);
    return { base64: bytes.toString("base64"), mimeType: "image/jpeg", accountEmail: "image@example.com" };
  });
  const value = await tool.execute({ prompt: "  a red square  ", filename: "nested/hero.png", output_dir });
  assert.equal(value.filename, "hero.jpg");
  assert.equal(value.mimeType, "image/jpeg");
  assert.equal(value.absolutePath, join(dir, "hero.jpg"));
  assert.equal(value.usedAccount, "image@example.com");
  assert.deepEqual(await readFile(value.absolutePath), bytes);
  assert.deepEqual(prompts, ["a red square"]);
});

test("legacy image responses without a media type use PNG", async (t) => {
  const { output_dir } = await outputFixture(t);
  const tool = createImageGenerateTool({}, async () => ({ base64: "QUJD" }));
  const value = await tool.execute({ prompt: "a square", filename: "square", output_dir });
  assert.equal(value.filename, "square.png");
  assert.equal(value.mimeType, "image/png");
  assert.equal(await readFile(value.absolutePath, "utf8"), "ABC");
});

test("invalid prompt, filename and escaping output directory are rejected before generation", async (t) => {
  const { output_dir } = await outputFixture(t);
  let calls = 0;
  const tool = createImageGenerateTool({}, async () => { calls++; return { base64: "QUJD" }; });
  await assert.rejects(() => tool.execute({ prompt: " " }), /prompt.*empty/i);
  await assert.rejects(() => tool.execute({ prompt: "x", filename: "bad name.png", output_dir }), /filename/i);
  await assert.rejects(() => tool.execute({ prompt: "x", output_dir: "../outside" }), /project root/i);
  assert.equal(calls, 0);
});

test("image generation rejects unsupported media types and oversized results without writing files", async (t) => {
  const { dir, output_dir } = await outputFixture(t);
  const unsupported = createImageGenerateTool({}, async () => ({ base64: "QUJD", mimeType: "image/svg+xml" }));
  await assert.rejects(() => unsupported.execute({ prompt: "x", output_dir }), /unsupported.*image type/i);
  const oversized = createImageGenerateTool({}, async () => ({ base64: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") }));
  await assert.rejects(() => oversized.execute({ prompt: "x", output_dir }), /exceeds size limit/i);
  assert.deepEqual(await readdir(dir), []);
});

test("image generation rejects output-directory and output-file symlinks that escape the workspace", async (t) => {
  const { dir, output_dir } = await outputFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "image-output-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(dir, "linked-dir"));
  const secret = join(outside, "secret.png");
  await writeFile(secret, "original");
  await symlink(secret, join(dir, "linked-file.png"));
  let calls = 0;
  const tool = createImageGenerateTool({}, async () => { calls++; return { base64: "QUJD" }; });
  await assert.rejects(() => tool.execute({ prompt: "x", output_dir: join(output_dir, "linked-dir", "nested") }), /project root/i);
  assert.equal(calls, 0);
  await assert.rejects(() => tool.execute({ prompt: "x", filename: "linked-file.png", output_dir }), /ELOOP|symbolic link/i);
  assert.equal(await readFile(secret, "utf8"), "original");
});

test("explicit user configuration can still save generated images outside the workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "image-output-configured-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configured = join(dir, "nested");
  const tool = createImageGenerateTool({ imageOutputDir: configured }, async () => ({ base64: "QUJD" }));
  const value = await tool.execute({ prompt: "x", filename: "configured" });
  assert.equal(value.absolutePath, join(configured, "configured.png"));
  assert.equal(await readFile(value.absolutePath, "utf8"), "ABC");
});
