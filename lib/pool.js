/**
 * Multi-account pool manager for Google Antigravity / Cloud Code Assist.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "./diagnostics.js";
function getDshHomePath() {
  const envHome = process.env.DSH_HOME?.trim();
  if (envHome) return envHome;
  const userProfile = process.env.USERPROFILE || process.env.HOME || ".";
  return `${userProfile}/.dsh`;
}

export function accountsPoolPath() {
  return `${getDshHomePath()}/storages/antigravity-pool-accounts.json`;
}

export function legacyCredentialPath() {
  return `${getDshHomePath()}/storages/antigravity-oauth.json`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AccountPoolManager {
  #file;
  #legacyFile;
  #chain = Promise.resolve();
  #accounts = [];
  #schedulingMode = "auto"; // "auto" | "primary-backup" | "manual"
  #activeAccountId = null;
  #defaultImageModel = "gemini-3.1-flash-image";
  #imageOutputDir = "./assets/images";
  #visionEnabled = true;
  #visionModel = "";
  #cooldownMs = 60000;
  #cooldownMaxMs = 3600000;
  #disableThreshold = 5;
  #probeIntervalMs = 300000;
  #initialized = false;
  #initializing = null;

  constructor(file = accountsPoolPath(), legacyFile = legacyCredentialPath()) {
    this.#file = file;
    this.#legacyFile = legacyFile;
  }

  async init() {
    if (this.#initialized) return;
    // Concurrent first-use requests must share the same load: a late reader
    // could otherwise replace accounts that an earlier request just added.
    if (!this.#initializing) {
      this.#initializing = this.#load()
        .then(() => {
          this.#initialized = true;
        })
        .finally(() => {
          this.#initializing = null;
        });
    }
    await this.#initializing;
  }

  async #load() {
    // A pool file that exists but cannot be parsed/validated is corrupt user
    // data, not an absent pool: fail loudly instead of silently starting empty
    // and letting the legacy migration below overwrite a recoverable file.
    if (existsSync(this.#file)) {
      let raw;
      try {
        raw = JSON.parse(await readFile(this.#file, "utf8"));
      } catch (err) {
        throw new Error(
          `accounts pool file is corrupt and cannot be parsed (${this.#file}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isRecord(raw)) {
        throw new Error(`accounts pool file must be a JSON object (${this.#file})`);
      }
      this.#schedulingMode = raw.schedulingMode || "auto";
      this.#activeAccountId = raw.activeAccountId || null;
      this.#defaultImageModel = raw.defaultImageModel || "gemini-3.1-flash-image";
      this.#imageOutputDir = raw.imageOutputDir || "./assets/images";
      this.#visionEnabled = raw.visionEnabled !== false;
      this.#visionModel = typeof raw.visionModel === "string" ? raw.visionModel : "";
      if (typeof raw.cooldownMs === "number") this.#cooldownMs = raw.cooldownMs;
      if (typeof raw.cooldownMaxMs === "number") this.#cooldownMaxMs = raw.cooldownMaxMs;
      if (typeof raw.disableThreshold === "number") this.#disableThreshold = raw.disableThreshold;
      if (typeof raw.probeIntervalMs === "number") this.#probeIntervalMs = raw.probeIntervalMs;
      this.#accounts = Array.isArray(raw.accounts)
        ? raw.accounts.map((acc, index) => {
            if (!acc || typeof acc !== "object" || typeof acc.id !== "string" || !acc.id) {
              throw new Error(
                `accounts pool entry #${index} is malformed (missing id): ${JSON.stringify(acc)?.slice(0, 120)}`,
              );
            }
            // The durable credential is the refresh token; the access token is
            // ephemeral and re-minted on demand (and may be empty for a
            // legacy-migrated account). Validate the field that actually gates
            // usability — an entry with no refresh token can never authenticate.
            if (typeof acc.refresh !== "string" || !acc.refresh) {
              throw new Error(
                `accounts pool entry "${acc.id}" is malformed (missing refresh token)`,
              );
            }
            return {
              ...acc,
              failureCount: typeof acc.failureCount === "number" ? acc.failureCount : 0,
              status: acc.status === "disabled" ? "disabled" : "active",
            };
          })
        : [];
      return;
    }

    // Migration fallback: import legacy antigravity-oauth.json if pool is empty
    if (this.#accounts.length === 0 && existsSync(this.#legacyFile)) {
      try {
        const legacy = JSON.parse(await readFile(this.#legacyFile, "utf8"));
        if (isRecord(legacy) && legacy.refresh) {
          const legacyAccount = {
            id: "acc_" + Date.now().toString(36),
            email: legacy.email || "primary@gmail.com",
            planLabel: "PRO",
            refresh: legacy.refresh,
            access: legacy.access || "",
            expires: typeof legacy.expires === "number" ? legacy.expires : 0,
            projectId: legacy.projectId || "",
            isPrimary: true,
            cooldownUntil: 0,
            failureCount: 0,
            status: "active",
            lastError: null,
            quota: null,
            createdAt: Date.now(),
          };
          this.#accounts = [legacyAccount];
          this.#activeAccountId = legacyAccount.id;
          await this.#save();
          console.log("[Antigravity Pool] Migrated legacy credentials to Account 1:", legacyAccount.email);
        }
      } catch (err) {
        console.error("[Antigravity Pool] Error migrating legacy credentials:", err);
      }
    }
  }

  async #save() {
    await mkdir(dirname(this.#file), { recursive: true });
    const payload = {
      schedulingMode: this.#schedulingMode,
      activeAccountId: this.#activeAccountId,
      defaultImageModel: this.#defaultImageModel,
      imageOutputDir: this.#imageOutputDir,
      visionEnabled: this.#visionEnabled,
      visionModel: this.#visionModel,
      cooldownMs: this.#cooldownMs,
      cooldownMaxMs: this.#cooldownMaxMs,
      disableThreshold: this.#disableThreshold,
      probeIntervalMs: this.#probeIntervalMs,
      updatedAt: Date.now(),
      accounts: this.#accounts,
    };
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  async getStatus() {
    await this.init();
    return {
      schedulingMode: this.#schedulingMode,
      activeAccountId: this.#activeAccountId,
      cooldownMs: this.#cooldownMs,
      cooldownMaxMs: this.#cooldownMaxMs,
      disableThreshold: this.#disableThreshold,
      probeIntervalMs: this.#probeIntervalMs,
      accounts: this.#accounts.map((acc) => ({
        id: acc.id,
        email: acc.email,
        planLabel: acc.planLabel || "PRO",
        isPrimary: Boolean(acc.isPrimary),
        status: acc.status || "active",
        failureCount: acc.failureCount || 0,
        inCooldown: (acc.cooldownUntil || 0) > Date.now(),
        cooldownRemainingMs: Math.max(0, (acc.cooldownUntil || 0) - Date.now()),
        lastError: acc.lastError ? redactSecrets(acc.lastError) : null,
        quota: acc.quota || null,
      })),
    };
  }

  async addOrUpdateAccount(credentials) {
    await this.init();
    return this.#modify(async () => {
      const email = credentials.email || "unknown@gmail.com";
      const existing = this.#accounts.find((a) => a.email === email || (credentials.id && a.id === credentials.id));
      if (existing) {
        existing.refresh = credentials.refresh || existing.refresh;
        existing.access = credentials.access || existing.access;
        existing.expires = credentials.expires || existing.expires;
        existing.projectId = credentials.projectId || existing.projectId;
        existing.planLabel = credentials.planLabel || existing.planLabel || "PRO";
        existing.lastError = null;
        existing.cooldownUntil = 0;
        existing.updatedAt = Date.now();
        console.log("[Antigravity Pool] Updated account tokens:", email);
      } else {
        const isFirst = this.#accounts.length === 0;
        const newAcc = {
          id: "acc_" + Date.now().toString(36) + "_" + randomBytes(2).toString("hex"),
          email,
          planLabel: credentials.planLabel || "PRO",
          refresh: credentials.refresh,
          access: credentials.access,
          expires: credentials.expires,
          projectId: credentials.projectId,
          isPrimary: isFirst,
          cooldownUntil: 0,
          failureCount: 0,
          status: "active",
          lastError: null,
          quota: null,
          createdAt: Date.now(),
        };
        this.#accounts.push(newAcc);
        if (isFirst || !this.#activeAccountId) {
          this.#activeAccountId = newAcc.id;
        }
        console.log("[Antigravity Pool] Added new account:", email);
      }
      await this.#save();
    });
  }

  async removeAccount(id) {
    await this.init();
    return this.#modify(async () => {
      const idx = this.#accounts.findIndex((a) => a.id === id);
      if (idx !== -1) {
        const wasPrimary = this.#accounts[idx].isPrimary;
        this.#accounts.splice(idx, 1);
        if (wasPrimary && this.#accounts.length > 0) {
          this.#accounts[0].isPrimary = true;
        }
        if (this.#activeAccountId === id) {
          this.#activeAccountId = this.#accounts[0]?.id || null;
        }
        await this.#save();
      }
    });
  }

  async setPrimaryAccount(id) {
    await this.init();
    return this.#modify(async () => {
      for (const acc of this.#accounts) {
        acc.isPrimary = acc.id === id;
      }
      this.#activeAccountId = id;
      await this.#save();
    });
  }

  async updateConfig(config) {
    await this.init();
    return this.#modify(async () => {
      if (typeof config.schedulingMode === "string") {
        this.#schedulingMode = config.schedulingMode;
      }
      if (typeof config.activeAccountId === "string") {
        this.#activeAccountId = config.activeAccountId;
      }
      if (typeof config.defaultImageModel === "string") {
        this.#defaultImageModel = config.defaultImageModel;
      }
      if (typeof config.imageOutputDir === "string") {
        this.#imageOutputDir = config.imageOutputDir;
      }
      if (typeof config.visionEnabled === "boolean") {
        this.#visionEnabled = config.visionEnabled;
      }
      if (typeof config.visionModel === "string") {
        this.#visionModel = config.visionModel;
      }
      if (typeof config.cooldownMs === "number" && config.cooldownMs > 0) {
        this.#cooldownMs = config.cooldownMs;
      }
      if (typeof config.cooldownMaxMs === "number" && config.cooldownMaxMs > 0) {
        this.#cooldownMaxMs = config.cooldownMaxMs;
      }
      if (typeof config.disableThreshold === "number" && config.disableThreshold > 0) {
        this.#disableThreshold = config.disableThreshold;
      }
      if (typeof config.probeIntervalMs === "number" && config.probeIntervalMs > 0) {
        this.#probeIntervalMs = config.probeIntervalMs;
      }
      await this.#save();
    });
  }

  async updateAccountQuota(id, quota, planLabel) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.quota = quota;
        if (planLabel) acc.planLabel = planLabel;
        await this.#save();
      }
    });
  }

  async markCooldown(id, durationMs, reason = "") {
    await this.init();
    reason = reason ? redactSecrets(reason) : "";
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.failureCount = (typeof acc.failureCount === "number" ? acc.failureCount : 0) + 1;
        const computedDuration =
          typeof durationMs === "number" && durationMs > 0
            ? durationMs
            : Math.min(
                this.#cooldownMs * 2 ** Math.max(0, acc.failureCount - 1),
                this.#cooldownMaxMs,
              );
        acc.cooldownUntil = Date.now() + computedDuration;
        acc.lastError = reason || "Rate limited (429)";
        if (acc.failureCount >= this.#disableThreshold) {
          acc.status = "disabled";
          console.warn(
            `[Antigravity Pool] Account ${acc.email} reached failure threshold (${acc.failureCount}/${this.#disableThreshold}) and is now disabled`,
          );
        } else {
          console.warn(
            `[Antigravity Pool] Account ${acc.email} entered cooldown for ${Math.round(computedDuration / 1000)}s (failureCount: ${acc.failureCount}): ${reason}`,
          );
        }
        await this.#save();
      }
    });
  }

  /**
   * Clear only the cooldown window after a request succeeded. The accumulated
   * failureCount is deliberately preserved: an account that fails
   * intermittently must still climb the backoff ladder and retire at
   * disableThreshold. Use clearCooldown() for the manual re-enable semantics.
   */
  async clearCooldownUntil(id) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.cooldownUntil = 0;
        await this.#save();
      }
    });
  }

  /**
   * Full reset (manual re-enable): clears cooldown, failureCount and status.
   */
  async clearCooldown(id) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.cooldownUntil = 0;
        acc.failureCount = 0;
        acc.status = "active";
        acc.lastError = null;
        await this.#save();
      }
    });
  }

  /**
   * A successful background probe re-activates the account, but deliberately
   * keeps most of its failure history: one probe success is one data point,
   * not proof the account is healthy again. Only decay failureCount by one
   * so an account that recovered after many failures must still demonstrate
   * repeated success before it is fully trusted again. Manual re-enable
   * (enableAccount/clearCooldown) remains the full reset.
   */
  async recordProbeSuccess(id) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.cooldownUntil = 0;
        acc.status = "active";
        acc.lastError = null;
        acc.failureCount = Math.max(0, (acc.failureCount || 0) - 1);
        await this.#save();
        console.log(
          `[Antigravity Pool] Probe success for ${acc.email}: re-enabled, failureCount now ${acc.failureCount}`,
        );
      }
    });
  }

  async enableAccount(id) {
    await this.init();
    return this.#modify(async () => {
      const acc = this.#accounts.find((a) => a.id === id);
      if (acc) {
        acc.cooldownUntil = 0;
        acc.failureCount = 0;
        acc.status = "active";
        acc.lastError = null;
        await this.#save();
        console.log(`[Antigravity Pool] Account ${acc.email} re-enabled`);
      }
    });
  }

  /**
   * Return candidate accounts ordered by selection priority for model category.
   * category: "gemini" | "claude"
   */
  async getCandidateAccounts(category = "gemini") {
    await this.init();
    if (this.#accounts.length === 0) return [];

    if (this.#schedulingMode === "manual") {
      const active = this.#accounts.find((a) => a.id === this.#activeAccountId) ||
        this.#accounts.find((a) => a.isPrimary && a.status !== "disabled") ||
        this.#accounts.find((a) => a.status !== "disabled");
      if (!active || active.status === "disabled") {
        throw new Error("手动指定的账号已被禁用，请在设置页重新启用或选择其他账号");
      }
      return [active];
    }

    // Filter out disabled accounts completely
    const nonDisabled = this.#accounts.filter((a) => a.status !== "disabled");
    if (nonDisabled.length === 0) {
      throw new Error("所有账号已被禁用，请在设置页重新启用或等待自动探活");
    }

    const now = Date.now();
    const available = nonDisabled.filter((a) => (a.cooldownUntil || 0) <= now);
    const inCooldown = nonDisabled.filter((a) => (a.cooldownUntil || 0) > now)
      .sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0));

    if (this.#schedulingMode === "primary-backup") {
      const primary = nonDisabled.find((a) => a.isPrimary) || nonDisabled[0];
      const backups = nonDisabled.filter((a) => a.id !== primary.id);
      if (available.some((a) => a.id === primary.id)) {
        return [primary, ...backups.filter((b) => available.includes(b)), ...inCooldown];
      }
      return [...backups.filter((b) => available.includes(b)), ...inCooldown];
    }

    // "auto": Smart balancing based on highest remaining quota fraction
    const quotaFraction = (acc) => {
      const group = acc.quota?.groups?.find((g) =>
        category === "claude" ? /claude|gpt/i.test(g.displayName || g.name) : /gemini/i.test(g.displayName || g.name)
      );
      if (!group) return 1.0;
      // Every window constrains usability: a full five-hour bucket cannot
      // compensate for an exhausted weekly bucket (or vice versa).
      const fractions = (group.buckets || group.limits || [])
        .map((limit) => limit.remainingFraction)
        .filter(Number.isFinite);
      return fractions.length ? Math.min(...fractions) : 1.0;
    };

    const sortedAvailable = [...available].sort((a, b) => quotaFraction(b) - quotaFraction(a));
    return [...sortedAvailable, ...inCooldown];
  }

  get probeIntervalMs() {
    return this.#probeIntervalMs;
  }

  get disableThreshold() {
    return this.#disableThreshold;
  }

  get cooldownMs() {
    return this.#cooldownMs;
  }

  get cooldownMaxMs() {
    return this.#cooldownMaxMs;
  }

  get defaultImageModel() {
    return this.#defaultImageModel;
  }

  get imageOutputDir() {
    return this.#imageOutputDir;
  }

  get visionEnabled() {
    return this.#visionEnabled;
  }

  get visionModel() {
    return this.#visionModel;
  }

  get allAccounts() {
    return this.#accounts;
  }

  #modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      await fn();
    })();
    this.#chain = next.catch(() => {});
    return next;
  }
}
