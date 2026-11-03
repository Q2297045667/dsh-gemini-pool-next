import assert from "node:assert/strict";
import test from "node:test";

import { resolveImageInput } from "../lib/vision-tool.js";

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function imageResponse(bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType = "image/png", headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType, ...headers },
  });
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

// SSRF red line first: private/loopback/metadata targets must be refused
// before any fetch happens. IP literals resolve locally, no network needed.
test("refuses loopback, private, and link-local URL targets (SSRF red line)", async () => {
  for (const ref of [
    "http://localhost/x.png",
    "http://127.0.0.1/x.png",
    "http://192.168.1.1/x.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/x.png",
    "http://172.16.0.9/x.png",
    "http://[::1]/x.png",
    "http://[fe80::1]/x.png",
    "http://0.0.0.0/x.png",
  ]) {
    await assert.rejects(() => resolveImageInput(ref), /non-public address/i, ref);
  }
  // Non-http(s) protocols are out of scope entirely.
  await assert.rejects(() => resolveImageInput("ftp://example.com/x.png"), /only http\(s\) is allowed/i);
});

test("refuses IPv4-mapped internal addresses and non-public IPv4 ranges before fetch", async () => {
  await withStubbedFetch(
    () => { throw new Error("unsafe target reached fetch"); },
    async () => {
      for (const address of ["::ffff:7f00:1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "::7f00:1", "fec0::1", "ff02::1", "100.64.0.1", "224.0.0.1"]) {
        await assert.rejects(
          () => resolveImageInput("http://example.test/x.png", {
            lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
          }),
          /non-public address/i,
          address,
        );
      }
    },
  );
});

test("accepts public IPv6 and IPv4-mapped public addresses", async () => {
  await withStubbedFetch(
    () => imageResponse(),
    async () => {
      for (const address of ["2606:4700:4700::1111", "::ffff:808:808"]) {
        const result = await resolveImageInput("https://example.test/x.png", {
          lookup: async () => [{ address, family: 6 }],
        });
        assert.equal(result.mimeType, "image/png");
      }
    },
  );
});

test("fetches a public image URL into base64 with the response mime type", async () => {
  await withStubbedFetch(
    (url) => {
      assert.ok(url === "http://1.1.1.1/x.png", "must hit the exact URL");
      return imageResponse(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    },
    async () => {
      const { base64, mimeType } = await resolveImageInput("http://1.1.1.1/x.png");
      assert.equal(mimeType, "image/png");
      assert.equal(Buffer.from(base64, "base64").length, 8);
    },
  );
});

test("rejects non-image content types", async () => {
  await withStubbedFetch(
    () => imageResponse(Buffer.from("<html/>"), "text/html"),
    async () => {
      await assert.rejects(
        () => resolveImageInput("http://1.1.1.1/page.html"),
        /only image\/\* responses are accepted/i,
      );
    },
  );
});

test("rejects declared and streamed payloads above the 10 MiB limit", async () => {
  await withStubbedFetch(
    () => imageResponse(Buffer.alloc(8), "image/png", { "content-length": String(10 * 1024 * 1024 + 1) }),
    async () => {
      await assert.rejects(() => resolveImageInput("http://1.1.1.1/huge.png"), /exceeds size limit/i);
    },
  );
  // No content-length: the streamed byte counter must catch it instead.
  await withStubbedFetch(
    () => imageResponse(Buffer.alloc(10 * 1024 * 1024 + 1)),
    async () => {
      await assert.rejects(() => resolveImageInput("http://1.1.1.1/huge.png"), /exceeds size limit/i);
    },
  );
});

test("rejects when the fetch times out", async () => {
  await withStubbedFetch(
    async () => {
      throw timeoutError;
    },
    async () => {
      await assert.rejects(() => resolveImageInput("http://1.1.1.1/slow.png"), /timeout/i);
    },
  );
});

test("redirects are followed manually and each hop is re-checked (SSRF)", async () => {
  // A redirect to an internal target is refused even though the first hop
  // was public.
  await withStubbedFetch(
    (url) => (url === "http://1.1.1.1/jump" ? redirectResponse("http://192.168.1.1/secret.png") : imageResponse()),
    async () => {
      await assert.rejects(() => resolveImageInput("http://1.1.1.1/jump"), /non-public address/i);
    },
  );
  // More than 3 redirects are refused outright.
  let hops = 0;
  await withStubbedFetch(
    (url) => {
      hops += 1;
      return redirectResponse(`http://1.1.1.1/hop${hops}`);
    },
    async () => {
      await assert.rejects(() => resolveImageInput("http://1.1.1.1/hop0"), /exceeded 3 redirects/i);
      assert.ok(hops <= 5, "must stop following redirects at the cap");
    },
  );
});

test("every resolved DNS record must be public (mixed records are refused)", async () => {
  const fakeLookup = async (host) => {
    assert.equal(host, "examples.test");
    return [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
  };
  await assert.rejects(
    () => resolveImageInput("http://examples.test/x.png", { lookup: fakeLookup }),
    /non-public address/i,
  );
});
