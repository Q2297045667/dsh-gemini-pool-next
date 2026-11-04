// Regression: the settings section must actually RENDER without throwing.
//
// Why this test exists: v0.5.2 shipped with `localeRev`/`setLocaleRev` referenced but
// never declared. Every static check passed (`node --check`, i18n key coverage, module
// import, live HTTP probes) and the card rendered BLANK in the browser, because a
// ReferenceError thrown inside a component's render body makes React unmount the whole
// section. Only executing the render catches this class of bug.
//
// There is no React/jsdom on this machine, so the shim below implements the single-render
// pass faithfully enough to be meaningful: createElement builds vnodes, function components
// are invoked, hooks return their initial values, and the resulting tree is walked to text.
// If the component's render body throws, this test fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(here, "..", "lib", "client.js");

// lib/client.js 曾承载两个 ModuleLoader 块（本插件 + 融合的 dsh-codearts-auth）。
// v0.7.0 起移除了 dsh-codearts-auth，文件只保留本插件的设置页；这里仍按
// 「取第一个块」的方式截取，若将来再融合其他客户端模块，测试也不会误扫。
function loadGeminiSource() {
  const full = readFileSync(CLIENT_PATH, "utf8");
  const marker = "window.__ModuleLoader__.load(";
  const first = full.indexOf(marker);
  assert.notEqual(first, -1, "lib/client.js must contain a ModuleLoader block");
  const second = full.indexOf(marker, first + marker.length);
  return second === -1 ? full : full.slice(0, second);
}

/** Minimal DOM good enough for installStyle() / patchNavIcon(). */
function makeDomStub() {
  const makeEl = (tag = "div") => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      children: [],
      attributes: {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      getAttribute(k) {
        return this.attributes[k];
      },
      removeAttribute(k) {
        delete this.attributes[k];
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      append(...c) {
        this.children.push(...c);
        return undefined;
      },
      prepend(...c) {
        this.children.unshift(...c);
        return undefined;
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        return c;
      },
      insertBefore(c) {
        this.children.unshift(c);
        return c;
      },
      replaceChild(c) {
        this.children = [c];
        return c;
      },
      remove() {},
      contains: () => false,
      closest: () => null,
      matches: () => false,
      cloneNode() {
        return makeEl(tag);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      set textContent(v) {
        this._text = v;
      },
      get textContent() {
        return this._text ?? "";
      },
      get innerHTML() {
        return this._html ?? "";
      },
      set innerHTML(v) {
        this._html = v;
      },
    };
    return el;
  };

  const head = makeEl("head");
  const body = makeEl("body");
  const documentElement = makeEl("html");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    documentElement,
    head,
    body,
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, head, body, documentElement };
}

/**
 * Minimal React: one render pass. Hooks are index-addressed per component instance and
 * return their initial values, which is what a first mount does.
 */
function createReactShim(effectQueue) {
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
      const value = typeof initial === "function" ? initial() : initial;
      return [value, () => {}];
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect(fn) {
      effectQueue.push(fn);
    },
    Fragment: Symbol("Fragment"),
  };
  return React;
}

/** Walk a rendered tree, invoking function components and collecting visible text. */
function renderToText(node, React, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (depth > 200) throw new Error("render tree too deep — likely an infinite component recursion");
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((c) => renderToText(c, React, depth + 1)).join("");
  if (typeof node !== "object") return "";

  if (node.__vnode) {
    const { type, props, children } = node;
    if (typeof type === "function") {
      // Function component (or forwardRef-style object) — invoke it for real.
      const rendered = type({ ...props, children: children.length === 1 ? children[0] : children });
      return renderToText(rendered, React, depth + 1);
    }
    if (typeof type === "object" && type !== null && typeof type.render === "function") {
      return renderToText(type.render({ ...props, children }), React, depth + 1);
    }
    return children.map((c) => renderToText(c, React, depth + 1)).join("");
  }
  return "";
}

/** Load lib/client.js, capture the registered settings.section component, return it. */
function loadSettingsSection() {
  const source = loadGeminiSource();
  const effectQueue = [];
  const React = createReactShim(effectQueue);
  const { document, documentElement } = makeDomStub();

  let captured = null;
  const windowStub = {
    __ModuleLoader__: {
      load(mod) {
        if (mod && mod.id === "dsh-gemini-pool-next") captured = mod;
      },
    },
    document,
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    location: { href: "http://localhost/", pathname: "/" },
  };

  const requireShim = (id) => {
    if (id === "react") return React;
    throw new Error(`unexpected require(${JSON.stringify(id)}) in lib/client.js`);
  };

  // Execute the module in this scope with window/document/React in place.
  const runner = new Function(
    "window",
    "document",
    "MutationObserver",
    "require",
    "globalThis",
    source,
  );
  runner(windowStub, document, windowStub.MutationObserver, requireShim, globalThis);

  assert.ok(captured, "lib/client.js must call window.__ModuleLoader__.load(...)");
  assert.equal(captured.id, "dsh-gemini-pool-next", "module id must stay dsh-gemini-pool-next");

  const mod = captured.factory(requireShim);
  assert.ok(mod && typeof mod.apply === "function", "factory must return { apply(ctx) }");

  // Replay apply() against a stub ctx and capture the settings.section render function.
  let sectionRender = null;
  let sectionMeta = null;
  const slots = {
    inject(name, fn) {
      assert.equal(name, "settings.section", "plugin must inject settings.section");
      fn();
    },
    register(meta, render) {
      sectionMeta = meta;
      sectionRender = render;
      return () => {};
    },
  };
  const ctx = {
    slots,
    locale: {
      register() {},
      subscribe: () => () => {},
      bind: () => (k) => k,
      // 必须与 lib/client.js 的读法一致：createTranslator 取的是
      // `getLocale()?.active`，不是整个返回值。此前 mock 返回字符串 "zh"，
      // `active` 取到 undefined，于是回退到 `navigator.language` —— 在提供
      // navigator 的运行时（Node >= 21）按宿主机语言走，在不提供的运行时
      // （Node 20 / CI）变英文，导致「page title must render」在 CI 上红。
      getLocale: () => ({ active: "zh" }),
    },
    effect(fn) {
      fn();
    },
    on() {},
  };

  mod.apply(ctx);
  assert.ok(sectionRender, "apply() must register a settings.section render function");
  assert.equal(sectionMeta.id, "antigravity", "settings section id must stay antigravity");
  assert.equal(typeof sectionMeta.label, "function");
  assert.equal(sectionMeta.label(), "Antigravity", "section label must stay Antigravity");

  return { sectionRender, effectQueue, React, ctx, documentElement };
}

