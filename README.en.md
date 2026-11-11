<div align="center">

# dsh-gemini-pool-next

**The way to use Gemini in DSH — turn your Google AI Pro subscription into a coding model pool**

**English** · [简体中文](./README.md)

<a href="https://github.com/Q2297045667/dsh-gemini-pool-next/releases"><img src="https://img.shields.io/github/v/release/Q2297045667/dsh-gemini-pool-next?color=369eff&labelColor=black&logo=github&style=flat-square" alt="release"></a>
<a href="https://github.com/Q2297045667/dsh-gemini-pool-next/stargazers"><img src="https://img.shields.io/github/stars/Q2297045667/dsh-gemini-pool-next?color=ffcb47&labelColor=black&style=flat-square" alt="stars"></a>
<a href="https://github.com/Q2297045667/dsh-gemini-pool-next/issues"><img src="https://img.shields.io/github/issues/Q2297045667/dsh-gemini-pool-next?color=ff80eb&labelColor=black&style=flat-square" alt="issues"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square" alt="license"></a>
<a href="https://github.com/Q2297045667/dsh-gemini-pool-next/commits/master"><img src="https://img.shields.io/github/last-commit/Q2297045667/dsh-gemini-pool-next?color=c4f042&labelColor=black&style=flat-square" alt="last commit"></a>
<a href="https://github.com/Q2297045667/dsh-gemini-pool-next/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/Q2297045667/dsh-gemini-pool-next/check.yml?color=7ee787&labelColor=black&label=check&style=flat-square" alt="CI"></a>

