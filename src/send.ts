import { xml } from "@xmpp/client";

import type { XmppAccountRuntime } from "./transport.js";

export async function sendTextXmpp(params: {
  runtime: XmppAccountRuntime;
  toJid: string;
  text: string;
}): Promise<{ messageId: string }> {
  const { runtime, toJid, text } = params;
  const client = runtime.client;

  if (!client) throw new Error("XMPP client is not connected");

  const id = `oc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stanza = xml("message", { to: toJid, type: "chat", id }, xml("body", {}, text));

  await client.send(stanza);
  runtime.lastOutboundAt = Date.now();
  return { messageId: id };
}
