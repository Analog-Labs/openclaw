// ---------------------------------------------------------------------------
// Sendblue API Client
// Handles all outbound communication with api.sendblue.co
// ---------------------------------------------------------------------------

import type {
  SendblueConfig,
  SendResult,
  SendMessageRequest,
  SendGroupMessageRequest,
  SendMessageResponse,
  EvaluateServiceResponse,
  ApiErrorResponse,
  Logger,
} from "./types.js";

const API_BASE = "https://api.sendblue.co";

function headers(config: SendblueConfig): Record<string, string> {
  return {
    "sb-api-key-id": config.apiKeyId,
    "sb-api-secret-key": config.apiSecretKey,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Send text message
// ---------------------------------------------------------------------------

export async function sendText(
  config: SendblueConfig,
  to: string,
  text: string,
  log: Logger
): Promise<SendResult> {
  const chunks = splitMessage(text, 1600);
  let lastResult: SendResult = { ok: false, error: "No chunks" };

  for (const chunk of chunks) {
    const body: SendMessageRequest = {
      number: to,
      content: chunk,
      from_number: config.fromNumber,
    };
    lastResult = await sendRequest(config, body, log);
    if (!lastResult.ok) return lastResult;
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Send media message
// ---------------------------------------------------------------------------

export async function sendMedia(
  config: SendblueConfig,
  to: string,
  mediaUrl: string,
  caption: string,
  log: Logger
): Promise<SendResult> {
  const body: SendMessageRequest = {
    number: to,
    content: caption,
    from_number: config.fromNumber,
    media_url: mediaUrl,
  };
  return sendRequest(config, body, log);
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

export async function sendTypingIndicator(
  config: SendblueConfig,
  to: string,
  log: Logger
): Promise<void> {
  const url = `${API_BASE}/api/send-typing-indicator`;

  try {
    await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ number: to }),
    });
  } catch (err) {
    log.debug?.(`[sendblue] Failed to send typing indicator: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Mark as read
// ---------------------------------------------------------------------------

export async function markAsRead(
  config: SendblueConfig,
  messageHandle: string,
  log: Logger
): Promise<void> {
  const url = `${API_BASE}/api/mark-read`;

  try {
    await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ message_handle: messageHandle }),
    });
  } catch (err) {
    log.debug?.(`[sendblue] Failed to mark message as read: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Send reaction
// ---------------------------------------------------------------------------

export async function sendReaction(
  config: SendblueConfig,
  messageHandle: string,
  reaction: string,
  log: Logger
): Promise<SendResult> {
  const url = `${API_BASE}/api/send-reaction`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ message_handle: messageHandle, reaction }),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as ApiErrorResponse;
      const errorMsg =
        err?.error_message ?? err?.message ?? `HTTP ${response.status} ${response.statusText}`;
      log.error(`[sendblue] Reaction error: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[sendblue] Network error sending reaction: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Evaluate service (check if a number supports iMessage)
// ---------------------------------------------------------------------------

export async function evaluateService(
  config: SendblueConfig,
  number: string,
  log: Logger
): Promise<EvaluateServiceResponse | null> {
  const url = `${API_BASE}/api/evaluate-service?number=${encodeURIComponent(number)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: headers(config),
    });

    if (!response.ok) {
      log.error(`[sendblue] evaluateService failed: HTTP ${response.status}`);
      return null;
    }

    return (await response.json()) as EvaluateServiceResponse;
  } catch (err) {
    log.error(`[sendblue] evaluateService error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

async function sendRequest(
  config: SendblueConfig,
  body: SendMessageRequest,
  log: Logger
): Promise<SendResult> {
  const url = `${API_BASE}/api/send-message`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as ApiErrorResponse;
      const errorMsg =
        err?.error_message ?? err?.message ?? `HTTP ${response.status} ${response.statusText}`;
      log.error(`[sendblue] API error: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const data = (await response.json()) as SendMessageResponse;

    if (data.error_code) {
      log.error(`[sendblue] Send error ${data.error_code}: ${data.error_message}`);
      return { ok: false, error: data.error_message ?? data.error_code };
    }

    return { ok: true, messageHandle: data.message_handle };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[sendblue] Network error: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}


// ---------------------------------------------------------------------------
// Send group text message
// ---------------------------------------------------------------------------

export async function sendGroupText(
  config: SendblueConfig,
  groupId: string,
  text: string,
  log: Logger
): Promise<SendResult> {
  const chunks = splitMessage(text, 1600);
  let lastResult: SendResult = { ok: false, error: "No chunks" };

  for (const chunk of chunks) {
    lastResult = await sendGroupRequest(config, {
      group_id: groupId,
      content: chunk,
      from_number: config.fromNumber,
    }, log);
    if (!lastResult.ok) return lastResult;
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Send group media message
// ---------------------------------------------------------------------------

export async function sendGroupMedia(
  config: SendblueConfig,
  groupId: string,
  mediaUrl: string,
  caption: string,
  log: Logger
): Promise<SendResult> {
  const body: SendGroupMessageRequest = {
    group_id: groupId,
    content: caption,
    from_number: config.fromNumber,
    media_url: mediaUrl,
  };
  return sendGroupRequest(config, body, log);
}

// ---------------------------------------------------------------------------
// Core group send function
// ---------------------------------------------------------------------------

async function sendGroupRequest(
  config: SendblueConfig,
  body: SendGroupMessageRequest,
  log: Logger
): Promise<SendResult> {
  const url = API_BASE + "/api/send-group-message";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as ApiErrorResponse;
      const errorMsg =
        err?.error_message ?? err?.message ?? ("HTTP " + response.status + " " + response.statusText);
      log.error("[sendblue] Group API error: " + errorMsg);
      return { ok: false, error: errorMsg };
    }

    const data = (await response.json()) as SendMessageResponse;

    if (data.error_code) {
      log.error("[sendblue] Group send error " + data.error_code + ": " + data.error_message);
      return { ok: false, error: data.error_message ?? data.error_code };
    }

    return { ok: true, messageHandle: data.message_handle };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error("[sendblue] Group network error: " + errorMsg);
    return { ok: false, error: errorMsg };
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a long message into chunks, respecting word boundaries */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