[Issues](https://github.com/Q2297045667/dsh-gemini-pool-next/issues) ·
[Discussions](https://github.com/Q2297045667/dsh-gemini-pool-next/discussions) ·
[Changelog](./CHANGELOG.md) ·
[Security](./SECURITY.md) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ·
[Upstream](https://github.com/LiZhenNet/dsh-antigravity)

</div>

---

## ✨ What is this

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) cannot reach Gemini on its own. This plugin bridges the gap: through the Google Antigravity / Cloud Code Assist channel, it connects your existing **Google AI Pro subscription** to DSH. No extra API key, no separate bill.

Gemini's strengths line up with coding work: **multimodal** input that reads images, **frontend / UI code generation**, and **image generation** for interface assets. This plugin puts all three inside DSH, billed against your subscription quota.

Have more than one Google account? Add them all to a **pool**: quotas balance across accounts, 429s fail over to the next account, and failing accounts cool down and recover by themselves. Settings shows one card per account with live weekly and 5-hour quota bars.

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool-next settings page" width="78%">
</p>

## 🆚 Why you need it

Installing this plugin changes what your Google AI Pro subscription can do:

| | Without: web-only subscription | With: subscription inside DSH |
|---|:---:|:---:|
| Gemini multimodal (vision) | ❌ unavailable while coding | ✅ drop images into the chat |
| Frontend / UI codegen | ❌ no project context in web | ✅ reads your actual codebase |
| Image gen for UI assets | ⚠️ manual copy-paste | ✅ `antigravity_image_generate` auto-saves |
| Multi-account quota | — | ✅ pool scheduling, seamless 429 failover |
| Quota visibility | ❌ black box | ✅ live per-account bars |
| Unhealthy accounts | ❌ keep hitting dead ones | ✅ auto-disable + probe + revive |

When the main model itself has no vision (text-only), pasted images are automatically described in text by a Gemini model from the pool and fed back to the main model. On by default — see "👁 Vision bypass for text-only main models".

> Read "⚠️ Account Ban Risk" below before installing.

## ⚠️ Account Ban Risk — Read Before Installing

This is an unofficial third-party tool. It reaches Google endpoints by reusing the Antigravity client identity. **Google has officially confirmed that using third-party tools to access Antigravity resources violates the Terms of Service, and has carried out mass bans** (see the [official gemini-cli announcement](https://github.com/google-gemini/gemini-cli/discussions/20632), Feb 2026 — paid subscribers were affected too).

**Enforcement mechanism** (as published by Google):

- First violation → email notice + recertification form → automatic reinstatement in 1–2 days
- **Second violation → permanent ban**
- Scope: most reports involve the Antigravity / Gemini channel being blocked, and paid quota is forfeited with it; **the community has asked Google twice whether a ban also hits the whole Google account (Gmail / Drive), and Google has never answered directly** — assume the worst
- Enforcement is sampling-based: many third-party users run for months untouched, but **nobody can promise you are not next**

**Three ways to reduce risk**:

1. **Use a throwaway account**: register a separate Google account, never the main one holding your real assets
2. **Keep usage moderate**: the built-in exponential backoff and cooldown help, but do not deliberately push quota limits
3. **Assume the channel can break at any time**: the endpoints belong to Google and policy may tighten

Using this plugin means you understand and accept these risks. This project is not affiliated with Google.

## 💰 How is this different from API relays

You can also pay a relay for Gemini API access by the token. That is a different trade:

| | API relay / reseller | dsh-gemini-pool-next |
|---|:---:|:---:|
| **Cost** | pay-per-token with a markup | flat subscription, marginal cost ≈ 0 |
| **Model authenticity** | ⚠️ may be silently downgraded | ✅ direct to official endpoints |
| **Privacy** | ⚠️ your code/chats/images pass through the operator's server | ✅ in-process straight to Google, no middleman |
| **Quota visibility** | a single opaque "site balance" | live weekly / 5h bars per account |
| **Exit risk** | relays vanish or degrade, balance gone overnight | no third party touches your money |

The relay has one real advantage: **bans hit the operator's accounts, yours stays clean**. The line is simple — account safety first, light usage, or just trying things out: use a relay. Already subscribed, privacy-conscious, want the real models long-term: use this.

## 🚀 Quick Start

**Requirements**: DSH `>=0.2.2-rc.1 <0.3.0` (verified against 0.2.2-rc.1, matching the revamped Antigravity model catalog). Run `dsh --version` to check yours.

**1. Install the plugin**

```bash
dsh plugin --profile web add github:Q2297045667/dsh-gemini-pool-next
```

When migrating, remove the previous plugin and its Cordis configuration entry before installing Next to avoid loading both. Existing account storage paths are retained; keep your credential files.

**2. Sign in with Google**

Open DSH Settings → **Antigravity** → click "＋ Add Google Account" and authorize. Add as many as you like.

**3. Done**

Tick the models you want in the model selector and start chatting. Quota refresh and scheduling are automatic.

Your model can't see images? Paste anyway — a pool Gemini describes them to it automatically (on by default, see "👁 Vision bypass for text-only main models").

<details>
<summary><kbd>Offline / manual install</kbd></summary>

```bash
npm run pack:dist
# the package name carries the current version from package.json; install the file actually generated under dist/
dsh plugin --profile web add ./dist/dsh-gemini-pool-next-*.tgz
```

If your DSH does not support `dsh plugin add`, copy the package into `$DSH_HOME/profiles/web/node_modules/` and add to `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-gemini-pool-next
      name: dsh-gemini-pool-next
```

</details>

## 🧱 Network environment (behind a proxy)

The plugin contains no proxy code of its own: every Google request is an in-process `fetch` that uses the host's global HTTP path. The host reads `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` **only from the harness home's `.env`, and only once at startup** (the same names in any other `.env` are refused), then installs the proxy for the plugin from there.

> ⚠️ This is the most common cause of "the browser authorized successfully, but DSH never gets the account / refreshing data fails": the proxy file was placed in the wrong home.

| You run | Put the proxy in |
| --- | --- |
| CLI (`dsh ...`) | `~/.dsh/.env` |
| **DSH Desktop** | Windows: `%APPDATA%\dsh-desktop\harness\.env`<br>macOS: `~/Library/Application Support/dsh-desktop/harness/.env` |

**DSH Desktop has its own harness home — not `~/.dsh`**; an `~/.dsh/.env` alone has no effect there. (For the same reason, the desktop account file lives at `<that folder>\storages\antigravity-pool-accounts.json`.)

Three lines are enough — change the port to match your proxy:

```bash
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
```

- **Fully quit and restart DSH afterwards** — the proxy is read once at startup; reloading the page does nothing.
- Loopback (the settings GUI and the OAuth callback's local port) is bypassed by the host automatically; `NO_PROXY` is unnecessary.
- Self-check: if login or quota refresh fails with `UND_ERR_CONNECT_TIMEOUT` or `fetch failed`, this path is almost certainly not proxied. Request `https://oauth2.googleapis.com/token` both directly and through the proxy to confirm (a proxied reach returns `400`, since the request body is missing).
- Do not add proxy code to the plugin: `import('undici')` is unavailable in the host's Node, and an in-process `fetch` follows the host's proxy automatically.

## 💧 Account Pool & Scheduling

Three strategies, one click to switch in Settings:

- **Smart balancing (recommended)**: picks the account with the healthiest remaining quota
- **Primary & backup**: fixed primary account, automatic switch when its quota runs out
- **Manual**: lock to one account for debugging or dedicated runs

Day-to-day operations run as chat commands:

| Command | What it does |
|---|---|
| `/antigravity-login` | sign in with a Google account |
| `/antigravity-quota` | show per-account quota |
| `/antigravity-doctor` | run self-diagnostics (vision troubleshooting below) |
| `/antigravity-logout` | sign out and remove stored credentials |

Credentials live at `$DSH_HOME/storages/antigravity-pool-accounts.json` (on DSH Desktop: `%APPDATA%\dsh-desktop\harness\storages\...`), including access and refresh tokens. Keep that file private. Legacy single-account credentials migrate automatically on upgrade, so you do not have to sign in again.

## 🧊 Cooldown & Self-healing

An account that hits 429 enters exponential-backoff cooldown. Repeated failures disable it and hand it to a background probe that revives it once quota recovers. No manual steps.

| Parameter | Default | Description |
|---|---|---|
| `cooldownMs` | 1 min | initial cooldown, doubling on each failure |
| `cooldownMaxMs` | 1 hr | cooldown cap |
| `disableThreshold` | 5 | consecutive failures before disable |
| `probeIntervalMs` | 5 min | background probe interval, auto-revive on success |

Disabled accounts carry a red tag in Settings and a one-click "Re-enable" button. All of these parameters are adjustable in the "Cooldown & Recovery" section.

## 👁 Vision bypass for text-only main models

When the main model cannot see images (e.g. a text-only model), a Gemini model from the pool looks at them and answers in text, through two paths:

- **Automatic description (main path, seamless)**: after a paste, the plugin swaps the image in the outgoing request for a text description generated by a pool Gemini — the main model simply reads it, no action needed. Each image is described once per process (in-process cache), so images repeated across session history do not burn quota twice; descriptions carry the original image hash, and a failed description falls back to the host's placeholder path without blocking the chat.
- **The `antigravity_read_image` tool (fallback)**: for a closer look at a specific image, the main model can call it explicitly (the argument is the hash prefix from the description; local paths inside the workspace, data: URLs, and public http(s) image URLs are also accepted) for a fresh description.

- **Data flow**: images are processed through Google accounts in the pool, sharing quota with chat and image generation.
- **On by default**. To turn it off (any one of these): set the environment variable `ANTIGRAVITY_VISION_ENABLED=false`; or toggle it off in the Settings · Vision Bypass card; or set `visionEnabled: false` in accounts.json via `/antigravity/api/config`. The switch governs both image admission and automatic description; with it off, pasting behaves exactly as the host does out of the box. `visionModel` picks the describing model — leave it empty for automatic selection, or pick one in the Settings card.
- **Known dependency**: automatic description relies on the host's `agent/pre-step` event and image admission on `resolveModelInfo`. If pasting images misbehaves after a major host upgrade, revisit this section (verified against DSH 0.2.2-rc.1).
- **Troubleshooting**: if the model still receives a placeholder after pasting an image, run `/antigravity-doctor` and check the `visionBridge` / `visionShim` lines (`registered` + `installed` is the healthy state). Server log lines prefixed `[Antigravity Pool Vision]` record every bridge decision (request entry, model gate, rewrite result or passthrough reason); zero prefixed lines after a paste means the event never reached the bridge.

## 🤖 Models

Tick a model in Settings to enable it. Enabled models float to the top, each showing the highest available quota in the pool.

<p align="center">
  <img src="./assets/images/screenshots/settings-2.png" alt="Dispatch strategy and model selector" width="45%">
  <img src="./assets/images/screenshots/settings-3.png" alt="Image generation defaults" width="45%">
</p>

| Model | Thinking levels | Quota pool |
|---|---|---|
| **Gemini 4 Argon** (Pro flagship) | Low / Medium / High | Gemini 4 Argon (separate Pro quota; folded into the main Gemini pool on Ultra) |
| **Gemini 4 Carbon** (Ultra only) | Low / Medium / High | Gemini 4 Argon bucket; on Pro accounts the backend only advertises a disabled placeholder, so the catalog marks it unavailable |
| Gemini 3.8 Flash | Minimal / Low / Medium / High | Gemini |
| Gemini 3.5 Flash Lite · Gemini 3.1 Flash Lite · Gemini 2.5 Flash Lite | — | Gemini |
| Gemini 3.1 Flash Image (image gen) | — | Gemini |
| Gemini 3 Flash · Gemini 2.5 Pro / Flash | — | Gemini |
| **Claude Opus 5.5** · **Claude Sonnet 5.5** (Pro) | Low / Medium / High | Claude & GPT |
| Claude Opus 4.6 · Claude Sonnet 4.6 ⚠️ (removed by Antigravity on 2026-11-18) · GPT-OSS 120B | — | Claude & GPT |

Models in the same pool share the weekly and 5-hour quotas. Quota drains in proportion to token cost, so heavier models run out faster.

The quota bars in Settings follow the backend's own quota groups: platform-level groups (Gemini, Claude & GPT) keep their localized umbrella label, while a group the backend splits out per model is shown under a localized model name — on Pro plans the Gemini 4 bucket (backend displayName `Gemini 4 Argon`, a single weekly bucket) renders as **Gemini 4 Models** with the bar labelled "Gemini 4 Models · Weekly Limit Remaining". It stays unambiguous next to the main Gemini pool's weekly bar, and the backend codename is never shown to the user.

**The backend gates the catalog on the client fingerprint (User-Agent).** Measured on one Pro account: the outdated `antigravity/1.15.8 linux/amd64` fingerprint returns 16 entities with **no Gemini 4 Argon and no per-level Gemini 3.8**; the current `antigravity/hub/2.24.0 (aidev_client; os_type=…; arch=…; cl=1000335682)` fingerprint returns 22 entities including `gemini-4-argon-low/medium/high` and `gemini-3.8-flash-low/medium/high`. The plugin sends the current fingerprint by default (`ANTIGRAVITY_USER_AGENT` overrides it) and re-discovers the catalog on startup whenever an upgrade changes that fingerprint.

**The backend also lists models the current plan cannot use.** Gemini 4 Carbon is Ultra-only today: a Pro account's `fetchAvailableModels` advertises only a `gemini-4-carbon-disabled` placeholder (`disabled: true`, `tagTitle: "Unavailable"`, and a `tagDescription` saying it is available to Ultra subscribers). The plugin treats such disabled entities as non-evidence — they never become selectable models, are never auto-enabled and are never sent as runtime entities; Settings shows the model as "Unavailable" with the backend reason in the badge tooltip. Once an account advertises usable `gemini-4-carbon-low/medium/high` entities, the model turns available and routes per level (262144 output ceiling).

**Availability and thinking levels follow the backend entities the account really advertises.** After sign-in the plugin reads that account's `fetchAvailableModels` catalog and enables only the entities it serves; a model the account does not advertise shows the "unavailable on this account" badge and is not enabled. A session that still selects one of those models is served by the best available model in the pool instead of sending a request for an entity the backend never advertised — which is exactly what produced `Requested entity was not found` (404).

Thinking levels come from those same entities: Gemini 4 Argon and Claude 5.5 are one entity per level (`gemini-4-argon-low/medium/high`, `claude-*-5-5-low/medium/high`), so selecting a level selects an entity id rather than sending extra thinking options. Gemini 3.8 Flash additionally advertises a rollout-era tiered entity; it only carries `thinkingConfig.thinkingLevel` when it is the sole entity an account offers, and a rejected level steps down instead of failing the request.

## 🧭 Architecture

```mermaid
flowchart LR
  subgraph HOST["DSH host"]
    LLM["llm/stream request flow"]
    SEL["Model selector / Settings"]
  end
  subgraph PLUGIN["dsh-gemini-pool-next"]
    CORE["Plugin core<br/>commands & API routes"]
    POOL["Pool manager<br/>scheduling · cooldown · probing"]
    VB["Vision bridge<br/>image to text"]
    TOOLS["Tools<br/>read_image · image_generate"]
  end
  STORE[("Credential store<br/>antigravity-pool-accounts.json")]
  GOOGLE["Google Antigravity API"]

  SEL --> CORE
  LLM --> VB --> POOL
  CORE --> POOL
  TOOLS --> GOOGLE
  POOL --> GOOGLE
  POOL --> STORE
```

Requests enter the plugin through the host: the vision bridge rewrites image requests for text-only models, the pool manager picks an account by scheduling strategy and handles 429 cooldown and probing, and every call goes in-process straight to the official Google endpoints.

<p align="center">
  <img src="./assets/images/panel.gif" alt="Live request-flow demo (animated numbers are illustrative)" width="72%">
</p>

## 🤝 Contributing

Issues and PRs are welcome, and so are conversations in [Discussions](https://github.com/Q2297045667/dsh-gemini-pool-next/discussions). Please run the local checks before opening a PR:

```bash
npm install    # install dependencies
npm run check  # syntax checks + tests
```

## 📄 License & Credits

This project is licensed under the [MIT License](./LICENSE).

Built on [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) by [@LiZhenNet](https://github.com/LiZhenNet), with community contributions from [@Lukeknow0](https://github.com/Lukeknow0), [@miuzel](https://github.com/miuzel), [@grloper](https://github.com/grloper) and [@sereineele](https://github.com/sereineele).
