// ---------------------------------------------------------------------------
// Webhook Server — receives inbound messages from Sendblue
//
// Sendblue POSTs to our endpoint with header `Sb-Signing-Secret: <secret>`.
// Supports multi-account: routes messages by `to_number` (our Sendblue line)
// to the correct account's handler via the accountRegistry map.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { markAsRead } from "./api.js";
import type { SendblueConfig, SendblueWebhookPayload, Logger } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedInboundMessage {
  /** Sender phone number (E.164 format) */
  from: string;
  /** Our Sendblue line number (E.164 format) */
  to: string;
  /** Extracted text content */
  text: string;
  /** Sendblue message handle (UUID) */
  messageHandle: string;
  /** Message timestamp ISO string */
  dateSent: string;
  /** Service type: "iMessage" | "SMS" | "RCS" */
  service: string;
  /** Media URL if the message contained media */
  mediaUrl?: string;
  /** Group ID if this is a group message */
  groupId?: string;
  /** Group display name */
  groupDisplayName?: string | null;
}

export type InboundMessageHandler = (message: ParsedInboundMessage) => void;
export type StatusUpdateHandler = (messageHandle: string, status: string) => void;

/** Channel-level config for the webhook server (shared across accounts) */
export interface WebhookServerConfig {
  webhookSecret: string;
  webhookPort: number;
  webhookPath: string;
}

/** Per-account registration in the webhook router */
export interface AccountRegistration {
  accountId: string;
  config: SendblueConfig;
  onMessage: InboundMessageHandler;
  onStatus: StatusUpdateHandler;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startWebhookServer(
  serverConfig: WebhookServerConfig,
  accountRegistry: Map<string, AccountRegistration>,
  log: Logger
): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // ----- Incoming webhook events (POST) -----
    if (req.method === "POST" && path === serverConfig.webhookPath) {
      await handleIncoming(req, res, serverConfig, accountRegistry, log);
      return;
    }

    // ----- Health check -----
    if (req.method === "GET" && path === "/health") {
      const accountIds = [...accountRegistry.values()].map((r) => r.accountId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", channel: "sendblue", accounts: accountIds }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(serverConfig.webhookPort, () => {
    log.info(
      `[sendblue] Webhook server listening on port ${serverConfig.webhookPort} at ${serverConfig.webhookPath}`
    );
  });

  server.on("error", (err) => {
    log.error(`[sendblue] Webhook server error: ${err.message}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// POST — process incoming webhook events
// ---------------------------------------------------------------------------

async function handleIncoming(
  req: IncomingMessage,
  res: ServerResponse,
  serverConfig: WebhookServerConfig,
  accountRegistry: Map<string, AccountRegistration>,
  log: Logger
): Promise<void> {
  // Read body
  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;

  // Always respond 200 quickly — Sendblue retries on non-2xx
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");

  // Validate Sb-Signing-Secret header
  if (serverConfig.webhookSecret) {
    const sigHeader = req.headers["sb-signing-secret"] as string | undefined;
    if (!sigHeader || sigHeader !== serverConfig.webhookSecret) {
      log.warn("[sendblue] Webhook signature validation FAILED — ignoring payload");
      return;
    }
  } else {
    log.debug?.("[sendblue] No webhookSecret configured — skipping signature validation (NOT safe for production)");
  }

  // Parse payload
  let payload: SendblueWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SendblueWebhookPayload;
  } catch (err) {
    log.error(`[sendblue] Failed to parse webhook JSON: ${err}`);
    return;
  }

  // Outbound messages and delivery status updates — log only
  if (payload.is_outbound) {
    log.debug?.(`[sendblue] Outbound message status: ${payload.status} handle=${payload.message_handle}`);
    // Route to the account's status handler if registered
    const toNum = normalizePhone(payload.from_number ?? "");
    for (const reg of accountRegistry.values()) {
      if (normalizePhone(reg.config.fromNumber) === toNum) {
        reg.onStatus(payload.message_handle, payload.status);
        break;
      }
    }
    return;
  }

  // Route inbound message to the correct account by matching to_number
  const toNumber = normalizePhone(payload.to_number ?? "");
  let registration: AccountRegistration | undefined;

  for (const reg of accountRegistry.values()) {
    if (normalizePhone(reg.config.fromNumber) === toNumber) {
      registration = reg;
      break;
    }
  }

  if (!registration) {
    // If only one account is registered, route there (single-account convenience)
    if (accountRegistry.size === 1) {
      registration = [...accountRegistry.values()][0];
      log.debug?.(`[sendblue] Single-account mode: routing message for ${payload.to_number} to only registered account`);
    } else {
      log.warn(
        `[sendblue] Received webhook for unregistered to_number: ${payload.to_number} (registered: ${[...accountRegistry.keys()].join(", ")})`
      );
      return;
    }
  }

  const { config, onMessage, accountId } = registration;

  // Access control
  if (config.dmPolicy === "allowlist") {
    const normalized = normalizePhone(payload.from_number);
    const allowed = config.allowFrom.some((n) => normalizePhone(n) === normalized);
    if (!allowed) {
      log.info(`[sendblue:${accountId}] Blocked message from ${payload.from_number} (not in allowlist)`);
      return;
    }
  }

  // Build parsed message
  const parsed: ParsedInboundMessage = {
    from: payload.from_number,
    to: payload.to_number,
    text: payload.content ?? "",
    messageHandle: payload.message_handle,
    dateSent: payload.date_sent,
    service: payload.service ?? "SMS",
    mediaUrl: payload.media_url || undefined,
    groupId: payload.group_id || undefined,
    groupDisplayName: payload.group_display_name ?? undefined,
  };

  log.info(
    `[sendblue:${accountId}] ← ${payload.from_number} (${payload.service}): ${parsed.text.slice(0, 100)}${
      parsed.text.length > 100 ? "…" : ""
    }${parsed.mediaUrl ? " [media]" : ""}${parsed.groupId ? ` [group:${parsed.groupId}]` : ""}`
  );

  // Send read receipt
  if (config.sendReadReceipts && payload.message_handle) {
    markAsRead(config, payload.message_handle, log).catch(() => {});
  }

  // Dispatch to OpenClaw
  onMessage(parsed);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize phone to digits-only for comparison */
function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}
