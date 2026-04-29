import { describe, expect, it } from "vitest";
import { applyContentGate, checkContent, type ContentGateResult } from "./content-gate.js";

describe("checkContent", () => {
  it("passes clean text", () => {
    expect(checkContent("Hey! How can I help you today?")).toEqual({ action: "pass" });
  });

  it("passes empty/null-ish text", () => {
    expect(checkContent("")).toEqual({ action: "pass" });
  });

  // --- Banned phrases ---

  it("catches banned phrase: reminder narration", () => {
    const result = checkContent("Done! Note: I did not schedule a reminder for this.");
    expect(result.action).not.toBe("pass");
  });

  it("cancels banned phrase: allowlist", () => {
    const result = checkContent("The user is already in the allowlist.");
    expect(result.action).toBe("cancel");
  });

  it("cancels banned phrase: HEARTBEAT_OK", () => {
    const result = checkContent("HEARTBEAT_OK");
    expect(result.action).toBe("cancel");
  });

  it("cancels banned phrase: Victor attribution", () => {
    const result = checkContent("I'm Cole, Victor's AI Chief of Staff.");
    expect(result.action).toBe("cancel");
  });

  it("cancels banned phrase: tool progress leak", () => {
    const result = checkContent("Working...");
    expect(result.action).toBe("cancel");
  });

  // --- Internal terms ---

  it("cancels internal term: elevenlabs", () => {
    const result = checkContent("I'll use elevenlabs to generate the audio.");
    expect(result.action).toBe("cancel");
    expect((result as { reason: string }).reason).toContain("internal_term");
  });

  it("cancels internal term: openclaw", () => {
    const result = checkContent("The openclaw gateway is configured.");
    expect(result.action).toBe("cancel");
  });

  it("cancels internal term: workspace-cos", () => {
    const result = checkContent("Loading from workspace-cos scripts.");
    expect(result.action).toBe("cancel");
  });

  // --- Credentials ---

  it("cancels credential: Slack token", () => {
    const result = checkContent("Here's the token: xoxb-1234567890-abcdef");
    expect(result.action).toBe("cancel");
    expect((result as { reason: string }).reason).toBe("credential_leak");
  });

  it("cancels credential: API key", () => {
    const result = checkContent("sk-proj-abcdefghij1234567890abcd");
    expect(result.action).toBe("cancel");
    expect((result as { reason: string }).reason).toBe("credential_leak");
  });

  it("cancels credential: Bearer token", () => {
    const result = checkContent("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef");
    expect(result.action).toBe("cancel");
    expect((result as { reason: string }).reason).toBe("credential_leak");
  });

  // --- File paths ---

  it("cancels internal path: /home/openclaw", () => {
    const result = checkContent("The file is at /home/openclaw/.openclaw/config.json");
    expect(result.action).toBe("cancel");
    // May match as internal_term (openclaw) or internal_path - both are correct
  });

  it("cancels internal path: AGENTS.md reference", () => {
    const result = checkContent("According to AGENTS.md, I should...");
    expect(result.action).toBe("cancel");
    // May match as internal_term (agents.md) or internal_path - both are correct
  });

  // --- JID / session bleed ---

  it("cancels WhatsApp JID leak", () => {
    const result = checkContent("Sending to 19738794022@s.whatsapp.net");
    expect(result.action).toBe("cancel");
    expect((result as { reason: string }).reason).toBe("session_bleed");
  });

  it("cancels group JID leak", () => {
    const result = checkContent("Group 120363123456789012@g.us has 5 members");
    expect(result.action).toBe("cancel");
  });

  // --- Narration regexes ---

  it("cancels narration: gateway status", () => {
    const result = checkContent("Gateway is up and running.");
    expect(result.action).toBe("cancel");
    // May match as banned_phrase or narration_leak - both are correct
  });

  it("cancels narration: voice sent to someone", () => {
    const result = checkContent("Voice intro sent to Tania.");
    expect(result.action).toBe("cancel");
  });

  it("cancels narration: group registration", () => {
    const result = checkContent("I need to register this group first.");
    expect(result.action).toBe("cancel");
  });

  it("cancels narration: thread pulling", () => {
    const result = checkContent("Let me pull more thread context.");
    expect(result.action).toBe("cancel");
  });

  // --- Fake completion ---

  it("replaces fake completion pattern", () => {
    const result = checkContent(
      "Done! I've set that up for you. Note: I did not schedule a reminder so this will not trigger automatically.",
    );
    expect(result.action).toBe("replace");
    expect((result as { content: string }).content).toBe(
      "I wasn't able to do that - please try again.",
    );
  });

  // --- Weather icons ---

  it("cancels weather icon URL", () => {
    const result = checkContent("Here's the weather: cdn.weatherapi.com/weather/64x64/day/116.png");
    expect(result.action).toBe("cancel");
  });
});

describe("applyContentGate", () => {
  it("returns false for clean text", () => {
    const payload = { text: "Hello there!" };
    expect(applyContentGate(payload)).toBe(false);
    expect(payload.text).toBe("Hello there!");
  });

  it("returns false for null text", () => {
    const payload = { text: null };
    expect(applyContentGate(payload)).toBe(false);
  });

  it("returns true and blocks cancelled content", () => {
    const payload = { text: "HEARTBEAT_OK" };
    expect(applyContentGate(payload)).toBe(true);
  });

  it("returns false but replaces content for fake completion", () => {
    const payload = {
      text: "Saved! Note: I did not schedule the reminder.",
    };
    expect(applyContentGate(payload)).toBe(false);
    expect(payload.text).toBe("I wasn't able to do that - please try again.");
  });
});
