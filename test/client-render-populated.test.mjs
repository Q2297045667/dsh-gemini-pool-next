// Renders the settings section with REAL data shapes (fixture captured from the live
// /antigravity/api/status endpoint, PII scrubbed) and asserts the card actually shows
// content: account row, quota rows, model list.
//
// This complements client-render.test.mjs. That file proves the component does not throw;
// this one proves the populated render path produces the visible content a user expects,
// and that mounting the panel triggers a quota refresh (the "opening settings should
// refresh quota immediately" requirement).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(here, "..", "lib", "client.js");

// 同 client-render.test.mjs：lib/client.js 含两个 ModuleLoader 块，本测试只
// 针对本插件（dsh-gemini-pool-next）的设置页，故只取第一个块。
function loadGeminiSource() {
  const full = readFileSync(CLIENT_PATH, "utf8");
  const marker = "window.__ModuleLoader__.load(";
  const first = full.indexOf(marker);
  assert.notEqual(first, -1, "lib/client.js must contain a ModuleLoader block");
  const second = full.indexOf(marker, first + marker.length);
  return second === -1 ? full : full.slice(0, second);
}
const FIXTURE_PATH = join(here, "fixtures", "status-value.json");

const STATUS_FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** DOM stub (same shape as client-render.test.mjs). */
function makeDomStub() {
  const makeEl = (tag = "div") => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    prepend(...c) { this.children.unshift(...c); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    replaceChild(c) { this.children = [c]; return c; },
    remove() {},
    contains: () => false,
    closest: () => null,
    matches: () => false,
    cloneNode() { return makeEl(tag); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    textContent: "",
    innerHTML: "",
  });
  const head = makeEl("head");
  const body = makeEl("body");
  const documentElement = makeEl("html");
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  return {
    document: {
      documentElement, head, body,
      createElement: makeEl,
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  };
}

/**
 * React shim with a real hook store and a re-render loop, so mount effects that call
 * setState actually update the tree — which is how the panel loads its data in the browser.
 */
function createReactRuntime() {
  const instances = [];
  let current = null;
  const pendingEffects = [];

  const React = {
    createElement(type, props, ...children) {
      return {
        __vnode: true,
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      };
    },
    useState(initial) {
      const inst = current;
      const idx = inst.hookIndex++;
      if (!(idx in inst.hooks)) inst.hooks[idx] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        const value = typeof next === "function" ? next(inst.hooks[idx]) : next;
        if (Object.is(value, inst.hooks[idx])) return;
        inst.hooks[idx] = value;
        inst.dirty = true;
      };
      return [inst.hooks[idx], set];
    },
    useMemo(factory, deps) {
      const inst = current;
      const idx = inst.hookIndex++;
      const prev = inst.hooks[idx];
      if (!prev || !deps || deps.some((dep, i) => !Object.is(dep, prev.deps?.[i]))) {
        inst.hooks[idx] = { deps, value: factory() };
      }
      return inst.hooks[idx].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useRef(initial) {
      const inst = current;
      const idx = inst.hookIndex++;
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: initial };
      return inst.hooks[idx];
    },
    useEffect(fn) {
      const inst = current;
      const idx = inst.hookIndex++;
      const deps = arguments.length > 1 ? arguments[1] : undefined;
      const prev = inst.hooks[idx];
      const changed = !prev || !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        inst.hooks[idx] = { deps };
        pendingEffects.push({ inst, fn });
      }
    },
    Fragment: Symbol("Fragment"),
  };
  return { React, instances, pendingEffects, nodes: [], get current() { return current; }, set current(v) { current = v; } };
}

function renderTree(node, rt, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((c) => renderTree(c, rt, depth + 1)).join("");
  if (typeof node !== "object") return "";
  if (node.__vnode) {
    const { type, props, children } = node;
    if (typeof type === "function") {
      const name = type.name || "Anonymous";
      let inst = rt.instances.find((i) => i.type === type);
      if (!inst) {
        inst = { type, name, hooks: {}, hookIndex: 0, dirty: false };
        rt.instances.push(inst);
      }
      const prev = rt.current;
      rt.current = inst;
      inst.hookIndex = 0;
      let out;
      try {
        out = type({ ...props, children: children.length === 1 ? children[0] : children });
      } finally {
        rt.current = prev;
      }
      return renderTree(out, rt, depth + 1);
    }
    rt.nodes.push(node);
    return children.map((c) => renderTree(c, rt, depth + 1)).join("");
  }
  return "";
}

