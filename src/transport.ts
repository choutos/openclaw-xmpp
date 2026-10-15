import { client as xmppClient, type Client, xml } from "@xmpp/client";
import debug from "@xmpp/debug";

export type XmppAccountRuntime = {
  accountId: string;
  client: Client | null;
  bareJid?: string;

  lastInboundAt?: number;
  lastOutboundAt?: number;
};

export async function startXmppClient(params: {
  accountId: string;
  jid: string;
  password: string;
  service?: string;
  log?: (line: string) => void;
  onStanza: (runtime: XmppAccountRuntime, stanza: any) => void | Promise<void>;
  abortSignal: AbortSignal;
}): Promise<{ runtime: XmppAccountRuntime; stop: () => Promise<void> }> {
  const { accountId, jid, password, service, log, onStanza, abortSignal } = params;

  const xmpp = xmppClient({
    service: service || `xmpp://${jid.split("@")[1]}:5222`,
    username: jid.split("@")[0],
    domain: jid.split("@")[1],
    password,
  });

  const runtime: XmppAccountRuntime = {
    accountId,
    client: xmpp,
    bareJid: jid,
  };

  // Optional verbose wire logging when OPENCLAW_XMPP_DEBUG=1
  if (process.env.OPENCLAW_XMPP_DEBUG) {
    debug(xmpp, true);
  }

  xmpp.on("stanza", (stanza: any) => {
    void Promise.resolve(onStanza(runtime, stanza)).catch((error) => {
      log?.(`[xmpp:${accountId}] stanza handling failed: ${String(error)}`);
    });
  });
  xmpp.on("error", (err: any) => log?.(`[xmpp:${accountId}] error: ${String(err)}`));
  xmpp.on("offline", () => log?.(`[xmpp:${accountId}] offline`));
  xmpp.on("online", async (address: any) => {
    log?.(`[xmpp:${accountId}] online as ${address.toString?.() ?? String(address)}`);
    try {
      await xmpp.send(xml("presence"));
    } catch (err) {
      log?.(`[xmpp:${accountId}] initial presence broadcast failed: ${String(err)}`);
    }
    try {
      const id = `oc-carbons-${Date.now()}`;
      await xmpp.send(
        xml("iq", { type: "set", id }, xml("enable", { xmlns: "urn:xmpp:carbons:2" })),
      );
      log?.(`[xmpp:${accountId}] message carbons enabled`);
    } catch (err) {
      log?.(`[xmpp:${accountId}] message carbons enable failed: ${String(err)}`);
    }
  });

  // Ensure we stop on abort.
  const abortHandler = async () => {
    try {
      await xmpp.stop();
    } catch {}
  };
  abortSignal.addEventListener("abort", abortHandler, { once: true });

  await xmpp.start();

  const stop = async () => {
    abortSignal.removeEventListener("abort", abortHandler);
    try {
      await xmpp.stop();
    } finally {
      runtime.client = null;
    }
  };

  return { runtime, stop };
}
