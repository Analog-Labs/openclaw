// ---------------------------------------------------------------------------
// Sendblue Channel Plugin — Type Definitions
// ---------------------------------------------------------------------------

/** Plugin configuration (stored under channels.sendblue in openclaw.json) */
export interface SendblueConfig {
  enabled: boolean;
  /** Your Sendblue line number in E.164 format */
  fromNumber: string;
  /** Sendblue API key ID (sb-api-key-id header) */
  apiKeyId: string;
  /** Sendblue API secret key (sb-api-secret-key header) */
  apiSecretKey: string;
  /** Port for the local webhook HTTP server */
  webhookPort: number;
  /** URL path for the local webhook endpoint */
  webhookPath: string;
  /** The Sb-Signing-Secret value used to authenticate inbound webhooks */
  webhookSecret: string;
  /** Access control policy */
  dmPolicy: "open" | "allowlist";
  /** E.164 numbers allowed to message the bot when dmPolicy=allowlist */
  allowFrom: string[];
  /** Whether to auto-send read receipts on inbound messages */
  sendReadReceipts: boolean;
}

/** Defaults applied when config values are missing */
export const CONFIG_DEFAULTS: Partial<SendblueConfig> = {
  enabled: true,
  webhookPort: 3008,
  webhookPath: "/hooks/sendblue",
  webhookSecret: "",
  dmPolicy: "open",
  allowFrom: [],
  sendReadReceipts: true,
};

/** Per-account settings */
export interface SendblueAccountConfig {
  enabled: boolean;
  fromNumber: string;
  apiKeyId: string;
  apiSecretKey: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  sendReadReceipts: boolean;
}

/** Defaults for per-account settings */
export const ACCOUNT_DEFAULTS: Partial<SendblueAccountConfig> = {
  enabled: true,
  dmPolicy: "open",
  allowFrom: [],
  sendReadReceipts: true,
};

// ---------------------------------------------------------------------------
// Sendblue Webhook Payload (inbound)
// ---------------------------------------------------------------------------

export interface SendblueWebhookPayload {
  accountEmail: string;
  content: string;
  is_outbound: boolean;
  status: string;
  /** Sender's number (E.164) — who sent us the message */
  from_number: string;
  /** Our Sendblue line number (E.164) */
  to_number: string;
  /** Canonical contact number */
  number: string;
  /** "iMessage" | "SMS" | "RCS" */
  service: string;
  message_handle: string;
  message_type: string;
  media_url?: string;
  group_id?: string;
  group_display_name?: string | null;
  date_sent: string;
  error_code?: string | null;
  error_message?: string | null;
}

// ---------------------------------------------------------------------------
// Sendblue API — Send message request/response
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  number: string;
  content: string;
  from_number: string;
  media_url?: string;
  send_style?: string;
  status_callback?: string;
}

export interface SendMessageResponse {
  accountEmail: string;
  content: string;
  is_outbound: boolean;
  status: string;
  error_code: string | null;
  error_message: string | null;
  message_handle: string;
  date_sent: string;
  date_updated: string;
  from_number: string;
  number: string;
  to_number: string;
  was_downgraded: boolean | null;
  plan: string;
}

export interface EvaluateServiceResponse {
  number: string;
  service: string;
}

export interface ApiErrorResponse {
  error_code?: string;
  error_message?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Plugin internal types
// ---------------------------------------------------------------------------

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface SendResult {
  ok: boolean;
  messageHandle?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sendblue API — Send group message request
// ---------------------------------------------------------------------------

export interface SendGroupMessageRequest {
  group_id: string;
  content: string;
  from_number: string;
  media_url?: string;
}