/** Collect every visible string (text nodes + aria-label) inside one rendered subtree. */
function collectVisibleText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectVisibleText(child, out);
    return out;
  }
  if (typeof node === "object" && node.__vnode) {
    const ariaLabel = node.props && node.props["aria-label"];
    if (typeof ariaLabel === "string") out.push(ariaLabel);
    for (const child of node.children) collectVisibleText(child, out);
  }
  return out;
}

/** Text visible inside the quota card only (so assertions never match the model list). */
function quotaCardText(rt) {
  const card = rt.nodes.find((node) => node.props && node.props.className === "dsha-quota-section");
  assert.ok(card, "the quota card must render");
  return collectVisibleText(card).join(" \u0000 ");
}

/** The `.dsha-group-title` texts, in render order. */
function collectGroupTitles(rt) {
  return rt.nodes
    .filter((node) => node.props.className === "dsha-group-title")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""));
}

/** Load client.js, apply() it, and return a mount() helper that runs effects + re-renders. */
function loadClient({ statusPayload, quotaPayload, requests, requestHandler, locale = "zh" }) {
  const source = loadGeminiSource();
  const rt = createReactRuntime();
  const { document } = makeDomStub();

  const fetchStub = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    requests.push(`${method} ${url}`);
    const custom = requestHandler?.(url, options);
    if (custom) return custom;
    const isStatus = String(url).endsWith("/status");
    const isQuota = String(url).endsWith("/quota");
    let payload;
    if (isStatus) payload = statusPayload;
    else if (isQuota) payload = quotaPayload;
    else return { ok: false, status: 404, json: async () => ({ ok: false, error: "not-stubbed" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, value: payload }) };
  };

  let captured = null;
  const windowStub = {
    __ModuleLoader__: { load(mod) { if (mod && mod.id === "dsh-gemini-pool-next") captured = mod; } },
    document,
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    MutationObserver: class { observe() {} disconnect() {} },
    location: { href: "http://localhost/", pathname: "/" },
    fetch: fetchStub,
  };

  const requireShim = (id) => {
    if (id === "react") return rt.React;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  };

  const runner = new Function("window", "document", "MutationObserver", "require", "fetch", "globalThis", source);
  runner(windowStub, document, windowStub.MutationObserver, requireShim, fetchStub, globalThis);

  const mod = captured.factory(requireShim);
  let sectionRender = null;
  mod.apply({
    slots: {
      inject: (n, fn) => fn(),
      register: (meta, render) => { sectionRender = render; return () => {}; },
    },
    locale: { register() {}, subscribe: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: locale }) },
    effect(fn) { fn(); },
    on() {},
  });
  assert.ok(sectionRender, "settings.section render must be registered");

  /** Mount: render, flush effects (awaiting async ones), re-render until stable. */
  async function mount() {
    let text = "";
    for (let pass = 0; pass < 8; pass++) {
      rt.pendingEffects.length = 0;
      rt.nodes.length = 0;
      text = renderTree(sectionRender({}), rt);
      const effects = rt.pendingEffects.splice(0);
      for (const { fn } of effects) {
        const cleanup = fn();
        if (cleanup && typeof cleanup.then === "function") await cleanup;
      }
      // Let async state updates (fetch -> setState) settle.
      await new Promise((r) => setTimeout(r, 0));
      if (effects.length === 0 && !rt.instances.some((i) => i.dirty)) break;
      rt.instances.forEach((i) => { i.dirty = false; });
    }
    return text;
  }

  return { mount, requests, rt };
}

test("populated panel renders the account row from real data", async () => {
  const requests = [];
  const { mount } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests });
  const text = await mount();

  const account = STATUS_FIXTURE.accounts[0];
  assert.ok(account, "fixture must contain at least one account");
  assert.match(text, new RegExp(account.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "account email must render");
  assert.match(text, /Google AI Pro/, "plan label must render");
});

