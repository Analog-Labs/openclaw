// ---------------------------------------------------------------------------
// OpenClaw Channel Plugin — Sendblue (iMessage / SMS / RCS)
//
// Receives inbound messages via Sendblue webhooks, dispatches them through
// OpenClaw's reply system, and sends outbound messages via Sendblue API.
//
// Modeled after openclaw-whatsapp-cloud-api plugin architecture.
// Recovered + rebuilt 2026-03-31 after accidental deletion.
// ---------------------------------------------------------------------------

import type { Server } from "node:http";
import { sendText, sendMedia, sendGroupText, sendGroupMedia, sendTypingIndicator } from "./api.js";
import { startWebhookServer } from "./webhook.js";
import type { AccountRegistration, WebhookServerConfig, ParsedInboundMessage } from "./webhook.js";
import type { SendblueConfig, Logger } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeChannelConfig,
  resolveAccountConfig,
} from "./config.js";
import { setSendblueRuntime, getSendblueRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Account resolution types
// ---------------------------------------------------------------------------

interface ResolvedSendblueAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: SendblueConfig;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const accountRegistry = new Map<string, AccountRegistration>();
let webhookServer: Server | null = null;
let activeWebhookConfig: WebhookServerConfig | null = null;

// ---------------------------------------------------------------------------
// Channel plugin definition
// ---------------------------------------------------------------------------


// --- v6 billing patch: emit message:sent internal hook after delivery ---
let _triggerHook: any = null;
let _createHookEvent: any = null;
async function emitMessageSentHook(sessionKey: string, context: any) {
    try {
        if (!_triggerHook) {
            // @ts-ignore - dynamic import, no .d.ts ships with openclaw dist
            const mod: any = await import("/usr/lib/node_modules/openclaw/dist/internal-hooks-2legcEEL.js");
            _triggerHook = mod.m;       // triggerInternalHook (was mod.p in <4.12)
            _createHookEvent = mod.n;   // createInternalHookEvent
        }
        if (_triggerHook && _createHookEvent) {
            await _triggerHook(_createHookEvent("message", "sent", sessionKey, context));
        }
    } catch (e) {
        // Fail silently
    }
}
// --- end billing patch ---

const sendblueChannel = {
  id: "sendblue" as string,

  meta: {
    id: "sendblue" as string,
    label: "Sendblue",
    selectionLabel: "Sendblue (iMessage / SMS / RCS)",
    docsPath: "/channels/sendblue",
    docsLabel: "sendblue",
    blurb: "iMessage, SMS, and RCS via Sendblue cloud API. No Mac server needed.",
    aliases: ["imessage", "sms", "rcs"],
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
    media: true,
    blockStreaming: true,
  },


  messaging: {
    targetResolver: {
      hint: "Use a phone number (+1234567890) or group ID (sb_group_...)",
      looksLikeId: (raw: string, _normalized: string): boolean => {
        const trimmed = raw.trim();
        if (/^\+?\d{6,}$/.test(trimmed)) return true;
        if (trimmed.startsWith("sb_group_")) return true;
        return false;
      },
      resolveTarget: async ({ input, normalized }: {
        cfg: any; accountId?: string; input: string; normalized: string; preferredKind?: string;
      }): Promise<{ to: string; kind: string; display: string } | null> => {
        const trimmed = (normalized || input).trim();
        if (trimmed.startsWith("sb_group_")) {
          return { to: trimmed, kind: "group", display: trimmed };
        }
        if (/^\+?\d{6,}$/.test(trimmed)) {
          return { to: trimmed, kind: "user", display: trimmed };
        }
        return null;
      },
    },
  },

  actions: {
    describeMessageTool: (): { actions: string[] } => {
      return { actions: ["upload-file", "sendAttachment"] };
    },
    supportsAction: ({ action }: { action: string }): boolean => {
      return ["upload-file", "sendAttachment"].includes(action);
    },
    handleAction: async (ctx: any): Promise<any> => {
      const config = resolveAccountConfig(ctx.cfg, ctx.accountId ?? DEFAULT_ACCOUNT_ID);
      const log: Logger = getSendblueRuntime()?.logging?.getChildLogger?.({ channel: "sendblue" }) ?? (console as unknown as Logger);

      const target: string = ctx.params.to ?? ctx.params.target ?? "";
      const recipient = target.replace(/^sendblue:/, "");
      const isGroup = recipient.startsWith("sb_group_");

      const mediaUrl: string | undefined =
        ctx.params.media ?? ctx.params.mediaUrl ?? ctx.params.path ?? ctx.params.filePath ?? ctx.params.fileUrl;
      const text: string = ctx.params.message ?? ctx.params.content ?? ctx.params.caption ?? "";

      if (!mediaUrl) return { error: "upload-file requires media" };

      const result = isGroup
        ? await sendGroupMedia(config, recipient, mediaUrl, text, log)
        : await sendMedia(config, recipient, mediaUrl, text, log);
      if (!result.ok) throw new Error("Sendblue media send failed: " + result.error);
      return { ok: true, channel: "sendblue", action: ctx.action, messageId: result.messageHandle ?? "unknown" };
    },
  },
  reload: { configPrefixes: ["channels.sendblue"] },

  config: {
    listAccountIds: (cfg: any): string[] => {
      const channelCfg = cfg?.channels?.["sendblue"] ?? {};
      if (channelCfg.enabled === false) return [];
      const { accounts } = normalizeChannelConfig(channelCfg);
      return Object.keys(accounts).filter(
        (id) => accounts[id].enabled !== false
      );
    },

    resolveAccount: (cfg: any, accountId?: string | null): ResolvedSendblueAccount => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const config = resolveAccountConfig(cfg, aid);
      return {
        accountId: aid,
        enabled: config.enabled,
        config,
      };
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const account: ResolvedSendblueAccount = ctx.account;
      const config = account.config;
      const log: Logger = ctx.log ?? (console as unknown as Logger);
      const runtime = getSendblueRuntime();

      if (!config.enabled) {
        log.info(`[sendblue:${account.accountId}] Account is disabled`);
        return;
      }

      if (!config.apiKeyId || !config.apiSecretKey || !config.fromNumber) {
        log.error(
          `[sendblue:${account.accountId}] Missing required config (apiKeyId, apiSecretKey, or fromNumber)`
        );
        return;
      }

      // Build per-account message handler
      const onMessage = async (message: ParsedInboundMessage) => {
        try {
          // Send typing indicator
          sendTypingIndicator(config, message.from, log).catch(() => {});

          // Load fresh config
          const freshCfg = await runtime.config.loadConfig();
          const freshConfig = resolveAccountConfig(freshCfg, account.accountId);

          // Build session key
          const cfgAgentId =
            (config as any).agentId ??
            (freshCfg as any)?.channels?.["sendblue"]?.agentId;

          const isGroup = Boolean(message.groupId);

          const accountId = account.accountId || "default";

          const sessionKey = cfgAgentId
            ? isGroup
              ? `agent:${cfgAgentId}:sendblue:${accountId}:group:${message.groupId}`
              : `agent:${cfgAgentId}:sendblue:${accountId}:direct:${message.from}`
            : isGroup
              ? `sendblue:${accountId}:group:${message.groupId}`
              : `sendblue:${accountId}:direct:${message.from}`;

          // Build MsgContext
          const msgCtx: Record<string, any> = {
            Body: message.text,
            RawBody: message.text,
            CommandBody: message.text,
            BodyForCommands: message.text,
            From: `sendblue:${message.from}`,
            To: config.fromNumber,
            SessionKey: sessionKey,
            AccountId: account.accountId,
            MessageSid: message.messageHandle,
            ChatType: isGroup ? "group" : "direct",
            ...(isGroup ? { GroupId: message.groupId, GroupName: message.groupDisplayName ?? message.groupId } : {}),
            SenderName: message.from,
            SenderId: message.from,
            Provider: "sendblue",
            OriginatingChannel: "sendblue",
            OriginatingTo: isGroup ? message.groupId! : message.from,
            Timestamp: message.dateSent ? new Date(message.dateSent).getTime() : Date.now(),
          };

          if (cfgAgentId) {
            (msgCtx as any).agentId = cfgAgentId;
          }

          // Dispatch via OpenClaw's reply system
          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: msgCtx,
            cfg: freshCfg,
            dispatcherOptions: {
              deliver: async (payload: any) => {
                if (payload.text) {
                  const textResult = isGroup
                    ? await sendGroupText(freshConfig, message.groupId!, payload.text, log)
                    : await sendText(freshConfig, message.from, payload.text, log);
                  if (!textResult.ok) {
                    throw new Error(`Sendblue deliver failed: ${textResult.error}`);
                  }
                }
                if (payload.mediaUrl) {
                  const mediaResult = isGroup
                    ? await sendGroupMedia(freshConfig, message.groupId!, payload.mediaUrl, "", log)
                    : await sendMedia(freshConfig, message.from, payload.mediaUrl, "", log);
                  if (!mediaResult.ok) {
                    throw new Error(`Sendblue media deliver failed: ${mediaResult.error}`);
                  }
                }
                if (payload.mediaUrls?.length) {
                  for (const url of payload.mediaUrls) {
                    const r = isGroup
                      ? await sendGroupMedia(freshConfig, message.groupId!, url, "", log)
                      : await sendMedia(freshConfig, message.from, url, "", log);
                    if (!r.ok) {
                      throw new Error(`Sendblue media deliver failed: ${r.error}`);
                    }
                  }
                }
                // --- v6 billing patch: emit message:sent hook ---
                emitMessageSentHook(sessionKey, {
                    to: isGroup ? message.groupId! : message.from,
                    content: payload.text || payload.mediaUrl || '',
                    message: payload.text || payload.mediaUrl || '',
                    success: true,
                    channelId: 'sendblue',
                    accountId: accountId,
                    conversationId: isGroup ? message.groupId! : message.from,
                }).catch(() => {});
              },
              onReplyStart: () => {
                log.info(
                  `[sendblue:${account.accountId}] Generating reply for ${message.from} (${message.service})${isGroup ? " [group:" + message.groupId + "]" : ""}`
                );
              },
            },
          });
        } catch (err) {
          log.error(
            `[sendblue:${account.accountId}] Failed to dispatch inbound message: ${err}`
          );
        }
      };

      // Status update handler
      const onStatus = (messageHandle: string, status: string) => {
        log.debug?.(
          `[sendblue:${account.accountId}] Status: ${status} for ${messageHandle}`
        );
      };

      // Register this account
      accountRegistry.set(account.accountId, {
        accountId: account.accountId,
        config,
        onMessage,
        onStatus,
      });

      // Start webhook server (singleton)
      if (!webhookServer) {
        const serverConfig: WebhookServerConfig = {
          webhookSecret: config.webhookSecret,
          webhookPort: config.webhookPort,
          webhookPath: config.webhookPath,
        };
        webhookServer = startWebhookServer(serverConfig, accountRegistry, log);
        activeWebhookConfig = serverConfig;
      }

      log.info(
        `[sendblue:${account.accountId}] Account started (line: ${config.fromNumber})`
      );
      log.info(
        `[sendblue:${account.accountId}]   Webhook: http://localhost:${activeWebhookConfig?.webhookPort ?? config.webhookPort}${config.webhookPath}`
      );
      log.info(`[sendblue:${account.accountId}]   DM Policy: ${config.dmPolicy}`);

      // Update runtime status
      if (typeof ctx.setStatus === "function") {
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lastStartAt: Date.now(),
          mode: "webhook",
        });
      }

      // Keep alive until abort
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) return resolve();
        ctx.abortSignal?.addEventListener("abort", resolve);
      });
    },

    logoutAccount: async ({ accountId }: { accountId: string }) => {
      accountRegistry.delete(accountId);
      if (accountRegistry.size === 0 && webhookServer) {
        webhookServer.close();
        webhookServer = null;
        activeWebhookConfig = null;
      }
    },
  },

  // ---- Outbound ----
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 1600,

    sendText: async ({ cfg, to, text, accountId }: {
      cfg: any;
      to: string;
      text: string;
      accountId?: string | null;
    }) => {
      const config = resolveAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      const log: Logger = getSendblueRuntime()?.logging?.getChildLogger?.({ channel: "sendblue" }) ?? console as unknown as Logger;
      const recipient = to.replace("sendblue:", "");
      const isGroupTarget = recipient.startsWith("sb_group_");
      const result = isGroupTarget
        ? await sendGroupText(config, recipient, text, log)
        : await sendText(config, recipient, text, log);
      if (!result.ok) throw new Error(`Sendblue send failed: ${result.error}`);
      return { channel: "sendblue" as any, messageId: result.messageHandle ?? "unknown", chatId: recipient };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, asVoice }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
      asVoice?: boolean;
    }) => {
      const config = resolveAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
      const log: Logger = getSendblueRuntime()?.logging?.getChildLogger?.({ channel: "sendblue" }) ?? console as unknown as Logger;
      const recipient = to.replace("sendblue:", "");
      const isGroupTarget = recipient.startsWith("sb_group_");
      if (mediaUrl) {
        const result = isGroupTarget
          ? await sendGroupMedia(config, recipient, mediaUrl, text || "", log)
          : await sendMedia(config, recipient, mediaUrl, text || "", log);
        if (!result.ok) throw new Error(`Sendblue media send failed: ${result.error}`);
        return { channel: "sendblue" as any, messageId: result.messageHandle ?? "unknown", chatId: recipient };
      }
      const result = isGroupTarget
        ? await sendGroupText(config, recipient, text, log)
        : await sendText(config, recipient, text, log);
      if (!result.ok) throw new Error(`Sendblue send failed: ${result.error}`);
      return { channel: "sendblue" as any, messageId: result.messageHandle ?? "unknown", chatId: recipient };
    },
  },
};

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  id: "openclaw-sendblue",
  name: "Sendblue",
  description: "Sendblue iMessage/SMS/RCS channel plugin for OpenClaw",

  register(api: any) {
    const log: Logger = api.logger ?? (console as unknown as Logger);
    log.info("[sendblue] Loading Sendblue channel plugin");

    setSendblueRuntime(api.runtime);
    api.registerChannel({ plugin: sendblueChannel });

    log.info("[sendblue] Plugin registered");
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { sendText, sendMedia, sendGroupText, sendGroupMedia, sendTypingIndicator, markAsRead } from "./api.js";
export type { SendblueConfig } from "./types.js";
export type { ParsedInboundMessage } from "./webhook.js";
export { resolveAccountConfig, normalizeChannelConfig, DEFAULT_ACCOUNT_ID } from "./config.js";
