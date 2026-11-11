window.__ModuleLoader__.load({
  id: "dsh-gemini-pool-next",
  factory(require) {
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "dsh-gemini-pool-next-settings-style";
    const API = "/antigravity/api";
    const NS = "dsh-gemini-pool-next";
    const GEMINI_SPARK_PATH =
      "M55 10C55 34.85 75.15 55 100 55C75.15 55 55 75.15 55 100C55 75.15 34.85 55 10 55C34.85 55 55 34.85 55 10Z";

    const zh = {
      pageTitle: "Gemini 账号池 Next",
      pageDesc: "Google Gemini 多账号池与无感轮换。支持自动负载均衡、429 无感故障转移与前端生图工具绑定。",
      schedulerTitle: "账号调度策略",
      modeAuto: "智能均衡 (推荐)",
      modeAutoDesc: "每次请求自动挑选剩余额度最健康的账号，遇 429 速率限制毫秒级自动切换备用账号，前端零感知。",
      modePrimary: "主备切换",
      modePrimaryDesc: "平时固定使用主账号；仅当主账号额度见底或被限额时，才自动启用备用账号顶上。",
      modeManual: "手动指定",
      modeManualDesc: "锁定仅使用下方指定的当前账号（类似单账号模式，用于调试或单账号专跑）。",
      cooldownSectionTitle: "冷却与恢复设置",
      cooldownMsLabel: "初始冷却时长 (毫秒)",
      cooldownMaxMsLabel: "最大冷却时长 (毫秒)",
      disableThresholdLabel: "连续失败禁用阈值 (次)",
      probeIntervalMsLabel: "后台自动探活间隔 (毫秒)",
      saveCooldownConfig: "保存冷却设置",
      configSaved: "设置已保存",
      imageConfigTitle: "默认生图配置 (前端插画/素材生成)",
      imageModelLabel: "默认生图模型",
      imageOutputDirLabel: "出图保存目录",
      imageConfigDesc: "在编写前端代码时，AI 可自动调用此模型生成插图并保存在本地项目中，无需手动在模型菜单来回切换。",
      visionTitle: "视觉旁路（无视觉主模型看图）",
      visionDesc: "主模型不支持看图时，贴图自动经池内 Gemini 转述为文字回喂；模型也可调用 antigravity_read_image 工具细看某张图。",
      visionEnabledLabel: "启用贴图转述与准入",
      visionModelLabel: "代看模型（留空自动挑选）",
      visionModelAuto: "自动（留空）",
      accountsTitle: "Google 账号池",
      addAccount: "＋ 添加 Google 账号",
      refreshAllQuotas: "刷新全部额度",
      loggingIn: "正在发起授权...",
      refreshing: "刷新中...",
      primaryTag: "主账号",
      backupTag: "备用账号",
      disabledTag: "已禁用",
      setPrimary: "设为主账号",
      setManualActive: "设为当前使用",
      reEnableAccount: "重新启用",
      logout: "退出登录",
      cooldownStatus: "冷却中(429) 剩余{seconds}s",
      disabledStatus: "已禁用 (连续超限)",
      online: "在线正常",
      noAccountsDesc: "点击上方“添加 Google 账号”登录你的第一个 Google 账号。可添加多个账号共享额度。",
      resetPrefix: "重置: {time}",
      resetUnavailable: "重置: n/a",
      resetNow: "现在",
      timeDayHour: "{days}天 {hours}时",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      modelSelector: "模型选择器",
      modelSelectorDesc: "勾选后会出现在 DSH 模型列表中（所有账号共享此模型集）。",
      selectAll: "全选",
      unselectAll: "全不选",
      loadingModels: "正在加载模型列表...",
      modelSelectorNote: "勾选即自动保存。重新打开模型选择器即可生效。",
      quotaLabel: "池最高额度: {percent}%",
      loginFailed: "登录失败",
      currentTag: "当前使用",
      imageGenBadge: "🎨 生图",
      reasoningBadge: "⚡️ 思考",
      deprecatedBadge: "⚠️ 将下架",
      unavailableBadge: "账号不可用",
      quotaGroupGemini: "Gemini 模型",
      quotaGroupGemini4: "Gemini 4 模型",
      quotaGroupClaudeGpt: "Claude 与 GPT 模型",
      quotaGroupDefault: "额度分组",
      limitWeekly: "每周额度剩余",
      limitFiveHour: "5 小时额度剩余",
      limitDefault: "额度限制",
    };

    const en = {
      pageTitle: "Gemini Pool Next",
      pageDesc: "Google Gemini Multi-Account Pool & Auto-Failover. Automatically balances quota, fails over on 429 errors, and provides seamless frontend image generation.",
      schedulerTitle: "Dispatch Strategy",
      modeAuto: "Smart Balance (Recommended)",
      modeAutoDesc: "Automatically picks the healthiest account with highest quota. Fails over to backup accounts instantly on 429 rate limits.",
      modePrimary: "Primary & Backup",
      modePrimaryDesc: "Always uses the primary account, seamlessly switching to backup accounts only when primary is exhausted.",
      modeManual: "Manual",
      modeManualDesc: "Lock to the specified account below.",
      cooldownSectionTitle: "Cooldown & Recovery",
      cooldownMsLabel: "Initial Cooldown (ms)",
      cooldownMaxMsLabel: "Max Cooldown (ms)",
      disableThresholdLabel: "Disable Threshold (failures)",
      probeIntervalMsLabel: "Background Probe Interval (ms)",
      saveCooldownConfig: "Save Cooldown Config",
      configSaved: "Config saved",
      imageConfigTitle: "Image Generation Defaults (Frontend Assets)",
      imageModelLabel: "Default Image Model",
      imageOutputDirLabel: "Save Directory",
      imageConfigDesc: "Allows the AI to generate website illustrations/assets automatically into your project without switching models manually.",
      visionTitle: "Vision Bypass (image reading for text-only models)",
      visionDesc: "When the main model cannot see images, pastes are described in text by a pool Gemini automatically; the model can also call antigravity_read_image for a closer look.",
      visionEnabledLabel: "Enable image description & admission",
      visionModelLabel: "Describing model (empty = auto)",
      visionModelAuto: "Automatic (empty)",
      accountsTitle: "Google Accounts Pool",
      addAccount: "＋ Add Google Account",
      refreshAllQuotas: "Refresh All Quotas",
      loggingIn: "Authorizing...",
      refreshing: "Refreshing...",
      primaryTag: "PRIMARY",
      backupTag: "BACKUP",
      disabledTag: "DISABLED",
      setPrimary: "Set as Primary",
      setManualActive: "Select for Use",
      reEnableAccount: "Re-enable",
      logout: "Sign out",
      cooldownStatus: "Cooling down (429) {seconds}s left",
      disabledStatus: "Disabled (threshold exceeded)",
      online: "Healthy",
      noAccountsDesc: "Click Add Google Account above to sign in. You can add multiple accounts to double your capacity.",
      resetPrefix: "Reset: {time}",
      resetUnavailable: "Reset: n/a",
      resetNow: "now",
      timeDayHour: "{days}d {hours}h",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      modelSelector: "Model Selector",
      modelSelectorDesc: "Checked models will appear in DSH's model list (shared across pool).",
      selectAll: "Select all",
      unselectAll: "Deselect all",
      loadingModels: "Loading model configuration...",
      modelSelectorNote: "Saved automatically.",
      quotaLabel: "Pool Max: {percent}%",
      loginFailed: "Login failed",
      currentTag: "ACTIVE",
      imageGenBadge: "🎨 Image Gen",
      reasoningBadge: "⚡️ Thinking",
      deprecatedBadge: "⚠️ EOL soon",
      unavailableBadge: "Unavailable",
      quotaGroupGemini: "Gemini Models",
      quotaGroupGemini4: "Gemini 4 Models",
      quotaGroupClaudeGpt: "Claude and GPT models",
      quotaGroupDefault: "Quota Group",
      limitWeekly: "Weekly Limit Remaining",
      limitFiveHour: "Five Hour Limit Remaining",
      limitDefault: "Limit",
    };

    function createTranslator(ctx) {
      const boundT = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : null;

      return function t(key, params) {
        if (boundT) {
          try {
            const res = boundT(key, params);
            if (res && res !== key && res !== `${NS}.${key}`) return res;
          } catch (_) {}
        }
        const active = (ctx && ctx.locale && typeof ctx.locale.getLocale === "function")
          ? ctx.locale.getLocale()?.active
          : null;
        const isZh = active ? active.startsWith("zh") : (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
        const dict = isZh ? zh : en;
        let text = dict[key] || en[key] || zh[key] || key;
        if (params && typeof params === "object") {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return text;
      };
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsha-wrap {
  --dsha-text: var(--dsw-alias-label-primary, #111827);
  --dsha-text-2: var(--dsw-alias-label-secondary, #4b5563);
  --dsha-text-3: var(--dsw-alias-label-tertiary, #8b93a1);
  --dsha-text-4: var(--dsw-alias-label-caption, #9aa3b0);
  --dsha-bg: var(--dsw-alias-bg-layer-1, #fff);
  --dsha-bg-2: var(--dsw-alias-bg-layer-2, #fafbfc);
  --dsha-hover: var(--dsw-alias-interactive-bg-hover, #f7f8fa);
  --dsha-border: var(--dsw-alias-border-l2, #e5e7eb);
  --dsha-border-2: var(--dsw-alias-border-l1, #eef1f5);
  --dsha-btn-primary-bg: var(--dsw-alias-button-primary-fill, #111827);
  --dsha-btn-primary-text: var(--dsw-alias-label-primary-inverted, #fff);
  --dsha-btn-primary-hover: var(--dsw-alias-button-primary-hover, #272d38);
  --dsha-green: var(--dsw-alias-state-success-primary, #10b981);
  --dsha-green-text: var(--dsw-alias-state-success-primary, #059669);
  --dsha-brand: var(--dsw-alias-state-business-primary, #4f5bf6);
  --dsha-check: var(--dsw-alias-brand-primary, #111827);
  --dsha-warning: var(--dsw-alias-state-warning-primary, #f59e0b);
  --dsha-warning-text: var(--dsw-alias-state-warning-primary, #d97706);
  --dsha-warning-bg: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 8%, var(--dsw-alias-bg-layer-1, #fff));
  --dsha-warning-border: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 35%, transparent);
  --dsha-error: var(--dsw-alias-state-error-primary, #991b1b);
  --dsha-error-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary, #991b1b) 8%, var(--dsw-alias-bg-layer-1, #fff));
  --dsha-error-border: color-mix(in srgb, var(--dsw-alias-state-error-primary, #991b1b) 30%, transparent);
  --dsha-cyan: #06b6d4;
  --dsha-cyan-text: #0284c7;
  --dsha-badge-pro-bg: #eef2ff;
  --dsha-badge-pro-text: #3f46d8;
  --dsha-badge-pro-border: #dfe5ff;
  --dsha-badge-think-bg: #ecfdf5;
  --dsha-badge-think-text: #047857;
  --dsha-badge-think-border: #a7f3d0;
  --dsha-badge-image-bg: #fae8ff;
  --dsha-badge-image-text: #a21caf;
  --dsha-badge-image-border: #f5d0fe;
  --dsha-badge-deprecated-bg: #fffbeb;
  --dsha-badge-deprecated-text: #b45309;
  --dsha-badge-deprecated-border: #fde68a;
  box-sizing: border-box;
  width: 100%;
  max-width: 780px;
  padding: 0 0 32px;
  color: var(--dsha-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
body[data-ds-dark-theme] .dsha-wrap {
  --dsha-cyan: #22d3ee;
  --dsha-cyan-text: #38bdf8;
  --dsha-badge-pro-bg: #1e1b4b;
  --dsha-badge-pro-text: #a5b4fc;
  --dsha-badge-pro-border: #3730a3;
  --dsha-badge-think-bg: #064e3b;
  --dsha-badge-think-text: #6ee7b7;
  --dsha-badge-think-border: #065f46;
  --dsha-badge-image-bg: #4a044e;
  --dsha-badge-image-text: #f0abfc;
  --dsha-badge-image-border: #701a75;
  --dsha-badge-deprecated-bg: #422006;
  --dsha-badge-deprecated-text: #fcd34d;
  --dsha-badge-deprecated-border: #78350f;
}
.dsha-page-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsha-brand-icon {
  color: var(--dsha-text);
  flex-shrink: 0;
}
.dsha-page-title {
  margin: 0;
  color: var(--dsha-text);
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
}
.dsha-page-desc {
  margin: 8px 0 18px;
  color: var(--dsha-text-3);
  font-size: 13px;
  line-height: 20px;
}
.dsha-error {
  margin-bottom: 16px;
  color: var(--dsha-error);
  background: var(--dsha-error-bg);
  border: 1px solid var(--dsha-error-border);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 18px;
  white-space: pre-wrap;
}
.dsha-card {
  background: var(--dsha-bg);
  border: 1px solid var(--dsha-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  box-shadow: none;
}
.dsha-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.dsha-card-title-group {
  min-width: 0;
  flex: 1 1 auto;
}
.dsha-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dsha-text);
  line-height: 22px;
}
.dsha-card-desc {
  margin: 4px 0 0;
  color: var(--dsha-text-3);
  font-size: 12px;
  line-height: 18px;
}
.dsha-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.dsha-btn {
  border: 1px solid var(--dsha-border);
  background: var(--dsha-bg);
  color: var(--dsha-text);
  border-radius: 8px;
  padding: 6px 14px;
  min-height: 32px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, opacity .15s ease, transform .08s ease;
  user-select: none;
}
.dsha-btn:hover {
  background: var(--dsha-hover);
  border-color: var(--dsha-border-2);
}
.dsha-btn:active:not(:disabled) {
  transform: scale(0.96);
}
.dsha-btn:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-btn:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.dsha-btn-primary {
  border-color: var(--dsha-btn-primary-bg);
  background: var(--dsha-btn-primary-bg);
  color: var(--dsha-btn-primary-text);
}
.dsha-btn-primary:hover {
  background: var(--dsha-btn-primary-hover);
}
.dsha-btn-primary:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-btn-add {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 12px 16px;
  min-height: 44px;
  font-size: 13px;
  font-weight: 700;
  border-radius: 8px;
  border: 1.5px dashed var(--dsha-border);
  background: var(--dsha-bg-2);
  color: var(--dsha-brand);
  cursor: pointer;
  margin-bottom: 14px;
  transition: background .15s ease, border-color .15s ease, opacity .15s ease, transform .08s ease;
  user-select: none;
}
.dsha-btn-add:hover {
  border-color: var(--dsha-brand);
  background: color-mix(in srgb, var(--dsha-brand) 6%, var(--dsha-bg));
}
.dsha-btn-add:active:not(:disabled) {
  transform: scale(0.96);
}
.dsha-btn-add:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-btn-add:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.dsha-mini-btn {
  border: 0;
  background: transparent;
  color: var(--dsha-brand);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
  padding: 4px 6px;
  min-height: 28px;
  border-radius: 4px;
  transition: opacity .15s ease, background .15s ease;
}
.dsha-mini-btn:hover {
  text-decoration: underline;
  background: color-mix(in srgb, var(--dsha-brand) 8%, transparent);
}
.dsha-mini-btn:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-mini-btn:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.dsha-empty {
  border: 1px dashed var(--dsha-border);
  border-radius: 8px;
  padding: 16px;
  color: var(--dsha-text-3);
  background: var(--dsha-bg-2);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
.dsha-account-card {
  box-sizing: border-box;
  background: var(--dsha-bg-2);
  border: 1px solid var(--dsha-border-2);
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 12px;
  transition: all .2s ease;
}
.dsha-account-card:last-child {
  margin-bottom: 0;
}
.dsha-account-card.dsha-primary {
  border-left: 3px solid var(--dsha-brand);
}
.dsha-account-card.dsha-cooldown {
  border-color: var(--dsha-warning-border);
  background: var(--dsha-warning-bg);
}
.dsha-account-card.dsha-primary.dsha-cooldown {
  border-left: 3px solid var(--dsha-brand);
}
.dsha-acc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.dsha-acc-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.dsha-acc-email {
  font-size: 14px;
  font-weight: 700;
  color: var(--dsha-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsha-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  line-height: 14px;
}
.dsha-tag-pro {
  background: var(--dsha-badge-pro-bg);
  color: var(--dsha-badge-pro-text);
  border: 1px solid var(--dsha-badge-pro-border);
}
.dsha-tag-primary {
  background: color-mix(in srgb, var(--dsha-brand) 12%, var(--dsha-bg));
  color: var(--dsha-brand);
  border: 1px solid color-mix(in srgb, var(--dsha-brand) 25%, transparent);
}
.dsha-tag-backup {
  background: var(--dsha-bg);
  color: var(--dsha-text-3);
  border: 1px solid var(--dsha-border);
  font-weight: 600;
}
.dsha-tag-disabled {
  background: var(--dsha-error-bg);
  color: var(--dsha-error);
  border: 1px solid var(--dsha-error-border);
  font-weight: 700;
}
.dsha-tag-current {
  background: color-mix(in srgb, var(--dsha-brand) 18%, var(--dsha-bg));
  color: var(--dsha-brand);
  border: 1px solid color-mix(in srgb, var(--dsha-brand) 40%, transparent);
  font-weight: 700;
}
.dsha-acc-status.dsha-status-disabled {
  color: var(--dsha-error);
}
.dsha-status-dot.dsha-dot-disabled {
  background: var(--dsha-error);
}
.dsha-collapse {
  margin-top: 12px;
  border-top: 1px solid var(--dsha-border-2);
  padding-top: 10px;
}
.dsha-collapse-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsha-brand);
  cursor: pointer;
  padding: 6px 4px;
  border-radius: 4px;
  transition: opacity .15s ease, background .15s ease;
}
.dsha-collapse-toggle:hover {
  background: color-mix(in srgb, var(--dsha-brand) 8%, transparent);
}
.dsha-collapse-toggle:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-collapse-body {
  margin-top: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.dsha-collapse-footer {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.dsha-acc-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.dsha-acc-status.dsha-status-online {
  color: var(--dsha-green-text);
}
.dsha-acc-status.dsha-status-cooldown {
  color: var(--dsha-warning-text);
}
.dsha-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.dsha-dot-online {
  background: var(--dsha-green);
}
.dsha-dot-cooldown {
  background: var(--dsha-warning);
}
.dsha-quota-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--dsha-border-2);
}
.dsha-quota-group {
  margin-bottom: 8px;
  padding: 10px 12px;
  background: var(--dsha-bg);
  border: 1px solid var(--dsha-border-2);
  border-radius: 8px;
}
.dsha-quota-group:last-child {
  margin-bottom: 0;
}
.dsha-group-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--dsha-text);
  margin-bottom: 6px;
}
.dsha-quota-item {
  display: block;
}
.dsha-quota-item-spaced {
  margin-top: 8px;
}
.dsha-rowtop {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--dsha-text-2);
  font-weight: 600;
}
.dsha-metrics {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  color: var(--dsha-text-3);
  white-space: nowrap;
}
.dsha-percent {
  font-weight: 750;
  color: var(--dsha-green-text);
}
.dsha-percent-cyan {
  font-weight: 750;
  color: var(--dsha-cyan-text);
}
.dsha-bar {
  height: 6px;
  margin-top: 5px;
  border-radius: 999px;
  background: var(--dsha-bg-2);
  overflow: hidden;
}
.dsha-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsha-green);
  min-width: 3px;
  transition: width .3s ease;
}
.dsha-fill-cyan {
  height: 100%;
  border-radius: 999px;
  background: var(--dsha-cyan);
  min-width: 3px;
  transition: width .3s ease;
}
.dsha-acc-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
  border-top: 1px solid var(--dsha-border-2);
  padding-top: 10px;
}
.dsha-radio-group {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.dsha-radio-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsha-border);
  border-radius: 8px;
  cursor: pointer;
  background: var(--dsha-bg);
  transition: background .15s ease, border-color .15s ease;
}
.dsha-radio-item:hover {
  border-color: var(--dsha-border-2);
  background: var(--dsha-hover);
}
.dsha-radio-item:focus-within {
  border-color: var(--dsha-brand);
}
.dsha-radio-item.active {
  border-color: var(--dsha-brand);
  background: color-mix(in srgb, var(--dsha-brand) 6%, var(--dsha-bg));
}
.dsha-radio-input {
  margin-top: 3px;
  accent-color: var(--dsha-brand);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.dsha-radio-input:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-radio-text {
  min-width: 0;
  flex: 1 1 auto;
}
.dsha-radio-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--dsha-text);
  line-height: 18px;
}
.dsha-radio-desc {
  font-size: 12px;
  color: var(--dsha-text-3);
  margin-top: 3px;
  line-height: 16px;
}
.dsha-model-list {
  border: 1px solid var(--dsha-border-2);
  border-radius: 8px;
  overflow: hidden;
}
.dsha-model-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--dsha-bg);
  border-top: 1px solid var(--dsha-border-2);
  cursor: pointer;
  transition: background .15s ease;
}
.dsha-model-row:hover {
  background: var(--dsha-hover);
}
.dsha-model-row:focus-within {
  background: color-mix(in srgb, var(--dsha-brand) 4%, var(--dsha-bg));
}
.dsha-model-row:first-child {
  border-top: 0;
}
.dsha-check {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  accent-color: var(--dsha-check);
  flex-shrink: 0;
  cursor: pointer;
}
.dsha-check:focus-visible {
  outline: 2px solid var(--dsha-brand);
  outline-offset: 2px;
}
.dsha-model-info {
  flex: 1 1 auto;
  min-width: 0;
}
.dsha-model-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dsha-model-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--dsha-text);
  line-height: 18px;
}
.dsha-badge-image {
  background: var(--dsha-badge-image-bg);
  color: var(--dsha-badge-image-text);
  border: 1px solid var(--dsha-badge-image-border);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  line-height: 14px;
}
.dsha-badge-deprecated {
  background: var(--dsha-badge-deprecated-bg);
  color: var(--dsha-badge-deprecated-text);
  border: 1px solid var(--dsha-badge-deprecated-border);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  line-height: 14px;
}
.dsha-badge-unavailable {
  background: var(--dsha-bg-2, #fafbfc);
  color: var(--dsha-text-4, #9aa3b0);
  border: 1px solid var(--dsha-border-2, #eef1f5);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  line-height: 14px;
}
.dsha-badge-think {
  background: var(--dsha-badge-think-bg);
  color: var(--dsha-badge-think-text);
  border: 1px solid var(--dsha-badge-think-border);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  line-height: 14px;
}
.dsha-model-sub {
  font-size: 12px;
  color: var(--dsha-text-3);
  margin-top: 3px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsha-note {
  margin-top: 10px;
  color: var(--dsha-text-3);
  font-size: 12px;
  line-height: 18px;
}
.dsha-input-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.dsha-input-group {
  flex: 1;
  min-width: 220px;
}
.dsha-input-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsha-text-2);
  margin-bottom: 6px;
}
.dsha-input {
  width: 100%;
  border: 1px solid var(--dsha-border);
  border-radius: 8px;
  padding: 8px 12px;
  min-height: 36px;
  font-size: 13px;
  box-sizing: border-box;
  background: var(--dsha-bg);
  color: var(--dsha-text);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dsha-input:focus {
  outline: none;
  border-color: var(--dsha-brand);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsha-brand) 25%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .dsha-btn,
  .dsha-btn-add,
  .dsha-account-card,
  .dsha-fill,
  .dsha-fill-cyan,
  .dsha-radio-item,
  .dsha-model-row,
  .dsha-input {
    transition: none !important;
    transform: none !important;
  }
}
`;
      document.head.append(style);
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options && options.headers ? options.headers : {}),
        },
      });
      const body = await response.json().catch(() => ({ ok: false, error: "invalid-json" }));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return body.value;
    }

    function GeminiIcon({ size = 20, className = "" }) {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 110 110",
          width: size,
          height: size,
          fill: "none",
          className,
          style: { flexShrink: 0, display: "inline-block", verticalAlign: "middle" },
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
        },
        React.createElement("path", {
          d: GEMINI_SPARK_PATH,
          fill: "currentColor",
        }),
      );
    }

    function extractModelVersion(model) {
      const name = String(model && model.name ? model.name : "");
      const id = String(model && model.id ? model.id : "");
      const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || id.match(/\b(\d+(?:\.\d+)+)\b/);
      if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || name.match(/\b(\d+(?:\.\d+)+)\b/);
      if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      return [0];
    }

    function compareVersionsDesc(v1, v2) {
      const len = Math.max(v1.length, v2.length);
      for (let i = 0; i < len; i++) {
        const num1 = v1[i] !== undefined ? v1[i] : 0;
        const num2 = v2[i] !== undefined ? v2[i] : 0;
        if (num1 !== num2) return num2 - num1;
      }
      return 0;
    }

    function getFamilyOrder(model) {
      const text = `${model && model.id ? model.id : ""} ${model && model.name ? model.name : ""}`.toLowerCase();
      if (text.includes("gemini")) return 1;
      if (text.includes("claude")) return 2;
      if (text.includes("gpt")) return 3;
      return 4;
    }

    function getVariantScore(model) {
      const text = `${model && model.name ? model.name : ""} ${model && model.id ? model.id : ""}`.toLowerCase();
      if (text.includes("ultra")) return 1;
      if (text.includes("pro") && !text.includes("lite")) return 2;
      if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
      if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
      if (text.includes("image")) return 5;
      if (text.includes("lite") && !text.includes("thinking")) return 6;
      if (text.includes("lite") && text.includes("thinking")) return 7;
      return 10;
    }

    function compareAntigravityModels(a, b) {
      const famA = getFamilyOrder(a);
      const famB = getFamilyOrder(b);
      if (famA !== famB) return famA - famB;

      const verA = extractModelVersion(a);
      const verB = extractModelVersion(b);
      const verComp = compareVersionsDesc(verA, verB);
      if (verComp !== 0) return verComp;

      const variantA = getVariantScore(a);
      const variantB = getVariantScore(b);
      if (variantA !== variantB) return variantA - variantB;

      return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
    }

    function compareAntigravityModelOptions(a, b, enabledSet) {
      const aEnabled = enabledSet ? enabledSet.has(a && a.id) : Boolean(a && a.enabled);
      const bEnabled = enabledSet ? enabledSet.has(b && b.id) : Boolean(b && b.enabled);
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      return compareAntigravityModels(a, b);
    }

    function isImageGenerationModel(model) {
      return typeof model?.id === "string" && model.id.includes("image");
    }

    function formatTimeRemaining(ms, tr) {
      if (typeof ms !== "number" || isNaN(ms) || ms <= 0) return tr("resetNow");
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      if (days > 0) return tr("timeDayHour", { days, hours: hours % 24 });
      if (hours > 0) return tr("timeHourMin", { hours, minutes: minutes % 60 });
      return tr("timeMin", { minutes: Math.max(1, minutes) });
    }

    function normalizeQuotaGroups(quota) {
      if (!quota) return [];
      if (Array.isArray(quota.groups) && quota.groups.length > 0) {
        return quota.groups.map((g) => ({
          title: g.displayName || g.name || "Models",
          buckets: g.buckets || g.limits || [],
        }));
      }
      if (Array.isArray(quota.bucketRows) && quota.bucketRows.length > 0) {
        const map = new Map();
        for (const b of quota.bucketRows) {
          const grp = b.group || "Quota";
          if (!map.has(grp)) map.set(grp, []);
          map.get(grp).push(b);
        }
        return [...map.entries()].map(([title, buckets]) => ({ title, buckets }));
      }
      return [];
    }

    // 平台级通用分组标题的白名单：Gemini Models / Claude and GPT models / 3p、
    // OpenAI、Anthropic 等。只有命中白名单的标题才折叠成本地化通用名；其余标题
    // （如将来 “Claude Opus 5.5” 这类按模型拆分的分组）一律当作具体模型名，原样
    // 显示后端 displayName —— 宁可原样展示未知标题，也不要把具体模型吞成
    // “Gemini 模型”。例外：Gemini 4 系列按用户要求统一显示成本地化模型名
    // （见下方 GEMINI_4_MODEL_GROUP_RE）。
    const GENERIC_QUOTA_GROUP_PATTERNS = [
      /^gemini\s*(models?|模型)?$/,
      /^(claude|gpt)(\s*(?:,|and|&|\+|\/)\s*(?:claude|gpt))?\s*(models?|模型)?$/,
      /^(3p|third[\s-]?party|openai|anthropic)\s*(models?|模型)?$/,
      // normalizeQuotaGroups 的兜底标题（后端没给 displayName 时）
      /^(models?|模型|quota|额度|limits?)$/,
    ];

    function isGenericQuotaGroupTitle(title) {
      const normalized = String(title || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!normalized) return false;
      // 带版本号/数字的标题一定指向具体模型（Gemini 4 Argon、Claude Opus 5.5），
      // 即使它同时含有 “gemini/claude” 这类平台词也不能折叠成通用名。
      if (/\d/.test(normalized)) return false;
      return GENERIC_QUOTA_GROUP_PATTERNS.some((re) => re.test(normalized));
    }

    // 后端按模型拆分额度的分组里，Gemini 4 系列（现在是 “Gemini 4 Argon”，
    // 将来可能是 “Gemini 4 Carbon” 等代号）在额度卡片上一律显示成本地化的
    // “Gemini 4 模型” / “Gemini 4 Models”，不再把后端内部代号直接摆给用户看。
    // 只匹配 “Gemini” 与数字 4 相邻的模型族标题，不会误伤通用分组。
    const GEMINI_4_MODEL_GROUP_RE = /\bgemini\s*4\b/i;

    function QuotaCardRows({ quota, tr }) {
      const groups = normalizeQuotaGroups(quota);
      if (!groups.length) return null;

      // 具体模型分组的显示名：Gemini 4 系列折成本地化文案，其余模型分组原样
      // 使用后端 displayName（trim 过）；平台级通用分组返回 null，交回通用分组
      // 的本地化逻辑处理。
      const mapModelGroupTitle = (title) => {
        const trimmed = String(title || "").trim();
        if (!trimmed || isGenericQuotaGroupTitle(trimmed)) return null;
        if (GEMINI_4_MODEL_GROUP_RE.test(trimmed)) return tr("quotaGroupGemini4");
        return trimmed;
      };

      const mapGroupTitle = (title) => {
        const trimmed = String(title || "").trim();
        if (!trimmed) return tr("quotaGroupDefault");
        const modelTitle = mapModelGroupTitle(trimmed);
        if (modelTitle !== null) return modelTitle;
        if (/claude|gpt|3p|openai|anthropic/i.test(trimmed)) return tr("quotaGroupClaudeGpt");
        if (/gemini/i.test(trimmed)) return tr("quotaGroupGemini");
        return trimmed || tr("quotaGroupDefault");
      };

      const mapBucketLabel = (label) => {
        if (/five|5.*hour/i.test(label)) return tr("limitFiveHour");
        if (/week/i.test(label)) return tr("limitWeekly");
        return label || tr("limitDefault");
      };

      // 具体模型分组的进度条行标签 = 模型名 + 窗口文案（Gemini 4 系列用本地化
      // 模型名，如 “Gemini 4 模型 · 每周额度剩余”）。分组标题已经是模型名，行标签
      // 再带一次是为了让进度条本身（而不只是标题）能直接认出属于哪个模型；窗口文案
      // 退居次要信息，两行因此不会完全重复。若后端 bucket displayName 本身已带模型
      // 名，则不再重复拼接一次。
      const mapModelRowLabel = (modelName, rawLabel) => {
        const windowLabel = mapBucketLabel(rawLabel);
        if (!windowLabel) return modelName;
        const lowerWindow = windowLabel.toLowerCase();
        const lowerModel = modelName.toLowerCase();
        if (lowerWindow === lowerModel || lowerWindow.startsWith(lowerModel)) return windowLabel;
        // 兜底窗口文案（未被每周/5 小时规则识别）若原样回退且仍带着 Gemini 4 后端
        // 代号，就退回通用 “额度限制”，保证旧代号不会从进度条行标签漏出。
        if (GEMINI_4_MODEL_GROUP_RE.test(windowLabel)) {
          return `${modelName} · ${tr("limitDefault")}`;
        }
        return `${modelName} · ${windowLabel}`;
      };

      return React.createElement(
        "div",
        { className: "dsha-quota-section" },
        groups.map((group, gIdx) => {
          const isClaude = /claude|gpt|3p|openai|anthropic/i.test(group.title);
          // 具体模型分组：标题与行标签都带模型名（Gemini 4 系列用本地化名称）；
          // 平台通用分组保持本地化文案，行标签只显示窗口文案。
          const modelName = mapModelGroupTitle(group.title) || "";
          return React.createElement(
            "div",
            { key: `g_${gIdx}`, className: "dsha-quota-group" },
            React.createElement("div", { className: "dsha-group-title" }, mapGroupTitle(group.title)),
            (group.buckets || []).map((bucket, bIdx) => {
              const fraction = typeof bucket.remainingFraction === "number"
                ? bucket.remainingFraction
                : (typeof bucket.remainingPercent === "number" ? bucket.remainingPercent / 100 : 1);
              const percent = typeof bucket.remainingPercent === "number"
                ? bucket.remainingPercent
                : Math.round(fraction * 1000) / 10;
              const resetMs = bucket.resetTime
                ? (Number.isFinite(Date.parse(bucket.resetTime)) ? Date.parse(bucket.resetTime) - Date.now() : undefined)
                : undefined;
              const resetLabel = bucket.resetLabel
                || (resetMs !== undefined ? formatTimeRemaining(resetMs, tr) : tr("resetUnavailable"));
              const rawLabel = bucket.displayName || bucket.label || bucket.id || "Limit";
              // 具体模型分组的行标签带上模型名（窗口文案作次要信息），aria-label
              // 复用该 label，因此同样带上模型名；通用分组维持原来的本地化行标签。
              const label = modelName
                ? mapModelRowLabel(modelName, rawLabel)
                : mapBucketLabel(rawLabel);

              return React.createElement(
                "div",
                {
                  key: `b_${bIdx}`,
                  className: bIdx > 0 ? "dsha-quota-item dsha-quota-item-spaced" : "dsha-quota-item",
                  role: "progressbar",
                  "aria-valuenow": percent,
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-label": `${label}: ${percent}% (${tr("resetPrefix", { time: resetLabel })})`,
                },
                React.createElement(
                  "div",
                  { className: "dsha-rowtop" },
                  React.createElement("span", null, label),
                  React.createElement(
                    "div",
                    { className: "dsha-metrics" },
                    React.createElement("span", null, tr("resetPrefix", { time: resetLabel })),
                    React.createElement(
                      "span",
                      { className: isClaude ? "dsha-percent-cyan" : "dsha-percent" },
                      `${percent}%`,
                    ),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dsha-bar", "aria-hidden": "true" },
                  React.createElement("div", {
                    className: isClaude ? "dsha-fill-cyan" : "dsha-fill",
                    style: { width: `${Math.max(0, Math.min(100, percent))}%` },
                  }),
                ),
              );
            }),
          );
        }),
      );
    }

    function AccountCardItem({ account, poolStatus, setPrimary, enableAccount, updateConfig, removeAccount, tr }) {
      const isPrimary = Boolean(account.isPrimary);
      const isManualSelected = poolStatus.schedulingMode === "manual" && poolStatus.activeAccountId === account.id;
      const isDisabled = account.status === "disabled";
      const [remainingMs, setRemainingMs] = useState(account.cooldownRemainingMs || 0);

      useEffect(() => {
        setRemainingMs(account.cooldownRemainingMs || 0);
      }, [account.cooldownRemainingMs]);

      useEffect(() => {
        if (remainingMs <= 0 || isDisabled) return;
        const timer = setInterval(() => {
          setRemainingMs((prev) => {
            if (prev <= 1000) {
              clearInterval(timer);
              return 0;
            }
            return prev - 1000;
          });
        }, 1000);
        return () => clearInterval(timer);
      }, [remainingMs > 0, isDisabled]);

      const isCooling = !isDisabled && remainingMs > 0;
      const cooldownSec = Math.max(1, Math.round(remainingMs / 1000));

      return React.createElement(
        "div",
        {
          key: account.id,
          className: `dsha-account-card ${isPrimary ? "dsha-primary" : ""} ${isCooling ? "dsha-cooldown" : ""} ${isDisabled ? "dsha-disabled" : ""}`,
        },
        // Sub-card Head: Email + Badges/Tags + Online/Cooldown/Disabled Status
        React.createElement(
          "div",
          { className: "dsha-acc-head" },
          React.createElement(
            "div",
            { className: "dsha-acc-left" },
            React.createElement("span", { className: "dsha-acc-email" }, account.email),
            React.createElement("span", { className: "dsha-tag dsha-tag-pro" }, account.planLabel || "PRO"),
            isDisabled
              ? React.createElement("span", { className: "dsha-tag dsha-tag-disabled" }, tr("disabledTag"))
              : (isPrimary
                  ? React.createElement("span", { className: "dsha-tag dsha-tag-primary" }, tr("primaryTag"))
                  : React.createElement("span", { className: "dsha-tag dsha-tag-backup" }, tr("backupTag"))),
            isManualSelected
              ? React.createElement("span", { className: "dsha-tag dsha-tag-current" }, tr("currentTag"))
              : null,
          ),
          React.createElement(
            "div",
            {
              className: `dsha-acc-status ${
                isDisabled
                  ? "dsha-status-disabled"
                  : (isCooling ? "dsha-status-cooldown" : "dsha-status-online")
              }`,
            },
            React.createElement("span", {
              className: `dsha-status-dot ${
                isDisabled
                  ? "dsha-dot-disabled"
                  : (isCooling ? "dsha-dot-cooldown" : "dsha-dot-online")
              }`,
            }),
            isDisabled
              ? tr("disabledStatus")
              : (isCooling
                  ? tr("cooldownStatus", { seconds: cooldownSec })
                  : tr("online")),
          ),
        ),

        // Sub-card Body: Quota grouped bars
        React.createElement(QuotaCardRows, { quota: account.quota, tr }),

        // Sub-card Footer: Right-aligned action buttons
        React.createElement(
          "div",
          { className: "dsha-acc-actions" },
          isDisabled
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-btn dsha-btn-primary",
                  onClick: () => enableAccount(account.id),
                },
                tr("reEnableAccount"),
              )
            : null,
          !isPrimary && !isDisabled
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-btn",
                  onClick: () => setPrimary(account.id),
                },
                tr("setPrimary"),
              )
            : null,
          poolStatus.schedulingMode === "manual" && !isManualSelected && !isDisabled
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-btn",
                  onClick: () => updateConfig({ activeAccountId: account.id }),
                },
                tr("setManualActive"),
              )
            : null,
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsha-btn",
              onClick: () => removeAccount(account.id),
            },
            tr("logout"),
          ),
        ),
      );
    }

    function GeminiSettingsPage({ ctx }) {
      const [localeRev, setLocaleRev] = useState(0);

      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== "function") return;
        return ctx.locale.subscribe(() => {
          setLocaleRev((r) => r + 1);
        });
      }, [ctx]);

      const tr = useMemo(() => createTranslator(ctx), [ctx, localeRev]);
      const [poolStatus, setPoolStatus] = useState({ accounts: [], schedulingMode: "auto" });
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [modelConfig, setModelConfig] = useState({ options: [], enabledModelIds: [] });
      const [cooldownExpanded, setCooldownExpanded] = useState(false);
      const [cooldownForm, setCooldownForm] = useState({
        cooldownMs: 60000,
        cooldownMaxMs: 3600000,
        disableThreshold: 5,
        probeIntervalMs: 300000,
      });
      const [cooldownMsg, setCooldownMsg] = useState("");
      const lastQuotaRefreshTimeRef = useRef(0);
      const pollRef = useRef();

      useEffect(() => {
        installStyle();
      }, []);

      const refreshStatus = useCallback(async () => {
        try {
          const value = await api("/status", { method: "GET" });
          setPoolStatus(value);
          if (value.models) setModelConfig(value.models);
          if (value) {
            setCooldownForm({
              cooldownMs: typeof value.cooldownMs === "number" ? value.cooldownMs : "",
              cooldownMaxMs: typeof value.cooldownMaxMs === "number" ? value.cooldownMaxMs : "",
              disableThreshold: typeof value.disableThreshold === "number" ? value.disableThreshold : "",
              probeIntervalMs: typeof value.probeIntervalMs === "number" ? value.probeIntervalMs : "",
            });
          }
          return value;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return null;
        } finally {
          setLoading(false);
        }
      }, []);

      const refreshAllQuotas = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await api("/quota", { method: "GET" });
          setPoolStatus(value);
          if (value.models) setModelConfig(value.models);
          lastQuotaRefreshTimeRef.current = Date.now();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        void (async () => {
          await refreshStatus();
          if (Date.now() - lastQuotaRefreshTimeRef.current > 60000) {
            await refreshAllQuotas();
          }
        })();
        return () => {
          if (pollRef.current) clearInterval(pollRef.current);
        };
      }, [refreshStatus, refreshAllQuotas]);

      const startLogin = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await api("/login", { method: "POST" });
          if (value.authUrl) window.open(value.authUrl, "_blank", "noopener,noreferrer");
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(async () => {
            const next = await refreshStatus();
            if (next && next.login && next.login.status === "complete") {
              clearInterval(pollRef.current);
              pollRef.current = undefined;
              await refreshAllQuotas();
            }
            if (next && next.login && next.login.status === "error") {
              clearInterval(pollRef.current);
              pollRef.current = undefined;
              setError(next.login.error || tr("loginFailed"));
            }
          }, 2000);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, [refreshAllQuotas, refreshStatus, tr]);

      const updateConfig = useCallback(async (patch) => {
        setError("");
        try {
          const updated = await api("/config", { method: "POST", body: JSON.stringify(patch) });
          setPoolStatus(updated);
          if (updated.models) setModelConfig(updated.models);
          return true;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return false;
        }
      }, []);

      const setPrimary = useCallback(async (id) => {
        setError("");
        try {
          const updated = await api("/accounts/set-primary", { method: "POST", body: JSON.stringify({ id }) });
          setPoolStatus(updated);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      const enableAccount = useCallback(async (id) => {
        setError("");
        try {
          const updated = await api("/accounts/enable", { method: "POST", body: JSON.stringify({ id }) });
          setPoolStatus(updated);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      const removeAccount = useCallback(async (id) => {
        setError("");
        try {
          const updated = await api("/accounts/remove", { method: "POST", body: JSON.stringify({ id }) });
          setPoolStatus(updated);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      const saveModels = useCallback(async (enabledModelIds) => {
        setError("");
        try {
          const value = await api("/models", {
            method: "POST",
            body: JSON.stringify({ enabledModelIds }),
          });
          setModelConfig(value);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      const toggleModel = useCallback((modelId, enabled) => {
        const current = new Set(modelConfig && Array.isArray(modelConfig.enabledModelIds) ? modelConfig.enabledModelIds : []);
        if (enabled) current.add(modelId);
        else current.delete(modelId);
        void saveModels([...current]);
      }, [modelConfig, saveModels]);

      const setAllModels = useCallback((enabled) => {
        const ids = enabled && modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options.map((o) => o.id) : [];
        void saveModels(ids);
      }, [modelConfig, saveModels]);

      const accounts = (poolStatus.accounts && poolStatus.accounts.length > 0)
        ? poolStatus.accounts
        : (poolStatus.email
            ? [{
                id: "acc_active",
                email: poolStatus.email,
                planLabel: poolStatus.planLabel || "Google AI Pro",
                isPrimary: true,
                inCooldown: false,
                cooldownRemainingMs: 0,
                lastError: null,
                quota: poolStatus.quota,
              }]
            : []);

      const enabledSet = useMemo(
        () => new Set(modelConfig && Array.isArray(modelConfig.enabledModelIds) ? modelConfig.enabledModelIds : []),
        [modelConfig],
      );

      const sortedModelOptions = useMemo(() => {
        const options = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : [];
        return [...options].sort((a, b) => compareAntigravityModelOptions(a, b, enabledSet));
      }, [modelConfig, enabledSet]);

      const imageOptions = useMemo(() => {
        const list = [];
        const seen = new Set();
        if (modelConfig && Array.isArray(modelConfig.options)) {
          for (const opt of modelConfig.options) {
            if (isImageGenerationModel(opt)) {
              list.push({ id: opt.id, name: opt.name || opt.id });
              seen.add(opt.id);
            }
          }
        }
        if (!seen.has("gemini-3.1-flash-image")) {
          list.unshift({ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image (Nano Banana 2)" });
        }
        return list;
      }, [modelConfig]);

      // Non-image-gen Gemini models: the candidates the vision bridge picks
      // from when no explicit visionModel is configured.
      const visionOptions = useMemo(() => {
        const list = [];
        if (modelConfig && Array.isArray(modelConfig.options)) {
          for (const opt of modelConfig.options) {
            if (
              opt && opt.id &&
              opt.id.includes("gemini") &&
              !opt.id.includes("image") &&
              Array.isArray(opt.inputModalities) && opt.inputModalities.includes("image")
            ) {
              list.push({ id: opt.id, name: opt.name || opt.id });
            }
          }
        }
        return list;
      }, [modelConfig]);

      return React.createElement(
        "div",
        { className: "dsha-wrap" },
        // Page Header
        React.createElement(
          "div",
          { className: "dsha-page-head" },
          React.createElement(GeminiIcon, { size: 24, className: "dsha-brand-icon" }),
          React.createElement("h2", { className: "dsha-page-title" }, tr("pageTitle")),
        ),
        React.createElement("p", { className: "dsha-page-desc" }, tr("pageDesc")),

        // Error banner
        error
          ? React.createElement(
              "div",
              { className: "dsha-error", role: "alert", "aria-live": "assertive" },
              error,
            )
          : null,

        // Card 1: 账号与登录
        React.createElement(
          "section",
          { className: "dsha-card" },
          React.createElement(
            "div",
            { className: "dsha-card-head" },
            React.createElement(
              "div",
              { className: "dsha-card-title-group" },
              React.createElement(
                "div",
                { className: "dsha-card-title" },
                React.createElement(GeminiIcon, { size: 18, className: "dsha-brand-icon" }),
                React.createElement("span", null, tr("accountsTitle")),
              ),
            ),
            React.createElement(
              "div",
              { className: "dsha-card-actions" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-btn",
                  onClick: refreshAllQuotas,
                  disabled: busy,
                },
                busy ? tr("refreshing") : tr("refreshAllQuotas"),
              ),
            ),
          ),

          // Add Google Account Button (full line dashed)
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsha-btn-add",
              onClick: startLogin,
              disabled: busy,
            },
            busy ? tr("loggingIn") : tr("addAccount"),
          ),

          // Accounts List / Empty State
          accounts.length === 0
            ? React.createElement(
                "div",
                { className: "dsha-empty" },
                tr("noAccountsDesc"),
              )
            : accounts.map((account) =>
                React.createElement(AccountCardItem, {
                  key: account.id,
                  account,
                  poolStatus,
                  setPrimary,
                  enableAccount,
                  updateConfig,
                  removeAccount,
                  tr,
                }),
              ),
        ),

        // Card 2: 调度策略
        React.createElement(
          "section",
          { className: "dsha-card" },
          React.createElement(
            "div",
            { className: "dsha-card-head" },
            React.createElement(
              "div",
              { className: "dsha-card-title-group" },
              React.createElement(
                "div",
                { className: "dsha-card-title" },
                React.createElement(GeminiIcon, { size: 18, className: "dsha-brand-icon" }),
                React.createElement("span", null, tr("schedulerTitle")),
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dsha-radio-group" },
            [
              { key: "auto", title: tr("modeAuto"), desc: tr("modeAutoDesc") },
              { key: "primary-backup", title: tr("modePrimary"), desc: tr("modePrimaryDesc") },
              { key: "manual", title: tr("modeManual"), desc: tr("modeManualDesc") },
            ].map((item) =>
              React.createElement(
                "label",
                {
                  key: item.key,
                  className: `dsha-radio-item ${poolStatus.schedulingMode === item.key ? "active" : ""}`,
                },
                React.createElement("input", {
                  type: "radio",
                  name: "dsha_scheduler_mode",
                  className: "dsha-radio-input",
                  checked: poolStatus.schedulingMode === item.key,
                  onChange: () => updateConfig({ schedulingMode: item.key }),
                }),
                React.createElement(
                  "div",
                  { className: "dsha-radio-text" },
                  React.createElement("div", { className: "dsha-radio-label" }, item.title),
                  React.createElement("div", { className: "dsha-radio-desc" }, item.desc),
                ),
              ),
            ),
          ),
          // Collapsible "Cooldown & Recovery" section
          React.createElement(
            "div",
            { className: "dsha-collapse" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsha-collapse-toggle",
                "aria-expanded": cooldownExpanded,
                onClick: () => {
                  setCooldownExpanded((prev) => !prev);
                  setCooldownMsg("");
                },
              },
              `${cooldownExpanded ? "▼" : "▶"} ${tr("cooldownSectionTitle")}`,
            ),
            cooldownExpanded
              ? React.createElement(
                  "div",
                  { className: "dsha-collapse-body" },
                  React.createElement(
                    "div",
                    { className: "dsha-input-group" },
                    React.createElement("label", { htmlFor: "dsha-cfg-cooldown-ms", className: "dsha-input-label" }, tr("cooldownMsLabel")),
                    React.createElement("input", {
                      id: "dsha-cfg-cooldown-ms",
                      type: "number",
                      className: "dsha-input",
                      value: cooldownForm.cooldownMs,
                      onChange: (e) =>
                        setCooldownForm({ ...cooldownForm, cooldownMs: parseInt(e.target.value, 10) || 0 }),
                    }),
                  ),
                  React.createElement(
                    "div",
                    { className: "dsha-input-group" },
                    React.createElement("label", { htmlFor: "dsha-cfg-cooldown-max-ms", className: "dsha-input-label" }, tr("cooldownMaxMsLabel")),
                    React.createElement("input", {
                      id: "dsha-cfg-cooldown-max-ms",
                      type: "number",
                      className: "dsha-input",
                      value: cooldownForm.cooldownMaxMs,
                      onChange: (e) =>
                        setCooldownForm({ ...cooldownForm, cooldownMaxMs: parseInt(e.target.value, 10) || 0 }),
                    }),
                  ),
                  React.createElement(
                    "div",
                    { className: "dsha-input-group" },
                    React.createElement("label", { htmlFor: "dsha-cfg-disable-threshold", className: "dsha-input-label" }, tr("disableThresholdLabel")),
                    React.createElement("input", {
                      id: "dsha-cfg-disable-threshold",
                      type: "number",
                      className: "dsha-input",
                      value: cooldownForm.disableThreshold,
                      onChange: (e) =>
                        setCooldownForm({ ...cooldownForm, disableThreshold: parseInt(e.target.value, 10) || 0 }),
                    }),
                  ),
                  React.createElement(
                    "div",
                    { className: "dsha-input-group" },
                    React.createElement("label", { htmlFor: "dsha-cfg-probe-interval-ms", className: "dsha-input-label" }, tr("probeIntervalMsLabel")),
                    React.createElement("input", {
                      id: "dsha-cfg-probe-interval-ms",
                      type: "number",
                      className: "dsha-input",
                      value: cooldownForm.probeIntervalMs,
                      onChange: (e) =>
                        setCooldownForm({ ...cooldownForm, probeIntervalMs: parseInt(e.target.value, 10) || 0 }),
                    }),
                  ),
                  React.createElement(
                    "div",
                    { className: "dsha-collapse-footer" },
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "dsha-btn dsha-btn-primary",
                        onClick: async () => {
                          setCooldownMsg("");
                          if (await updateConfig(cooldownForm)) {
                            setCooldownMsg(tr("configSaved"));
                            setTimeout(() => setCooldownMsg(""), 3000);
                          }
                        },
                      },
                      tr("saveCooldownConfig"),
                    ),
                    cooldownMsg
                      ? React.createElement("span", {
                          role: "status",
                          "aria-live": "polite",
                          style: { fontSize: "12px", color: "var(--dsha-green-text)" },
                        }, cooldownMsg)
                      : null,
                  ),
                )
              : null,
          ),
        ),

        // Card 3: 模型选择器
        React.createElement(
          "section",
          { className: "dsha-card" },
          React.createElement(
            "div",
            { className: "dsha-card-head" },
            React.createElement(
              "div",
              { className: "dsha-card-title-group" },
              React.createElement(
                "div",
                { className: "dsha-card-title" },
                React.createElement(GeminiIcon, { size: 18, className: "dsha-brand-icon" }),
                React.createElement("span", null, tr("modelSelector")),
              ),
              React.createElement(
                "p",
                { className: "dsha-card-desc" },
                tr("modelSelectorDesc"),
              ),
            ),
            React.createElement(
              "div",
              { className: "dsha-card-actions" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-mini-btn",
                  disabled: busy,
                  onClick: () => setAllModels(true),
                },
                tr("selectAll"),
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsha-mini-btn",
                  disabled: busy,
                  onClick: () => setAllModels(false),
                },
                tr("unselectAll"),
              ),
            ),
          ),
          sortedModelOptions.length === 0
            ? React.createElement("div", { className: "dsha-empty" }, tr("loadingModels"))
            : React.createElement(
                "div",
                { className: "dsha-model-list" },
                sortedModelOptions.map((model) => {
                  const isChecked = enabledSet.has(model.id);
                  const isImage = isImageGenerationModel(model);
                  const isThinking = (model.id && (model.id.includes("thinking") || model.id.includes("tiered")))
                    || (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0);

                  return React.createElement(
                    "label",
                    {
                      key: model.id,
                      className: "dsha-model-row",
                    },
                    React.createElement("input", {
                      type: "checkbox",
                      className: "dsha-check",
                      checked: isChecked,
                      "aria-label": model.name || model.id,
                      onChange: () => toggleModel(model.id, !isChecked),
                    }),
                    React.createElement(
                      "div",
                      { className: "dsha-model-info" },
                      React.createElement(
                        "div",
                        { className: "dsha-model-top" },
                        React.createElement("span", { className: "dsha-model-name" }, model.name || model.id),
                        isThinking ? React.createElement("span", { className: "dsha-badge-think" }, tr("reasoningBadge")) : null,
                        isImage ? React.createElement("span", { className: "dsha-badge-image" }, tr("imageGenBadge")) : null,
                        model.deprecated
                          ? React.createElement("span", { className: "dsha-badge-deprecated", title: model.description || undefined }, tr("deprecatedBadge"))
                          : null,
                        model.available === false
                          ? React.createElement(
                              "span",
                              {
                                className: "dsha-badge-unavailable",
                                // 后端给的不可用原因（如 Gemini 4 Carbon 仅 Ultra 可用）优先，
                                // 没有就退回通用的“本账号不可用”。
                                title: model.unavailableReason || model.description || (model.id + " not available on this account"),
                              },
                              tr("unavailableBadge"),
                            )
                          : null,
                      ),
                      React.createElement(
                        "div",
                        { className: "dsha-model-sub" },
                        model.remainingPercent !== undefined
                          ? `${model.id} · ${tr("quotaLabel", { percent: model.remainingPercent })}`
                          : model.id,
                      ),
                    ),
                  );
                }),
              ),
          React.createElement("div", { className: "dsha-note" }, tr("modelSelectorNote")),
        ),

        // Card 4: 默认生图配置
        React.createElement(
          "section",
          { className: "dsha-card" },
          React.createElement(
            "div",
            { className: "dsha-card-head" },
            React.createElement(
              "div",
              { className: "dsha-card-title-group" },
              React.createElement(
                "div",
                { className: "dsha-card-title" },
                React.createElement(GeminiIcon, { size: 18, className: "dsha-brand-icon" }),
                React.createElement("span", null, tr("imageConfigTitle")),
              ),
              React.createElement(
                "p",
                { className: "dsha-card-desc" },
                tr("imageConfigDesc"),
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dsha-input-row" },
            React.createElement(
              "div",
              { className: "dsha-input-group" },
              React.createElement("label", { htmlFor: "dsha-cfg-image-model", className: "dsha-input-label" }, tr("imageModelLabel")),
              React.createElement(
                "select",
                {
                  id: "dsha-cfg-image-model",
                  className: "dsha-input",
                  value: poolStatus.defaultImageModel || "gemini-3.1-flash-image",
                  onChange: (e) => updateConfig({ defaultImageModel: e.target.value }),
                },
                imageOptions.map((opt) =>
                  React.createElement("option", { key: opt.id, value: opt.id }, opt.name),
                ),
              ),
            ),
            React.createElement(
              "div",
              { className: "dsha-input-group" },
              React.createElement("label", { htmlFor: "dsha-cfg-image-dir", className: "dsha-input-label" }, tr("imageOutputDirLabel")),
              React.createElement("input", {
                id: "dsha-cfg-image-dir",
                type: "text",
                className: "dsha-input",
                value: poolStatus.imageOutputDir || "./assets/images",
                onChange: (e) => updateConfig({ imageOutputDir: e.target.value }),
                placeholder: "./assets/images",
              }),
            ),
          ),
        ),

        // Card 5: 视觉旁路
        React.createElement(
          "section",
          { className: "dsha-card" },
          React.createElement(
            "div",
            { className: "dsha-card-head" },
            React.createElement(
              "div",
              { className: "dsha-card-title-group" },
              React.createElement(
                "div",
                { className: "dsha-card-title" },
                React.createElement(GeminiIcon, { size: 18, className: "dsha-brand-icon" }),
                React.createElement("span", null, tr("visionTitle")),
              ),
              React.createElement(
                "p",
                { className: "dsha-card-desc" },
                tr("visionDesc"),
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dsha-input-row" },
            React.createElement(
              "label",
              { className: "dsha-model-row" },
              React.createElement("input", {
                type: "checkbox",
                className: "dsha-check",
                checked: poolStatus.visionEnabled !== false,
                onChange: (e) => updateConfig({ visionEnabled: e.target.checked }),
              }),
              React.createElement(
                "div",
                { className: "dsha-model-info" },
                React.createElement(
                  "div",
                  { className: "dsha-model-top" },
                  tr("visionEnabledLabel"),
                ),
              ),
            ),
            React.createElement(
              "div",
              { className: "dsha-input-group" },
              React.createElement("label", { htmlFor: "dsha-cfg-vision-model", className: "dsha-input-label" }, tr("visionModelLabel")),
              React.createElement(
                "select",
                {
                  id: "dsha-cfg-vision-model",
                  className: "dsha-input",
                  value: poolStatus.visionModel || "",
                  onChange: (e) => updateConfig({ visionModel: e.target.value }),
                },
                React.createElement("option", { value: "" }, tr("visionModelAuto")),
                visionOptions.map((opt) =>
                  React.createElement("option", { key: opt.id, value: opt.id }, opt.name),
                ),
              ),
            ),
          ),
        ),
      );
    }

    function patchNavIcon() {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.textContent.trim() === "Antigravity") {
          const btn = span.closest("button");
          if (btn) {
            const svg = btn.querySelector("svg");
            if (svg) {
              svg.setAttribute("viewBox", "0 0 110 110");
              svg.setAttribute("width", "16");
              svg.setAttribute("height", "16");
              svg.setAttribute("fill", "none");
              const path = svg.querySelector("path");
              if (!path || path.getAttribute("d") !== GEMINI_SPARK_PATH) {
                svg.innerHTML = `<path d="${GEMINI_SPARK_PATH}" fill="currentColor"/>`;
              }
            }
          }
        }
      }
    }

    function initNavObserver() {
      patchNavIcon();
      if (window.__antigravityNavObserver) return;
      const observer = new MutationObserver(() => {
        patchNavIcon();
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      window.addEventListener("click", patchNavIcon, true);
      window.setInterval(patchNavIcon, 300);
      window.__antigravityNavObserver = observer;
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installStyle();
        initNavObserver();
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh, en });
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "antigravity",
          order: 12,
          label: () => "Antigravity",
        }, (props) => React.createElement(GeminiSettingsPage, { ...props, ctx })));
      },
    };
  },
});
