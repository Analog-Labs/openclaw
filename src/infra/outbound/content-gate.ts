/**
 * Pre-send content gate — blocks or sanitizes outbound messages before delivery.
 *
 * Catches narration leaks, internal terms, credential patterns, banned phrases,
 * and other content that should never reach end users.
 *
 * Returns:
 *   - `{ action: "pass" }` — message is clean
 *   - `{ action: "replace", content, reason }` — substitute sanitized text
 *   - `{ action: "cancel", reason }` — block delivery entirely
 *
 * All checks are regex/substring — no IO, no child processes. Must complete in <5ms.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("content-gate");

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ContentGateResult =
  | { action: "pass" }
  | { action: "replace"; content: string; reason: string }
  | { action: "cancel"; reason: string };

// ---------------------------------------------------------------------------
// 1. Banned phrases (case-insensitive substring match)
// ---------------------------------------------------------------------------

const BANNED_PHRASES: readonly string[] = [
  // Internal mechanism narration
  "I did not schedule a reminder",
  "did not schedule a reminder in this turn",
  "will not trigger automatically",
  "Note: I did not",
  "Note: I haven't",
  "Note: I have not",
  "I wasn't able to schedule a reminder",
  "I wasn't able to schedule a follow-up",
  "I did not schedule",
  "I have not scheduled",
  "I haven't scheduled",
  "no reminder has been set",
  "no reminder was set",
  "reminder was not set",
  "reminder has not been set",
  "this won't automatically",
  "won't trigger automatically",
  "no automatic reminder",
  "reminder won't fire",
  "reminder will not fire",
  // Auth/allowlist narration
  "is already in the allowlist",
  "is in the allowlist",
  "is not in the approved list",
  "not in the approved list",
  "allowlist",
  "CONNECT token",
  "token verification failed",
  "authorized user",
  "approval queue",
  "approve-requests",
  "telegram-approve",
  "pending approval",
  "added to the queue",
  "forwarded for review",
  "forwarded to the",
  // Process narration
  "Now I'll",
  "Text sent. Waiting for audio",
  "Both sent.",
  "Let me reply in the thread",
  "I'm going to check the task ledger",
  "HEARTBEAT_OK",
  // Status/delivery narration
  "Gateway is up",
  "Gateway is down",
  "Voice intro sent",
  "intro sent to",
  "Text intro sent",
  "Audio sent",
  "Message sent to",
  "Successfully sent",
  "Now sending",
  "Sending voice",
  "Sending intro",
  "Generating voice",
  "Audio generated",
  "Voice generated",
  "File generated",
  // Victor attribution
  "Victor's AI Chief of Staff",
  "Victor's Chief of Staff",
  "AI Chief of Staff of Victor",
  // Thai attribution
  "AI Chief of Staff ของ Victor",
  "ของ Victor",
  "Cole, Victor's",
  "I'm Cole - Victor",
  "Cole - Victor's",
  // Victor ownership
  "whatever Victor needs",
  "whatever Victor wants",
  "I help Victor with",
  "I work for Victor",
  "I assist Victor",
  "I support Victor with",
  // Internal narration
  "Got the API key",
  "Now generating the voice",
  "Let me generate the voice",
  "Audio sent successfully",
  "update the group activity log",
  "No recent outbound to this group",
  "good to go. Let me generate",
  // Group registration narration
  "need to register it first",
  "then send the intro",
  "Safe to intro",
  "safe to proceed",
  "no recent outbound",
  "avoid duplicate intro",
  "check the group-activity",
  "group-activity.json",
  "last_outbound",
  "pending-group-actions",
  "group-activity",
  "new group -",
  "this is a new group",
  "register this group",
  "register the group",
  "registering this group",
  "registering the group",
  "save this group",
  "saving this group",
  "looking up group",
  "looking up the group",
  "proceed with intro",
  "proceed with introduction",
  "first time in this group",
  "first message from this group",
  // Task ledger narration
  "Let me check the task",
  "Let me check the ledger",
  "Let me check the gateway",
  "Let me check the allowlist",
  "Let me check the group",
  "check the task ledger",
  "task ledger",
  // Chat registration
  "register this chat",
  "register the chat",
  "registering this chat",
  "registering the chat",
  // Tool progress leak
  "Working...",
  "tool: exec",
  "tool: read",
  "tool: write",
  "tool: fetch",
  "exec fetch url",
  "show first 30 lines",
  "2>/dev/null | head",
  "curl -s",
  // OpenClaw error strings
  "Agent couldn't generate a response",
  "some tool actions may have already been executed",
  "please verify before retrying",
  // Audio/file narration
  "Audio file has been created",
  "audio file created",
  "voice file created",
  "file has been generated",
  "file has been created",
  // Weather icon URLs
  "cdn.weatherapi.com/weather",
  "maps.gstatic.com/weather",
  // Let me try
  "Let me try the message tool",
  "Let me attempt",
];

const BANNED_PHRASES_LOWER: readonly string[] = BANNED_PHRASES.map((p) => p.toLowerCase());

// ---------------------------------------------------------------------------
// 2. Internal terms (should never appear in user-facing messages)
// ---------------------------------------------------------------------------

const INTERNAL_TERMS_LOWER: readonly string[] = [
  "elevenlabs",
  "openclaw",
  "supabase",
  "ffmpeg",
  "vapi",
  "gamma",
  "agentmail",
  "resend",
  "fathom",
  "amadeus",
  "composio",
  "sendblue",
  "agents.md",
  "tools.md",
  "soul.md",
  "memory.md",
  "heartbeat.md",
  "bootstrap.md",
  "subagent",
  "heartbeat",
  "task-ledger",
  "pre_send_gate",
  "outbound_content_gate",
  "promise_tracker",
  "group_activity_tracker",
  "workspace-cos",
];

// ---------------------------------------------------------------------------
// 3. Regex patterns (compiled once at module load)
// ---------------------------------------------------------------------------

const NARRATION_REGEXES: readonly RegExp[] = [
  /\bnote:\s+i\s+(did not|didn't|have not|haven't|won't|will not|was not|wasn't)\s+\w+/i,
  /gateway is (up|down|running|starting|restarting|available|unavailable)/i,
  /(voice|text|audio|intro|message)\s*(intro\s*)?sent\s+to\s+\w+/i,
  /(voice|text|audio|intro|message)\s*(intro\s*)?sent\s*!/i,
  /^(checking|generating|sending|uploading|downloading|processing)\b/im,
  /(file|audio|mp3|voice)\s+(generated|created|saved|uploaded)\s*(successfully)?/i,
  /^now (sending|generating|uploading|checking|processing)\b/im,
  /(need to|going to|have to|must|should)\s+(register|save|check|verify|look up|update|log)\s+(this|the|a)\s+(group|jid|chat)/i,
  /(safe|ok|good|ready)\s+to\s+(intro|proceed|send|continue)/i,
  /(no|not|zero|doesn't have)\s+(recent|any)\s+(outbound|intro|message)/i,
  /(first|new)\s+(time|message|group|interaction)\s+(in|from|with)\s+(this|the)\s+(group|chat)/i,
  /^(first,?\s+i\s+(need|should|must|have)\s+to)\b/im,
  /\bduplicate\s+(intro|introduction|message)\b/i,
  /\b(register|save|log|record)\s+(this|the)\s+(group|jid|chat)\b/i,
  /\b(last_outbound|last_inbound|group.activity|pending.group.actions)\b/i,
  /(saving|recording)\s+(group|the group|this group|chat|the chat|this chat)\s+(info|data|id|details|jid)/i,
  /(generating|creating)\s+(audio|voice|mp3|sound)\s+(now|file|message)/i,
  /this\s+(appears|seems|looks)\s+to\s+be\s+a\s+new\s+(group|chat|conversation)/i,
  /(registered|saved|logged|recorded)\s+(your|the|this)\s+(group|chat|jid)/i,
  /\bno\s+action\s+needed\s+from\s+me\b/i,
  /\b(this\s+is|that\s+was|that['']?s)\s+(a\s+)?(direct\s+(exchange|conversation|chat)|peer.to.peer|private\s+(conversation|exchange))\b/i,
  /\b(reading|pulling|fetching|loading)\s+(the|more)\s+(thread|context|history|conversation|messages?)\b/i,
  /\b(let\s+me|i['']?ll)\s+(read|pull|fetch|get|load)[\w\s]{0,20}?(thread|context|history|conversation|messages?)\b/i,
  /\bthat\s+only\s+(pulled|returned|got|fetched)\b/i,
  /\bnothing\s+needed\s+from\s+me\b/i,
  /\bi\s*(need\s+to|have\s+to|must|should|['']?ll|will)\s+\w+[\w\s]{0,80}?\s+and\s+(stop|halt|pause)\b/i,
  /(?:^|[\n.]\s*)(credits?|balance|tokens?|quota|messages?)\s+(are|is)\s+at\s+(0|zero)\b/i,
];

const PATH_REGEXES: readonly RegExp[] = [
  /\/home\/openclaw/,
  /~\/openclaw/,
  /~\/\.openclaw/,
  /\bscripts\/\w/,
  /\bmemory\/\w/,
  /\bspecs\/\w/,
  /(?:^|\n)edit:\s/im,
  /\b(?:AGENTS|TOOLS|SOUL|MEMORY|HEARTBEAT|BOOTSTRAP|README)\.md\b/,
  /\b\w+(?:_\w+)+\.(?:py|js|sh|json|md)\b/,
  /\ballowlist\.json\b/,
];

const JID_REGEXES: readonly RegExp[] = [
  /\d{10,15}@s\.whatsapp\.net/,
  /\d{10,20}@g\.us/,
  /\d{10,20}@lid/,
  /agent:[a-z-]+:[a-z-]+:[a-z-]+:direct:/,
  /workspace[_-]id/,
  /session[_-]key/,
];

const CREDENTIAL_REGEXES: readonly RegExp[] = [
  /xox[bpoa]-[0-9A-Za-z-]+/,
  /sk-[A-Za-z0-9-]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
];

const FAKE_COMPLETION_RE = new RegExp(
  "(\\bDone\\b|\\bSaved\\b|\\bGot it\\b|\\bConfirmed\\b|\\bSet\\b|\\bCreated\\b|\\bAll set\\b|\\u2705)" +
    "[\\s\\S]{0,500}" +
    "(Note: I did not|I did not schedule|I have not scheduled|I haven't scheduled" +
    "|so this will not trigger|won't trigger automatically|reminder was not set" +
    "|no reminder has been set|reminder will not fire|I wasn't able to schedule" +
    "|I did not complete)",
  "i",
);

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

export function checkContent(text: string): ContentGateResult {
  if (!text) return { action: "pass" };

  const textLower = text.toLowerCase();

  // Fake completion check (highest priority - replace entire message)
  if (FAKE_COMPLETION_RE.test(text)) {
    return {
      action: "replace",
      content: "I wasn't able to do that - please try again.",
      reason: "fake_completion",
    };
  }

  // Credential check (highest severity - cancel entirely)
  for (const re of CREDENTIAL_REGEXES) {
    if (re.test(text)) {
      return { action: "cancel", reason: "credential_leak" };
    }
  }

  // Banned phrases
  for (let i = 0; i < BANNED_PHRASES_LOWER.length; i++) {
    if (textLower.includes(BANNED_PHRASES_LOWER[i]!)) {
      return { action: "cancel", reason: `banned_phrase: ${BANNED_PHRASES[i]}` };
    }
  }

  // Internal terms
  for (const term of INTERNAL_TERMS_LOWER) {
    if (textLower.includes(term)) {
      return { action: "cancel", reason: `internal_term: ${term}` };
    }
  }

  // File path patterns
  for (const re of PATH_REGEXES) {
    if (re.test(text)) {
      return { action: "cancel", reason: "internal_path" };
    }
  }

  // JID / session key patterns
  for (const re of JID_REGEXES) {
    if (re.test(text)) {
      return { action: "cancel", reason: "session_bleed" };
    }
  }

  // Narration regex patterns
  for (const re of NARRATION_REGEXES) {
    if (re.test(text)) {
      return { action: "cancel", reason: "narration_leak" };
    }
  }

  return { action: "pass" };
}

// ---------------------------------------------------------------------------
// Delivery integration helper
// ---------------------------------------------------------------------------

/**
 * Apply the content gate to an outbound text payload.
 * Returns `true` if the message was cancelled and should be skipped.
 * Mutates `payload.text` in-place if the gate returns a replacement.
 */
export function applyContentGate(payload: { text?: string | null }): boolean {
  const text = payload.text;
  if (!text) return false;

  const result = checkContent(text);

  if (result.action === "pass") {
    return false;
  }

  if (result.action === "cancel") {
    log.warn("content gate blocked outbound message", { reason: result.reason });
    return true;
  }

  if (result.action === "replace") {
    log.warn("content gate replaced outbound message", { reason: result.reason });
    payload.text = result.content;
    return false;
  }

  return false;
}
