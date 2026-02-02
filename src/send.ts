import { Element } from "ltx";

import type { XmppAccountRuntime } from "./transport.js";

export async function sendTextXmpp(params: {
  runtime: XmppAccountRuntime;
  toJid: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { runtime, toJid, text } = params;
  const client = runtime.client;

  if (!client) return { ok: false, error: "client not connected" };

  const id = `oc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stanza = new Element("message", { to: toJid, type: "chat", id });
  stanza.c("body").t(text);

  try {
    await client.send(stanza);
    runtime.lastOutboundAt = Date.now();
    return { ok: true, messageId: id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
