/**
 * Billing Usage Tracker Plugin v4.3
 *
 * Captures actual LLM token usage from the llm_output plugin hook and
 * stores it on globalThis.__billingUsageCache so the outbound-billing-relay
 * internal hook can include it in the POST to cole-api.
 *
 * v4.3 (2026-04-21): Fix channel attribution regression — all calls to
 *   /api/poco/usage/increment/internal now include channel_type and sender_id
 *   so that credit transactions are properly attributed to the correct channel
 *   (slack, whatsapp, telegram, etc.) instead of showing 'unknown'.
 *
 * v4.2 (2026-04-21): Fix Bug #290 — WhatsApp canonical DM sessions
 *   (agent:{agentId}:whatsapp:{accountId}:direct:{userId}) were never billed
 *   because isSlackCanonicalDm() hard-coded parts[2]==='slack'. Generalized
 *   Case 2 to isCanonicalDm() matching ANY channel (whatsapp, telegram, line, etc.).
 *   triggerSlackDmBilling() now extracts channel_type from session key parts[2]
 *   and uses it in /hooks/outbound + verify fallback.
 *
 * v4.1 (2026-04-21): Extend to ALL session types. The message:sent hook
 * is unreliable for most session types since openclaw 2026.4.9. Now handles:
 *   - Legacy 4-seg DMs: agent:{agentId}:direct:{userId} (WhatsApp/Telegram)
 *   - Slack channel (no thread): agent:{agentId}:slack:channel:{channelId}
 *   - Canonical Slack DM: agent:{agentId}:slack:{teamId}:direct:{userId} (v4)
 *   - Slack channel threads: agent:{agentId}:slack:channel:{channelId}:thread:{ts} (v4)
 *   - Legacy DM threads: agent:{agentId}:direct:{userId}:thread:{ts} (v3)
 *   - Hook sessions: hook:agentmail:... (v2)
 *
 * v3 (2026-04-17): Accept ALL DM thread sessions (not just Slack user IDs).
 * Add verify+increment fallback for sessions where display names are used
 * instead of Slack user IDs (e.g. "ali" vs "U03CXKG0SCE").
 *
 * v2 (2026-04-10): For Slack DM thread sessions, also directly trigger billing
 * via /hooks/outbound since the message:sent internal hook isn't firing for
 * these sessions after openclaw 2026.4.9 update.
 *
 * Cache uses 5-minute TTL to prevent memory leaks from orphaned sessions.
 *
 * Created: 2026-04-03
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_KEY = '__billingUsageCache';
const POCO_API_URL = process.env.POCO_API_URL || 'http://127.0.0.1:3012';
const POCO_API_KEY = process.env.POCO_API_KEY || '';

// Track which sessions have been billed to avoid duplicate billing
// Key: sessionKey, Value: timestamp when billed
const BILLED_KEY = '__billingBilledSessions';
if (!globalThis[BILLED_KEY]) {
  globalThis[BILLED_KEY] = new Map();
}
// Track pending billing timeouts to allow cancellation if relay handles it
const PENDING_KEY = '__billingPendingTimeouts';
if (!globalThis[PENDING_KEY]) {
  globalThis[PENDING_KEY] = new Map();
}

// Ensure global cache exists
if (!globalThis[CACHE_KEY]) {
  globalThis[CACHE_KEY] = new Map();
}

function getCache() {
  if (!globalThis[CACHE_KEY]) {
    globalThis[CACHE_KEY] = new Map();
  }
  return globalThis[CACHE_KEY];
}

function evictStale() {
  const cache = getCache();
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  // Also evict billed tracking after TTL
  const billed = globalThis[BILLED_KEY];
  if (billed) {
    for (const [key, ts] of billed) {
      if (now - ts > CACHE_TTL_MS) {
        billed.delete(key);
      }
    }
  }
}

// Detect hook-based sessions (agentmail, gmail, briefing etc.)
function isHookSession(sessionKey) {
  if (!sessionKey) return false;
  return sessionKey.startsWith('hook:');
}

// Detect DM thread sessions: agent:{agentId}:direct:{userId}:thread:{ts}
// v3: Accept ALL DM thread sessions, not just Slack user IDs.
function isDmThreadSession(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  if (parts.length !== 6) return false;
  if (parts[0] !== 'agent' || parts[2] !== 'direct' || parts[4] !== 'thread') return false;
  return !!parts[3]; // just needs a non-empty userId
}

// v4: Canonical Slack DM: agent:{agentId}:slack:{teamId}:direct:{userId}
function isSlackCanonicalDm(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  return parts.length === 6 && parts[0] === 'agent' && parts[2] === 'slack' && parts[4] === 'direct';
}

// v4.2: Canonical DM for ANY channel: agent:{agentId}:{channel}:{accountId}:direct:{userId}
// Matches WhatsApp, Telegram, LINE, etc. — not just Slack.
function isCanonicalDm(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  return parts.length === 6 && parts[0] === 'agent' && parts[4] === 'direct';
}

// v4: Slack channel thread: agent:{agentId}:slack:channel:{channelId}:thread:{ts}
function isSlackChannelThread(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  return parts.length >= 7 && parts[0] === 'agent' && parts[2] === 'slack' && parts[3] === 'channel' && parts[5] === 'thread';
}

// v4.1: Legacy 4-seg DM: agent:{agentId}:direct:{userId}
// WhatsApp/Telegram DMs where message:sent doesn't fire.
// Excludes DM thread keys (6 segments) which are handled separately.
function isLegacy4SegDm(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  return parts.length === 4 && parts[0] === 'agent' && parts[2] === 'direct' && !!parts[3];
}

// v4.1: Slack channel without thread: agent:{agentId}:slack:channel:{channelId}
function isSlackChannelNoThread(sessionKey) {
  if (!sessionKey) return false;
  const parts = sessionKey.split(':');
  return parts.length === 5 && parts[0] === 'agent' && parts[2] === 'slack' && parts[3] === 'channel' && !!parts[4];
}

// Check if the userId in a DM thread key is a Slack user ID format
function isSlackUserId(userId) {
  return userId && /^u[0-9a-z]+$/i.test(userId);
}

// Normalize Slack DM thread key to canonical format for billing lookup
function normalizeSlackDmThreadKey(sessionKey, accountId) {
  const parts = sessionKey.split(':');
  const agentId = parts[1];
  const userId = parts[3];
  const acct = accountId || 'default';
  return `agent:${agentId}:slack:${acct}:direct:${userId}`;
}

// HTTP helper — use top-level require like the original v2 plugin
const http = require('http');
const { URL: NodeURL } = require('url');

function httpRequest(url, method, body, headers) {
  return new Promise((resolve) => {
    try {
      const urlObj = new NodeURL(url);
      const data = body ? JSON.stringify(body) : undefined;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port ? parseInt(urlObj.port) : 80,
        path: urlObj.pathname,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
        timeout: 5000,
      };

      const req = http.request(options, (res) => {
        let buf = '';
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
          catch (e) {
            console.log('[billing-usage-tracker] httpRequest JSON parse error:', e.message, 'buf:', buf.substring(0, 200));
            resolve(null);
          }
        });
      });
      req.on('error', (err) => {
        console.log('[billing-usage-tracker] httpRequest error:', err.message, 'url:', url);
        resolve(null);
      });
      req.on('timeout', () => {
        console.log('[billing-usage-tracker] httpRequest timeout:', url);
        req.destroy();
        resolve(null);
      });
      if (data) req.write(data);
      req.end();
    } catch (err) {
      console.log('[billing-usage-tracker] httpRequest exception:', err.message, 'url:', url);
      resolve(null);
    }
  });
}

// Direct billing trigger for legacy DM threads (workaround for missing message:sent hook)
//
// Strategy:
//   1. Always try /hooks/outbound with canonical session key first.
//   2. NEVER call /api/poco/verify with display names — verify auto-creates
//      channel_connections and can bind display names to the wrong workspace.
async function triggerDmBilling(sessionKey, accountId, usage, logger) {
  if (!POCO_API_KEY) {
    logger.warn('billing-usage-tracker: direct billing skipped - no POCO_API_KEY');
    return;
  }

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);

  // Skip if billed within last 30 seconds (dedup window for same turn)
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: direct billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const parts = sessionKey.split(':');
  const userId = parts[3];
  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };
  const canonicalKey = normalizeSlackDmThreadKey(sessionKey, accountId);

  const senderId = isSlackUserId(userId) ? `user:${userId.toUpperCase()}` : userId;
  logger.info(`billing-usage-tracker: attempting /hooks/outbound for DM: raw=${sessionKey} canonical=${canonicalKey}`);

  const result = await httpRequest(
    `${POCO_API_URL}/hooks/outbound`,
    'POST',
    {
      session_key: canonicalKey,
      sender_id: senderId,
      message: '',
      channel_type: 'slack',
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (result?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: /hooks/outbound SUCCESS: session=${canonicalKey} remaining=${result.data.credits_remaining} deducted=${result.data.credits_deducted || 1}`);
    billed.set(sessionKey, Date.now());
    const cache = getCache();
    cache.delete(sessionKey);
    return;
  }

  // Path B: verify+increment — ONLY safe for platform IDs
  if (isSlackUserId(userId) || /^\+?\d{7,}$/.test(userId)) {
    logger.info(`billing-usage-tracker: /hooks/outbound miss, trying verify+increment for platform ID: ${userId}`);

    try {
      const verifyPayload = { channel: 'slack', sender_id: userId };
      if (accountId) verifyPayload.account_id = accountId;

      const verifyResult = await httpRequest(
        `${POCO_API_URL}/api/poco/verify`,
        'POST',
        verifyPayload,
        authHeaders
      );

      if (verifyResult?.data?.workspace_id) {
        const { workspace_id } = verifyResult.data;

        const incrementResult = await httpRequest(
          `${POCO_API_URL}/api/poco/usage/increment/internal`,
          'POST',
          {
            workspace_id,
            direction: 'outbound',
            channel_type: 'slack',
            sender_id: userId,
            ...(usage ? { token_usage: usage } : {}),
          },
          authHeaders
        );

        if (incrementResult?.data?.credits_remaining !== undefined) {
          logger.info(`billing-usage-tracker: verify+increment SUCCESS: workspace=${workspace_id} remaining=${incrementResult.data.credits_remaining}`);
          billed.set(sessionKey, Date.now());
          const cache = getCache();
          cache.delete(sessionKey);
          return;
        }
      }
    } catch (err) {
      logger.warn(`billing-usage-tracker: verify+increment exception: ${err.message}`);
    }
  }

  logger.warn(`billing-usage-tracker: all billing paths failed for ${sessionKey} (userId=${userId} is display name, verify skipped to prevent misrouting)`);
}

// v4: Direct billing for canonical Slack DM sessions
// Key format: agent:{agentId}:slack:{teamId}:direct:{userId}
// v4.2: Also handles non-Slack canonical DMs (WhatsApp, Telegram, LINE, etc.)
async function triggerSlackDmBilling(sessionKey, usage, logger) {
  if (!POCO_API_KEY) return;

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: canonical DM billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };
  const parts = sessionKey.split(':');
  const channelType = parts[2]; // slack, whatsapp, telegram, line, etc.
  const userId = parts[5];
  const senderId = isSlackUserId(userId) ? `user:${userId.toUpperCase()}` : userId;

  logger.info(`billing-usage-tracker: attempting /hooks/outbound for canonical DM (${channelType}): ${sessionKey}`);

  const result = await httpRequest(
    `${POCO_API_URL}/hooks/outbound`,
    'POST',
    {
      session_key: sessionKey,
      sender_id: senderId,
      message: '',
      channel_type: channelType,
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (result?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: canonical DM billing SUCCESS (${channelType}): session=${sessionKey} remaining=${result.data.credits_remaining} deducted=${result.data.credits_deducted || 1}`);
    billed.set(sessionKey, Date.now());
    getCache().delete(sessionKey);
    return;
  }

  // Fallback: verify+increment for platform user IDs only
  if (isSlackUserId(userId) || /^\+?\d{7,}$/.test(userId)) {
    logger.info(`billing-usage-tracker: canonical DM /hooks/outbound miss, trying verify+increment: ${userId}`);
    try {
      const accountId = parts[3];
      const verifyResult = await httpRequest(
        `${POCO_API_URL}/api/poco/verify`,
        'POST',
        { channel: channelType, sender_id: userId, account_id: accountId },
        authHeaders
      );
      if (verifyResult?.data?.workspace_id) {
        const incrementResult = await httpRequest(
          `${POCO_API_URL}/api/poco/usage/increment/internal`,
          'POST',
          { workspace_id: verifyResult.data.workspace_id, direction: 'outbound', channel_type: channelType, sender_id: userId, ...(usage ? { token_usage: usage } : {}) },
          authHeaders
        );
        if (incrementResult?.data?.credits_remaining !== undefined) {
          logger.info(`billing-usage-tracker: canonical DM verify+increment SUCCESS: workspace=${verifyResult.data.workspace_id} remaining=${incrementResult.data.credits_remaining}`);
          billed.set(sessionKey, Date.now());
          getCache().delete(sessionKey);
          return;
        }
      }
    } catch (err) {
      logger.warn(`billing-usage-tracker: canonical DM verify+increment exception: ${err.message}`);
    }
  }

  logger.warn(`billing-usage-tracker: canonical DM billing failed for ${sessionKey}`);
}

// v4: Direct billing for Slack channel thread sessions via group-billing API
// Key format: agent:{agentId}:slack:channel:{channelId}:thread:{ts}
async function triggerChannelThreadBilling(sessionKey, usage, logger) {
  if (!POCO_API_KEY) return;

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: channel thread billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };
  const parts = sessionKey.split(':');
  const channelId = parts[4].toUpperCase(); // Fix lowercased channelId to match group-billing registry

  logger.info(`billing-usage-tracker: attempting group-billing for channel thread: channelId=${channelId} session=${sessionKey}`);

  // Step 1: Get payer for this channel
  const payerResult = await httpRequest(
    `${POCO_API_URL}/api/poco/group-billing/slack/${encodeURIComponent(channelId)}`,
    'GET',
    null,
    authHeaders
  );

  if (!payerResult || payerResult.status === 404 || !payerResult.data?.payerWorkspaceId) {
    logger.warn(`billing-usage-tracker: no payer for channel ${channelId} - skipping`);
    return;
  }

  if (payerResult.data.status === 'exhausted') {
    logger.warn(`billing-usage-tracker: channel ${channelId} credits exhausted`);
    return;
  }

  // Step 2: Deduct from payer workspace
  const incrementResult = await httpRequest(
    `${POCO_API_URL}/api/poco/usage/increment/internal`,
    'POST',
    {
      workspace_id: payerResult.data.payerWorkspaceId,
      direction: 'outbound',
      channel_type: 'slack',
      group_id: channelId,
      group_platform: 'slack',
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (incrementResult?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: channel thread billing SUCCESS: workspace=${payerResult.data.payerWorkspaceId} channel=${channelId} remaining=${incrementResult.data.credits_remaining}`);
    billed.set(sessionKey, Date.now());
    getCache().delete(sessionKey);
  } else {
    logger.warn(`billing-usage-tracker: channel thread billing failed for ${sessionKey} channel=${channelId}`);
  }
}

// v4.1: Direct billing for legacy 4-segment DM sessions
// Key format: agent:{agentId}:direct:{userId}
// Detects channel from context or defaults based on userId format
async function triggerLegacy4SegDmBilling(sessionKey, accountId, channel, usage, logger) {
  if (!POCO_API_KEY) return;

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: legacy DM billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };
  const parts = sessionKey.split(':');
  const agentId = parts[1];
  const userId = parts[3];
  const acct = accountId || 'default';

  // Build canonical key: agent:{agentId}:{channel}:{accountId}:direct:{userId}
  const VALID_CHANNELS = ['whatsapp', 'telegram', 'slack', 'line', 'discord'];
  const ch = (channel && VALID_CHANNELS.includes(channel)) ? channel : 'whatsapp';
  const canonicalKey = `agent:${agentId}:${ch}:${acct}:direct:${userId}`;

  logger.info(`billing-usage-tracker: attempting /hooks/outbound for legacy DM: raw=${sessionKey} canonical=${canonicalKey}`);

  const result = await httpRequest(
    `${POCO_API_URL}/hooks/outbound`,
    'POST',
    {
      session_key: canonicalKey,
      sender_id: userId,
      message: '',
      channel_type: ch,
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (result?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: legacy DM billing SUCCESS: session=${canonicalKey} remaining=${result.data.credits_remaining} deducted=${result.data.credits_deducted || 1}`);
    billed.set(sessionKey, Date.now());
    getCache().delete(sessionKey);
    return;
  }

  // Fallback: verify+increment (only for phone numbers/platform IDs, not display names)
  if (/^\+?\d{7,}$/.test(userId) || isSlackUserId(userId)) {
    logger.info(`billing-usage-tracker: legacy DM /hooks/outbound miss, trying verify+increment: ${userId}`);
    try {
      const verifyPayload = { channel: ch, sender_id: userId };
      if (accountId) verifyPayload.account_id = accountId;
      const verifyResult = await httpRequest(`${POCO_API_URL}/api/poco/verify`, 'POST', verifyPayload, authHeaders);
      if (verifyResult?.data?.workspace_id && verifyResult?.data?.session_token) {
        const incrementResult = await httpRequest(
          `${POCO_API_URL}/api/poco/usage/increment/internal`,
          'POST',
          { workspace_id: verifyResult.data.workspace_id, direction: 'outbound', channel_type: ch, sender_id: userId, ...(usage ? { token_usage: usage } : {}) },
          authHeaders
        );
        if (incrementResult?.data?.credits_remaining !== undefined) {
          logger.info(`billing-usage-tracker: legacy DM verify+increment SUCCESS: workspace=${verifyResult.data.workspace_id} remaining=${incrementResult.data.credits_remaining}`);
          billed.set(sessionKey, Date.now());
          getCache().delete(sessionKey);
          return;
        }
      }
    } catch (err) {
      logger.warn(`billing-usage-tracker: legacy DM verify+increment exception: ${err.message}`);
    }
  }

  logger.warn(`billing-usage-tracker: legacy DM billing failed for ${sessionKey}`);
}

// v4.1: Direct billing for Slack channel sessions (non-thread) via group-billing API
// Key format: agent:{agentId}:slack:channel:{channelId}
async function triggerSlackChannelBilling(sessionKey, usage, logger) {
  if (!POCO_API_KEY) return;

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: Slack channel billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };
  const parts = sessionKey.split(':');
  const channelId = parts[4].toUpperCase();

  logger.info(`billing-usage-tracker: attempting group-billing for Slack channel: channelId=${channelId} session=${sessionKey}`);

  const payerResult = await httpRequest(
    `${POCO_API_URL}/api/poco/group-billing/slack/${encodeURIComponent(channelId)}`,
    'GET',
    null,
    authHeaders
  );

  if (!payerResult || payerResult.status === 404 || !payerResult.data?.payerWorkspaceId) {
    logger.warn(`billing-usage-tracker: no payer for Slack channel ${channelId} - skipping`);
    return;
  }

  if (payerResult.data.status === 'exhausted') {
    logger.warn(`billing-usage-tracker: Slack channel ${channelId} credits exhausted`);
    return;
  }

  const incrementResult = await httpRequest(
    `${POCO_API_URL}/api/poco/usage/increment/internal`,
    'POST',
    {
      workspace_id: payerResult.data.payerWorkspaceId,
      direction: 'outbound',
      channel_type: 'slack',
      group_id: channelId,
      group_platform: 'slack',
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (incrementResult?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: Slack channel billing SUCCESS: workspace=${payerResult.data.payerWorkspaceId} channel=${channelId} remaining=${incrementResult.data.credits_remaining}`);
    billed.set(sessionKey, Date.now());
    getCache().delete(sessionKey);
  } else {
    logger.warn(`billing-usage-tracker: Slack channel billing failed for ${sessionKey} channel=${channelId}`);
  }
}


// =============================================================================
// v5.0 (2026-04-27): Group-chat billing for non-Slack platforms
// =============================================================================
// Session keys: agent:{agentId}:{platform}:group:{groupId}
//   platform in { whatsapp, line, telegram, sendblue, imessage }
//
// Mirrors the Slack channel billing flow: lookup payer via group-billing API,
// then increment usage. Slack already uses :channel: (its own path); these 5
// platforms use :group: which had no billing branch until now.
//
// Per spec v0.2 section 3a (state machine): only the active+credits and
// active+grace branches are implemented in v1. exhausted/missing fall back
// to today's silent-skip behavior. v1.5 will add the in-channel
// "this group isn't billed yet" user-facing message via the message_sending
// hook, which requires OpenClaw v2026.4.24.

const GROUP_PLATFORMS = ['whatsapp', 'line', 'telegram', 'sendblue', 'imessage'];

function parseGroupSession(sessionKey) {
  // agent:chief-of-staff:whatsapp:group:120363407927167557@g.us
  // agent:chief-of-staff:line:group:Cabc...
  // agent:chief-of-staff:telegram:group:-1001234567890
  // agent:chief-of-staff:sendblue:group:sb_group_xxx
  // agent:chief-of-staff:imessage:group:xxx
  const parts = sessionKey.split(':');
  if (parts.length < 5) return null;
  if (parts[0] !== 'agent') return null;
  const platform = parts[2];
  if (!GROUP_PLATFORMS.includes(platform)) return null;
  if (parts[3] !== 'group') return null;
  // groupId is parts[4..end] joined back (handles JIDs with colons defensively)
  const groupId = parts.slice(4).join(':');
  if (!groupId) return null;
  return { platform, groupId };
}

async function triggerGroupBilling(sessionKey, platform, groupId, usage, logger) {
  if (!POCO_API_KEY) return;

  const billed = globalThis[BILLED_KEY];
  const now = Date.now();
  const lastBilled = billed.get(sessionKey);
  if (lastBilled && (now - lastBilled) < 30000) {
    logger.info(`billing-usage-tracker: ${platform} group billing skipped for ${sessionKey} - already billed ${now - lastBilled}ms ago`);
    return;
  }

  const authHeaders = { 'X-Poco-Service-Key': POCO_API_KEY };

  logger.info(`billing-usage-tracker: attempting group-billing for ${platform} group: groupId=${groupId} session=${sessionKey}`);

  // Step 1: resolve payer workspace via group-billing API (auto-designates on first hit)
  const payerResult = await httpRequest(
    `${POCO_API_URL}/api/poco/group-billing/${encodeURIComponent(platform)}/${encodeURIComponent(groupId)}`,
    'GET',
    null,
    authHeaders
  );

  if (!payerResult || payerResult.status === 404 || !payerResult.data?.payerWorkspaceId) {
    logger.warn(`billing-usage-tracker: no payer for ${platform} group ${groupId} - skipping (state=missing)`);
    return;
  }

  if (payerResult.data.status === 'exhausted') {
    // v1: silent-skip when grace exhausted. v1.5 will send user-facing message via message_sending hook.
    logger.warn(`billing-usage-tracker: ${platform} group ${groupId} credits exhausted (state=exhausted)`);
    return;
  }

  // Step 2: increment usage and log credit transaction with group context
  const incrementResult = await httpRequest(
    `${POCO_API_URL}/api/poco/usage/increment/internal`,
    'POST',
    {
      workspace_id: payerResult.data.payerWorkspaceId,
      direction: 'outbound',
      channel_type: platform,
      group_id: groupId,
      group_platform: platform,
      ...(usage ? { token_usage: usage } : {}),
    },
    authHeaders
  );

  if (incrementResult?.data?.credits_remaining !== undefined) {
    logger.info(`billing-usage-tracker: ${platform} group billing SUCCESS: workspace=${payerResult.data.payerWorkspaceId} group=${groupId} remaining=${incrementResult.data.credits_remaining}`);
    billed.set(sessionKey, Date.now());
    getCache().delete(sessionKey);
  } else {
    logger.warn(`billing-usage-tracker: ${platform} group billing failed for ${sessionKey} group=${groupId}`);
  }
}

var billingUsageTracker = {
  id: 'billing-usage-tracker',
  name: 'Billing Usage Tracker',
  description: 'Captures LLM token usage for dynamic credit billing',
  kind: 'other',

  register(api) {
    api.logger.info('billing-usage-tracker: registered (v4.3 — channel attribution fix)');

    // Capture token usage on every LLM output
    api.on('llm_output', async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;

      const usage = event.usage;
      if (!usage) return;

      const model = event.model
        ? `${event.provider || 'unknown'}/${event.model}`
        : undefined;

      const cache = getCache();

      // Accumulate usage across multiple LLM calls in the same session/turn
      const existing = cache.get(sessionKey);
      const accumulated = {
        model: model || existing?.model || 'default',
        input_tokens: (existing?.input_tokens || 0) + (usage.input || 0),
        output_tokens: (existing?.output_tokens || 0) + (usage.output || 0),
        cached_input_tokens: (existing?.cached_input_tokens || 0) + (usage.cacheRead || 0),
        tts_characters: existing?.tts_characters || 0,
        timestamp: Date.now(),
      };

      cache.set(sessionKey, accumulated);

      api.logger.info(
        `billing-usage-tracker: cached usage for ${sessionKey}: ` +
        `model=${accumulated.model} in=${accumulated.input_tokens} out=${accumulated.output_tokens} cache=${accumulated.cached_input_tokens}`
      );

      // Periodic eviction (every 10th write)
      if (cache.size % 10 === 0) {
        evictStale();
      }

      // --- Direct billing workarounds (message:sent hook not firing) ---

      // Case 1: Legacy DM thread sessions (v3)
      if (isDmThreadSession(sessionKey)) {
        const accountId = ctx?.accountId || 'chief-of-staff';
        const pending = globalThis[PENDING_KEY];

        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering direct billing for DM thread: ${sessionKey}`);
            triggerDmBilling(sessionKey, accountId, finalUsage, api.logger);
          } else {
            api.logger.info(`billing-usage-tracker: direct billing skipped - usage already consumed for ${sessionKey}`);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled direct billing for DM in 2s: ${sessionKey}`);
      }

      // Case 2 (v4/v4.2): Canonical DM sessions (Slack, WhatsApp, Telegram, etc.)
      if (isCanonicalDm(sessionKey)) {
        const pending = globalThis[PENDING_KEY];

        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering billing for canonical DM: ${sessionKey}`);
            triggerSlackDmBilling(sessionKey, finalUsage, api.logger);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled billing for canonical DM in 2s: ${sessionKey}`);
      }

      // Case 3 (v4): Slack channel thread sessions
      if (isSlackChannelThread(sessionKey)) {
        const pending = globalThis[PENDING_KEY];

        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering billing for channel thread: ${sessionKey}`);
            triggerChannelThreadBilling(sessionKey, finalUsage, api.logger);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled billing for channel thread in 2s: ${sessionKey}`);
      }

      // Case 5 (v4.1): Legacy 4-seg DM sessions (WhatsApp/Telegram)
      // message:sent doesn't fire for these either
      if (isLegacy4SegDm(sessionKey)) {
        const pending = globalThis[PENDING_KEY];

        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const accountId = ctx?.accountId || 'default';
        const channel = ctx?.channelId || undefined; // let triggerLegacy4SegDmBilling detect

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering billing for legacy DM: ${sessionKey}`);
            triggerLegacy4SegDmBilling(sessionKey, accountId, channel, finalUsage, api.logger);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled billing for legacy DM in 2s: ${sessionKey}`);
      }

      // Case 6 (v4.1): Slack channel sessions (no thread)
      if (isSlackChannelNoThread(sessionKey)) {
        const pending = globalThis[PENDING_KEY];

        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering billing for Slack channel: ${sessionKey}`);
            triggerSlackChannelBilling(sessionKey, finalUsage, api.logger);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled billing for Slack channel in 2s: ${sessionKey}`);
      }

      // Case 8 (v5.0): Non-Slack group sessions (whatsapp, line, telegram, sendblue, imessage)
      // Mirrors Slack channel billing - schedule a 2s debounced flush, then
      // call triggerGroupBilling which resolves the payer + increments usage.
      const groupSession = parseGroupSession(sessionKey);
      if (groupSession) {
        const pending = globalThis[PENDING_KEY];
        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const finalUsage = cache.get(sessionKey);
          if (finalUsage) {
            api.logger.info(`billing-usage-tracker: triggering group-billing for ${groupSession.platform} group: ${sessionKey}`);
            triggerGroupBilling(sessionKey, groupSession.platform, groupSession.groupId, finalUsage, api.logger);
          }
        }, 2000);

        pending.set(sessionKey, timeoutId);
        api.logger.info(`billing-usage-tracker: scheduled ${groupSession.platform} group-billing in 2s: ${sessionKey}`);
      }

      // Case 7: Hook sessions (agentmail, gmail, etc.)
      if (isHookSession(sessionKey)) {
        const pending = globalThis[PENDING_KEY];
        const existingTimeout = pending.get(sessionKey);
        if (existingTimeout) clearTimeout(existingTimeout);

        const finalUsage = { ...accumulated };
        const timeoutId = setTimeout(() => {
          pending.delete(sessionKey);
          const currentCache = getCache();
          const currentEntry = currentCache.get(sessionKey);
          if (currentEntry && currentEntry.timestamp === finalUsage.timestamp) {
            api.logger.info('billing-usage-tracker: direct billing for hook session: ' + sessionKey);
            triggerDmBilling(sessionKey, 'default', finalUsage, api.logger);
          }
        }, 5000);

        pending.set(sessionKey, timeoutId);
        api.logger.info('billing-usage-tracker: scheduled direct billing for hook session in 5s: ' + sessionKey);
      }
    });

    api.logger.info(`billing-usage-tracker: llm_output hook attached, cache key=${CACHE_KEY}`);
  },
};

export { billingUsageTracker as default };