test("opening the panel triggers an immediate quota refresh", async () => {
  // Requirement: 打开设置面板额度就应该直接刷新 (no manual click needed).
  const requests = [];
  const { mount } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests });
  await mount();

  assert.ok(
    requests.some((r) => r.includes("/status")),
    `expected a /status fetch on mount, saw: ${requests.join(", ")}`,
  );
  assert.ok(
    requests.some((r) => r.includes("/quota")),
    `expected an immediate /quota fetch on mount, saw: ${requests.join(", ")}`,
  );
});

test("quota rows render from real quota groups", async () => {
  const requests = [];
  const { mount } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests });
  const text = await mount();

  const quota = STATUS_FIXTURE.accounts[0].quota;
  assert.ok(quota, "fixture account must carry quota data");
  const groupTitles = Object.keys(quota.groups || quota);
  assert.ok(groupTitles.length > 0, "fixture quota must have at least one group");
  // At least one bucket label or percentage must be visible.
  assert.ok(/\d+%/.test(text) || /Claude|Gemini|GPT/i.test(text), "quota content must render");
});

test("Gemini 4 quota groups render the localized label instead of the backend codename", async () => {
  // 用户要求：额度显示里的 “Gemini 4 Argon” 改为 “Gemini 4 模型”。该分组由后端
  // displayName 命名，必须在标题、进度条行标签与 aria-label 三处都换成本地化
  // 名称，额度卡片里不能再残留后端代号。
  const { mount, rt } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests: [] });
  const text = await mount();

  const quota = STATUS_FIXTURE.accounts[0].quota;
  const argonGroup = (quota.groups || []).find((group) => group.displayName === "Gemini 4 Argon");
  assert.ok(argonGroup, "fixture must carry the live Gemini 4 Argon group shape");

  const titles = collectGroupTitles(rt);

  // (a) Gemini 4 系列具体模型分组：标题折成本地化 “Gemini 4 模型”，
  // 行标签 = 本地化模型名 · 窗口文案。
  assert.ok(titles.includes("Gemini 4 模型"), `group titles: ${JSON.stringify(titles)}`);
  assert.ok(!titles.includes("Gemini 4 Argon"), "backend codename must not stay as a group heading");
  assert.match(text, /Gemini 4 模型 · 每周额度剩余/, "the Gemini 4 bar label must carry the localized model name");
  const argonBar = rt.nodes.find(
    (node) => node.props.role === "progressbar"
      && String(node.props["aria-label"] || "").includes("Gemini 4 模型"),
  );
  assert.ok(argonBar, "the Gemini 4 progressbar must use the localized name in aria-label");
  assert.match(argonBar.props["aria-label"], /每周额度剩余/);
  assert.doesNotMatch(String(argonBar.props["aria-label"]), /Gemini 4 Argon/);

  // (b) 整个额度卡片（标题 + 行标签 + aria-label）不再出现后端代号。
  const cardText = quotaCardText(rt);
  assert.match(cardText, /Gemini 4 模型/);
  assert.doesNotMatch(cardText, /Gemini 4 Argon/, "no visible Gemini 4 Argon string may remain in the quota card");

  // (c) 平台级分组仍走本地化通用名，各只有一份；具体模型分组不再与 “Gemini 模型”
  // 同名，也不会以旧代号出现。
  assert.equal(titles.filter((title) => title === "Gemini 模型").length, 1);
  assert.equal(titles.filter((title) => title === "Claude 与 GPT 模型").length, 1);
  assert.equal(titles.filter((title) => /argon/i.test(title)).length, 0);

  // (d) 百分比照常渲染：fixture 里 Gemini 4 剩余 0。
  assert.equal(argonBar.props["aria-valuenow"], 0);
  assert.match(argonBar.props["aria-label"], /: 0%/);
  assert.match(text, /(?:^|[^\d])0%/);
});

