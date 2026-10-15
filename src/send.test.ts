import { describe, expect, it, vi } from "vitest";

import { sendTextXmpp } from "./send.js";
import type { XmppAccountRuntime } from "./transport.js";

describe("XMPP outbound delivery", () => {
  it("returns the stanza id only after the client accepts the send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const runtime = { accountId: "default", client: { send } } as unknown as XmppAccountRuntime;

    const result = await sendTextXmpp({ runtime, toJid: "alice@example.com", text: "hello" });

    expect(result.messageId).toMatch(/^oc-/);
    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0][0])).toContain("<body>hello</body>");
    expect(runtime.lastOutboundAt).toEqual(expect.any(Number));
  });

  it("throws when no connected client can accept the message", async () => {
    const runtime = { accountId: "default", client: null } as XmppAccountRuntime;

    await expect(
      sendTextXmpp({ runtime, toJid: "alice@example.com", text: "hello" }),
    ).rejects.toThrow("not connected");
  });

  it("does not convert transport rejection into a success-shaped result", async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error("socket closed")) };
    const runtime = { accountId: "default", client } as unknown as XmppAccountRuntime;

    await expect(
      sendTextXmpp({ runtime, toJid: "alice@example.com", text: "hello" }),
    ).rejects.toThrow("socket closed");
    expect(runtime.lastOutboundAt).toBeUndefined();
  });
});