test("settings section renders without throwing (regression: blank settings card)", () => {
  const { sectionRender, React } = loadSettingsSection();

  let text;
  assert.doesNotThrow(() => {
    text = renderToText(sectionRender({}), React);
  }, "the settings section render body must not throw — a throw here blanks the card");
  assert.ok(typeof text === "string");
});

test("rendered card contains the expected page chrome, not an empty tree", () => {
  const { sectionRender, React } = loadSettingsSection();
  const text = renderToText(sectionRender({}), React);

  assert.ok(text.trim().length > 0, "rendered output must not be empty/whitespace — that is the blank card");
  // Page header + description come straight from the zh dictionary.
  assert.match(text, /Gemini 账号池 Next/, "page title must render");
  assert.match(text, /账号调度策略/, "scheduler section must render");
});

test("every setState-style identifier used in client.js is declared by a useState hook", () => {
  // Generic guard for the exact bug class: a setter referenced but never declared.
  // This is what `localeRev`/`setLocaleRev` violated in v0.5.2.
  const source = loadGeminiSource();

  // Declared as a useState pair.
  const stateDeclared = new Set();
  for (const m of source.matchAll(/const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState\s*\(/g)) {
    stateDeclared.add(m[1]);
    stateDeclared.add(m[2]);
  }
  assert.ok(stateDeclared.size > 0, "expected to find useState declarations");

  // Declared in any other legitimate way (useCallback handlers like setPrimary, plain fns).
  const otherwiseDeclared = new Set();
  for (const m of source.matchAll(/(?:const|let|var|function)\s+(set[A-Z]\w*)\b/g)) {
    otherwiseDeclared.add(m[1]);
  }

  // Browser / Node globals that merely look like setters.
  const GLOBALS = new Set([
    "setInterval", "setTimeout", "setImmediate",
    "setAttribute", "setAttributeNS", "setProperty", "setSelectionRange",
    "setStart", "setEnd", "setRequestHeader", "setItem",
  ]);

  const called = new Set();
  for (const m of source.matchAll(/\b(set[A-Z]\w*)\s*\(/g)) called.add(m[1]);

  const undeclared = [...called].filter(
    (s) => !stateDeclared.has(s) && !otherwiseDeclared.has(s) && !GLOBALS.has(s),
  );
  assert.deepEqual(
    undeclared,
    [],
    `setter(s) called but never declared: ${undeclared.join(", ")} — an undeclared ` +
      `reference throws at render time and blanks the whole settings section`,
  );
});

test("state value identifiers referenced during render are all declared", () => {
  // `[ctx, localeRev]` was the render-time throw site in v0.5.2: `localeRev` was read
  // inside the component body but had no declaration, so the component threw on mount.
  const source = loadGeminiSource();
  const body = source.slice(source.indexOf("function GeminiSettingsPage"));
  const componentBody = body.slice(0, body.indexOf("\n    function patchNavIcon"));

  // Collect every identifier used in a hook dependency array inside this component.
  const referenced = new Set();
  for (const m of componentBody.matchAll(/,\s*\[([^\]]*)\]\s*\)/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (/^[a-z][A-Za-z0-9_]*$/.test(name)) referenced.add(name);
    }
  }
  assert.ok(referenced.size > 0, "expected to find hook dependency arrays in the component");

  const undeclared = [];
  for (const name of referenced) {
    const declared =
      new RegExp(`const\\s+${name}\\b`).test(componentBody) ||
      new RegExp(`const\\s*\\[\\s*${name}\\s*,`).test(componentBody) ||
      new RegExp(`,\\s*${name}\\s*\\]\\s*=\\s*use`).test(componentBody) ||
      new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(source) ||
      ["ctx", "props", "tr", "React"].includes(name);
    if (!declared) undeclared.push(name);
  }
  assert.deepEqual(
    undeclared,
    [],
    `identifier(s) used in hook deps but never declared: ${undeclared.join(", ")}`,
  );
});
