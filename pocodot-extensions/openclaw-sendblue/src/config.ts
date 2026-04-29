// ---------------------------------------------------------------------------
// Config Normalization — shared logic for multi-account config resolution
//
// Handles both legacy flat config and multi-account config structures.
// Flat config (no `accounts` key) is treated as a single "default" account.
// ---------------------------------------------------------------------------

import type { SendblueConfig } from "./types.js";
import { CONFIG_DEFAULTS, ACCOUNT_DEFAULTS } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

// Channel-level keys (not per-account)
const CHANNEL_LEVEL_KEYS = new Set([
  "enabled",
  "webhookPort",
  "webhookPath",
  "webhookSecret",
]);

// ---------------------------------------------------------------------------
// Detection & normalization
// ---------------------------------------------------------------------------

/** Check whether config uses the multi-account `accounts` structure */
export function isMultiAccountConfig(channelCfg: any): boolean {
  return (
    channelCfg?.accounts !== undefined &&
    channelCfg.accounts !== null &&
    typeof channelCfg.accounts === "object" &&
    !Array.isArray(channelCfg.accounts)
  );
}

/**
 * Normalize any channel config (flat or multi-account) into a uniform shape:
 * `{ channelLevel, accounts }`.
 *
 * For flat configs the per-account fields are extracted into a single
 * `"default"` account entry.
 */
export function normalizeChannelConfig(channelCfg: any): {
  channelLevel: Record<string, any>;
  accounts: Record<string, any>;
} {
  const raw = channelCfg ?? {};

  if (isMultiAccountConfig(raw)) {
    const { accounts, ...channelLevel } = raw;
    return { channelLevel, accounts };
  }

  // Legacy flat config — split into channel-level and a single "default" account
  const channelLevel: Record<string, any> = {};
  const accountFields: Record<string, any> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (CHANNEL_LEVEL_KEYS.has(key)) {
      channelLevel[key] = value;
    } else {
      accountFields[key] = value;
    }
  }

  // Only create default account if there are meaningful account-level fields
  const hasAccountData = Boolean(
    accountFields.apiKeyId || accountFields.apiSecretKey || accountFields.fromNumber
  );

  return {
    channelLevel,
    accounts: hasAccountData
      ? { [DEFAULT_ACCOUNT_ID]: { enabled: channelLevel.enabled ?? true, ...accountFields } }
      : {},
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a fully-typed `SendblueConfig` for a specific account.
 *
 * Merges: defaults < channel-level < per-account.
 * `webhookSecret` is channel-level and falls back to defaults.
 */
export function resolveAccountConfig(
  cfg: any,
  accountId: string
): SendblueConfig {
  const channelCfg = cfg?.channels?.["sendblue"] ?? {};
  const { channelLevel, accounts } = normalizeChannelConfig(channelCfg);
  const acct = accounts[accountId] ?? {};

  return {
    enabled: acct.enabled ?? ACCOUNT_DEFAULTS.enabled ?? true,
    fromNumber: String(acct.fromNumber ?? ""),
    apiKeyId: String(acct.apiKeyId ?? ""),
    apiSecretKey: String(acct.apiSecretKey ?? ""),
    webhookPort: Number(
      channelLevel.webhookPort ?? CONFIG_DEFAULTS.webhookPort!
    ),
    webhookPath: String(
      channelLevel.webhookPath ?? CONFIG_DEFAULTS.webhookPath!
    ),
    webhookSecret: String(
      channelLevel.webhookSecret ?? CONFIG_DEFAULTS.webhookSecret!
    ),
    dmPolicy: acct.dmPolicy ?? ACCOUNT_DEFAULTS.dmPolicy!,
    allowFrom: acct.allowFrom ?? ACCOUNT_DEFAULTS.allowFrom!,
    sendReadReceipts:
      acct.sendReadReceipts ?? ACCOUNT_DEFAULTS.sendReadReceipts!,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Migrate a flat (legacy) channel config to multi-account format.
 * Extracts channel-level fields and wraps per-account fields under
 * `accounts.default`. No-op if already multi-account.
 */
export function migrateToMultiAccount(channelCfg: any): any {
  if (isMultiAccountConfig(channelCfg)) return channelCfg;

  const { channelLevel, accounts } = normalizeChannelConfig(channelCfg);

  return {
    ...channelLevel,
    accounts,
  };
}