test("future model-specific groups stay verbatim and keep Claude/GPT cyan styling", async () => {
  // 白名单只折叠平台级通用标题：将来后端若按具体模型拆组（如 “Claude Opus 5.5”），
  // 即使标题里含 “claude” 也必须原样展示，而不是被吞成 “Claude 与 GPT 模型”。
  const fixture = structuredClone(STATUS_FIXTURE);
  const quota = fixture.accounts[0].quota;
  quota.groups = [
    {
      displayName: "Claude Opus 5.5",
      buckets: [{ displayName: "Weekly Limit Remaining", remainingFraction: 0.5 }],
    },
  ];
  const { mount, rt } = loadClient({ statusPayload: fixture, quotaPayload: fixture, requests: [] });
  const text = await mount();

  const groupTitles = rt.nodes
    .filter((node) => node.props.className === "dsha-group-title")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""));
  assert.deepEqual(groupTitles, ["Claude Opus 5.5"]);
  assert.match(text, /Claude Opus 5\.5 · 每周额度剩余/);
  // Claude/GPT 的青色样式逻辑仍然生效（具体模型分组也沿用该规则）。
  assert.equal(rt.nodes.filter((node) => node.props.className === "dsha-percent-cyan").length, 1);
  assert.equal(rt.nodes.filter((node) => node.props.className === "dsha-fill-cyan").length, 1);
});

test("future Gemini 4 family groups also render the localized label", async () => {
  // 后端将来若换成别的代号（如 “Gemini 4 Carbon”），也必须继续折成
  // “Gemini 4 模型”，而不是只对 “Gemini 4 Argon” 特判。
  const fixture = structuredClone(STATUS_FIXTURE);
  const quota = fixture.accounts[0].quota;
  quota.groups = [
    {
      displayName: "Gemini 4 Carbon",
      buckets: [{ displayName: "Gemini 4 Carbon Weekly Limit", remainingFraction: 0.25 }],
    },
    {
      // 窗口文案没被每周/5 小时规则识别、原样回退时，同样不能漏出后端代号。
      displayName: "Gemini 4 Carbon",
      buckets: [{ displayName: "Gemini 4 Carbon", remainingFraction: 0.5 }],
    },
  ];
  const { mount, rt } = loadClient({ statusPayload: fixture, quotaPayload: fixture, requests: [] });
  const text = await mount();

  assert.deepEqual(collectGroupTitles(rt), ["Gemini 4 模型", "Gemini 4 模型"]);
  assert.match(text, /Gemini 4 模型 · 每周额度剩余/);
  assert.match(text, /Gemini 4 模型 · 额度限制/);
  assert.doesNotMatch(quotaCardText(rt), /Gemini 4 Carbon/);
});

test("English locale renders the localized Gemini 4 Models label", async () => {
  // en 字典同样要覆盖：标题 “Gemini 4 Models”，行标签带 “Weekly Limit Remaining”，
  // 且额度卡片里不能残留后端代号。
  const { mount, rt } = loadClient({
    statusPayload: STATUS_FIXTURE,
    quotaPayload: STATUS_FIXTURE,
    requests: [],
    locale: "en",
  });
  const text = await mount();

  const titles = collectGroupTitles(rt);
  assert.ok(titles.includes("Gemini 4 Models"), `group titles: ${JSON.stringify(titles)}`);
  assert.equal(titles.filter((title) => title === "Gemini 4 Models").length, 1);
  assert.match(text, /Gemini 4 Models · Weekly Limit Remaining/);

  const argonBar = rt.nodes.find(
    (node) => node.props.role === "progressbar"
      && String(node.props["aria-label"] || "").includes("Gemini 4 Models"),
  );
  assert.ok(argonBar, "the en progressbar must use the localized name in aria-label");
  assert.doesNotMatch(String(argonBar.props["aria-label"]), /Gemini 4 Argon/);

  const cardText = quotaCardText(rt);
  assert.match(cardText, /Gemini 4 Models/);
  assert.doesNotMatch(cardText, /Gemini 4 Argon/, "no visible Gemini 4 Argon string may remain in the en quota card");

  // en 通用分组照旧各只有一份。
  assert.equal(titles.filter((title) => title === "Gemini Models").length, 1);
  assert.equal(titles.filter((title) => title === "Claude and GPT models").length, 1);
});

