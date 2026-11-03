/**
 * Plugin-owned conversation commands (the host `commands` service).
 *
 * The README's command table (login / quota / doctor / logout) is a UX
 * contract; until now it was a documentation promise with nothing behind it
 * (the same shape as the /antigravity-doctor route gap PR #9 closed). These
 * registrations make the table true: handlers reuse the exact in-process
 * functions the web API routes call — no HTTP round-trip, one code path.
 *
 * Registration is defensive: a host without the `commands` service (older
 * engines) or an incompatible registry shape simply gets no commands — the
 * web API routes and the antigravity-login CLI remain the entry points —
 * and never a plugin-load failure.
 */

/** Render a thrown value for a command error text without trusting coercion. */
function renderError(error) {
  const text = error?.message || String(error);
  return `Antigravity command failed: ${text}`;
}

/** Human one-line quota readout for one account from getStatus() shape. */
function quotaLine(account) {
  const group = account.quota?.groups?.find((g) => /gemini/i.test(g.displayName || g.name || ""));
  const fraction = (pattern) => {
    const limit = (group?.buckets || group?.limits)?.find((bucket) =>
      pattern.test([bucket.displayName, bucket.label, bucket.window, bucket.bucketId].filter(Boolean).join(" ")),
    );
    return Number.isFinite(limit?.remainingFraction)
      ? `${Math.round(limit.remainingFraction * 100)}%`
      : "?";
  };
  const quota = account.quota
    ? ` gemini 5h=${fraction(/five|5.*hour|5h\b/i)} week=${fraction(/week/i)}`
    : " quota=unknown";
  return `- ${account.email} [${account.status}]${account.isPrimary ? " primary" : ""}${account.inCooldown ? " cooldown" : ""}${quota}`;
}

/**
 * Register the four pool commands on a context whose `commands` service is
 * live. All collaborators are injected so tests stub them; nothing here
 * imports from index.js (which imports this module).
 *
 * @param ctx - context exposing the host `commands` registry.
 * @param deps - { poolManager, modelSettings, beginLogin, fetchQuotaForAccount, doctorText, emitUpdated }
 * @returns a disposer that unregisters every command registered here.
 */
export function registerCommands(ctx, deps) {
  const commands = ctx?.commands;
  if (typeof commands?.register !== "function") return () => {};

  const guarded = (handler) => async (invocation) => {
    try {
      return await handler(invocation);
    } catch (error) {
      return { kind: "error", text: renderError(error) };
    }
  };

  const handleLogin = guarded(async () => {
    const value = await deps.beginLogin();
    return {
      kind: "success",
      text:
        `Google login started (status=${value.status}).\n` +
        `Open this URL in a browser and finish consent:\n${value.authUrl}\n` +
        `The callback is already being listened for; the account joins the pool automatically.`,
    };
  });

  const handleQuota = guarded(async () => {
    await deps.poolManager.init();
    const accounts = deps.poolManager.allAccounts;
    if (!accounts.length) {
      return { kind: "success", text: "No pool accounts yet. Run /antigravity-login to add one." };
    }
    await Promise.allSettled(
      accounts.map((acc) => deps.fetchQuotaForAccount(acc, deps.poolManager, deps.modelSettings)),
    );
    deps.emitUpdated();
    const status = await deps.poolManager.getStatus();
    return {
      kind: "success",
      text: [`scheduling=${status.schedulingMode} accounts=${status.accounts.length}`, ...status.accounts.map(quotaLine)].join("\n"),
    };
  });

  const handleDoctor = guarded(async () => ({ kind: "success", text: deps.doctorText() }));

  // Destructive on purpose (removes ALL credentials), so it refuses to run
  // without an explicit confirm argument.
  const handleLogout = guarded(async (invocation) => {
    if (invocation?.rawInput?.trim() !== "confirm") {
      return {
        kind: "error",
        text: "This removes ALL pooled account credentials. Usage: /antigravity-logout confirm",
      };
    }
    const status = await deps.poolManager.getStatus();
    for (const account of status.accounts) {
      await deps.poolManager.removeAccount(account.id);
    }
    deps.emitUpdated();
    return { kind: "success", text: `Removed ${status.accounts.length} account(s); their credentials are erased.` };
  });

  const disposers = [
    commands.register({
      name: "antigravity-login",
      description: "Start Google OAuth login for the Antigravity pool",
      handler: handleLogin,
    }),
    commands.register({
      name: "antigravity-quota",
      description: "Refresh and show pool account quotas",
      handler: handleQuota,
    }),
    commands.register({
      name: "antigravity-doctor",
      description: "Show the Antigravity pool self-diagnosis (vision bridge status)",
      handler: handleDoctor,
    }),
    commands.register({
      name: "antigravity-logout",
      description: "Remove ALL pool account credentials (requires 'confirm')",
      input: { hint: "confirm" },
      recordInput: false,
      handler: handleLogout,
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}
