import { describe, expect, it } from "vitest";
import { resolveChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";

import {
  bareJid,
  isJidAllowed,
  isValidBareJid,
  jidMatchesPattern,
  validateServiceUrl,
  xmppIngressIdentity,
} from "./jid.js";

describe("JID policy", () => {
  it("normalizes resources without allowing substring matches", () => {
    expect(bareJid("Alice@Example.com/Phone")).toBe("alice@example.com");
    expect(jidMatchesPattern("malice@example.com", "alice@example.com")).toBe(false);
    expect(jidMatchesPattern("alice@notexample.com", "*@example.com")).toBe(false);
  });

  it("supports explicit domain wildcards", () => {
    expect(isJidAllowed("alice@example.com/mobile", ["*@example.com"])).toBe(true);
    expect(isJidAllowed("alice@sub.example.com", ["*@example.com"])).toBe(false);
  });

  it("rejects malformed JIDs and unsafe service URLs", () => {
    expect(isValidBareJid("alice@example.com/device")).toBe(true);
    expect(isValidBareJid("alice@@example.com")).toBe(false);
    expect(isValidBareJid("example.com")).toBe(false);
    expect(validateServiceUrl("wss://xmpp.example.com/ws")).toBe(true);
    expect(validateServiceUrl("https://xmpp.example.com/ws")).toBe(false);
    expect(validateServiceUrl("xmpp://user:secret@example.com:5222")).toBe(false);
  });

  it("preserves domain wildcard policy in the OpenClaw ingress resolver", async () => {
    const resolve = (sender: string) =>
      resolveChannelMessageIngress({
        channelId: "xmpp",
        accountId: "default",
        identity: xmppIngressIdentity,
        subject: { stableId: sender },
        conversation: { kind: "direct", id: sender },
        event: { kind: "message", authMode: "inbound", mayPair: true },
        policy: { dmPolicy: "allowlist", groupPolicy: "disabled" },
        allowFrom: ["*@example.com"],
      });

    await expect(resolve("alice@example.com")).resolves.toMatchObject({
      ingress: { admission: "dispatch" },
    });
    await expect(resolve("alice@notexample.com")).resolves.toMatchObject({
      ingress: { admission: "drop" },
    });
  });
});