test("model list renders and marks enabled models", async () => {
  const requests = [];
  const { mount } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests });
  const text = await mount();

  const options = STATUS_FIXTURE.models.options;
  assert.ok(options.length > 0, "fixture must list models");
  assert.match(text, /gemini-3\.8-flash/, "model ids must render in the model list");
});

test("an unavailable model shows the backend's own reason in the badge tooltip", async () => {
  // 「Gemini 4 Carbon」是 Ultra 专属：Pro 账号的实时目录只通告 disabled 占位实体，
  // 目录因此把它标为不可用。卡片仍要显示该模型（用户能知道后端有它），
  // tooltip 解释为什么本账号用不了；没有后端原因时退回通用文案。
  const fixture = structuredClone(STATUS_FIXTURE);
  fixture.models.options = [
    {
      id: "gemini-4-carbon",
      name: "Gemini 4 Carbon",
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high"],
      enabled: false,
      available: false,
      unavailableReason: "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
    },
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high"],
      enabled: false,
      available: false,
    },
  ];
  const { mount, rt } = loadClient({ statusPayload: fixture, quotaPayload: fixture, requests: [] });
  await mount();

  const titles = rt.nodes
    .filter((node) => node.props.className === "dsha-badge-unavailable")
    .map((node) => String(node.props.title))
    .sort();
  assert.deepEqual(titles, [
    "Gemini 4 Carbon is currently available to Ultra plan subscribers.",
    "gemini-4-argon not available on this account",
  ], "the backend tagDescription becomes the tooltip; a model without one keeps the generic tooltip");
});

test("image generation choices and badges exclude models that only read images", async () => {
  const fixture = structuredClone(STATUS_FIXTURE);
  fixture.models.options = [
    { id: "gemini-3.8-flash", name: "Gemini Flash", inputModalities: ["text", "image"] },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet", inputModalities: ["text", "image"] },
    { id: "gemini-3.1-flash-image", name: "Flash Image", inputModalities: ["text", "image"] },
  ];
  const { mount, rt } = loadClient({ statusPayload: fixture, quotaPayload: fixture, requests: [] });
  await mount();
  const select = rt.nodes.find((node) => node.props.id === "dsha-cfg-image-model");
  assert.deepEqual(select.children.map((node) => node.props.value), ["gemini-3.1-flash-image"]);
  assert.equal(rt.nodes.filter((node) => node.props.className === "dsha-badge-image").length, 1);
  const vision = rt.nodes.find((node) => node.props.id === "dsha-cfg-vision-model");
  assert.ok(vision.children.some((node) => node.props.value === "gemini-3.8-flash"));
});

test("failed cooldown saves show the error without a success message", async () => {
  const { mount, rt } = loadClient({ statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests: [] });
  await mount();
  rt.nodes.find((node) => node.props.className === "dsha-collapse-toggle").props.onClick();
  await mount();
  await rt.nodes.find((node) => node.type === "button" && node.children.includes("保存冷却设置")).props.onClick();
  const text = await mount();
  assert.match(text, /not-stubbed/);
  assert.doesNotMatch(text, /设置已保存/);
});

test("successful cooldown saves show a confirmation", async () => {
  const requests = [];
  const { mount, rt } = loadClient({
    statusPayload: STATUS_FIXTURE, quotaPayload: STATUS_FIXTURE, requests,
    requestHandler(url) {
      if (!String(url).endsWith("/config")) return;
      return { ok: true, status: 200, json: async () => ({ ok: true, value: STATUS_FIXTURE }) };
    },
  });
  await mount();
  rt.nodes.find((node) => node.props.className === "dsha-collapse-toggle").props.onClick();
  await mount();
  await rt.nodes.find((node) => node.type === "button" && node.children.includes("保存冷却设置")).props.onClick();
  const text = await mount();
  assert.ok(requests.includes("POST /antigravity/api/config"));
  assert.match(text, /设置已保存/);
});

test("no real email leaks from the committed fixture", () => {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const leaked = raw.match(/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/g);
  assert.equal(leaked, null, `fixture contains a non-example email: ${leaked && leaked.join(", ")}`);
});
