import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

import type { ResolvedXmppAccount } from "./accounts.js";
import { bareJid, isValidBareJid, xmppIngressIdentity } from "./jid.js";
import { getXmppRuntime } from "./runtime.js";
import { sendTextXmpp } from "./send.js";
import type { XmppAccountRuntime } from "./transport.js";

const CHANNEL_ID = "xmpp" as const;

const pairingHintSentAt = new Map<string, number>();

// Dedupe inbound messages (some XMPP servers/clients can re-deliver or we can process twice on reconnect).
// Prefer stanza id, but many clients omit it; fall back to a short window content-hash key.
import crypto from "node:crypto";

const seenInbound = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CONTENT_WINDOW_MS = 30 * 1000; // 30s window for id-less re-deliveries

function seenKeyById(senderId: string, stanzaId?: string | null): string | null {
  if (!stanzaId) return null;
  return `${senderId.toLowerCase()}::id::${String(stanzaId)}`;
}

function seenKeyByContent(senderId: string, text: string, now = Date.now()): string {
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  const bucket = Math.floor(now / CONTENT_WINDOW_MS);
  return `${senderId.toLowerCase()}::body::${hash}::${bucket}`;
}

function isDuplicateInbound(params: {
  senderId: string;
  stanzaId?: string | null;
  text: string;
  now?: number;
}): boolean {
  const { senderId, stanzaId, text } = params;
  const now = params.now ?? Date.now();

  // opportunistic cleanup
  for (const [k, ts] of seenInbound) {
    if (now - ts > SEEN_TTL_MS) seenInbound.delete(k);
  }

  const kId = seenKeyById(senderId, stanzaId);
  if (kId) {
    const last = seenInbound.get(kId);
    if (last && now - last < SEEN_TTL_MS) return true;
    seenInbound.set(kId, now);
    return false;
  }

  // No stanza id: de-dupe within a short time window by (sender + body hash).
  const kBody = seenKeyByContent(senderId, text, now);
  const last = seenInbound.get(kBody);
  if (last && now - last < SEEN_TTL_MS) return true;
  seenInbound.set(kBody, now);
  return false;
}

function shouldSendPairingHint(senderId: string, now = Date.now()): boolean {
  const last = pairingHintSentAt.get(senderId) ?? 0;
  // Avoid spamming: at most once per 10 minutes per sender.
  if (now - last < 10 * 60 * 1000) return false;
  pairingHintSentAt.set(senderId, now);
  return true;
}

export async function handleXmppInbound(params: {
  stanza: any;
  account: ResolvedXmppAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channelRuntime: PluginRuntime["channel"];
  transport: XmppAccountRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { stanza, account, cfg, runtime, channelRuntime, transport, statusSink } = params;
  const core = getXmppRuntime();

  // Only handle <message type='chat'|'normal'><body>...</body>
  if (!stanza?.is?.("message")) return;

  // Avoid processing XEP-0280 message carbons duplicates (we should only handle the real inbound).
  // Some servers deliver both the message and a carbon copy with a different stanza id.
  const carbonsNs = "urn:xmpp:carbons:2";
  if (stanza.getChild?.("received", carbonsNs) || stanza.getChild?.("sent", carbonsNs)) {
    return;
  }

  const type = stanza.attrs?.type;
  if (type && type !== "chat" && type !== "normal") return;

  const from = stanza.attrs?.from;
  const to = stanza.attrs?.to;
  const id = stanza.attrs?.id;

  const rawBody =
    stanza.getChildText?.("body") ??
    stanza.getChild?.("body")?.text?.() ??
    "";
  const text = String(rawBody).trim();
  if (!text) return;

  if (!from || !isValidBareJid(String(from))) return;
  const senderFull = String(from);
  const senderId = bareJid(senderFull);
  if (account.jid && senderId === bareJid(account.jid)) return;
  const replyJid = senderFull;
  const now = Date.now();
  const dedupeSenderId = `${account.accountId}:${senderId}`;

  // Drop duplicates (by stanza id when present; otherwise by sender+body within a short window)
  // so we don't reply twice.
  if (isDuplicateInbound({ senderId: dedupeSenderId, stanzaId: id, text, now })) {
    runtime.log?.(
      `xmpp: drop duplicate inbound sender=${senderId} id=${String(id)} textHash=${crypto
        .createHash("sha1")
        .update(text)
        .digest("hex")
        .slice(0, 10)}`,
    );
    return;
  }

  // Fallback: also drop same-text duplicates that arrive with different stanza ids
  // (common with carbon copies or some client/server retry behavior).
  const contentKey = `${senderId.toLowerCase()}::${text}`;
  if (isDuplicateInbound({ senderId: dedupeSenderId, text: contentKey, now })) {
    runtime.log?.(`xmpp: drop duplicate inbound (content) sender=${senderId}`);
    return;
  }
  const destId = to ? bareJid(String(to)) : account.jid ? bareJid(account.jid) : "unknown";

  runtime.log?.(`xmpp: inbound from=${senderId} to=${destId} type=${type ?? "chat"}`);

  statusSink?.({ lastInboundAt: Date.now() });

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: senderId },
  });
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(text, cfg);
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const access = await channelRuntime.inbound.ingress.resolve({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: xmppIngressIdentity,
    subject: { stableId: senderId },
    conversation: { kind: "direct", id: senderId },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: id,
      nativeChannelId: senderId,
      inboundEventKind: "user_request",
    },
    event: { kind: "message", authMode: "inbound", mayPair: true },
    policy: { dmPolicy, groupPolicy: "disabled" },
    allowFrom: account.config.allowFrom,
    accessGroups: cfg.accessGroups,
    useDefaultPairingStore: true,
    command: { allowTextCommands, hasControlCommand },
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    const { code } = await core.channel.pairing.upsertPairingRequest({
      channel: CHANNEL_ID,
      id: senderId,
      accountId: account.accountId,
      meta: { name: senderId },
    });
    if (shouldSendPairingHint(`${account.accountId}:${senderId}`)) {
      try {
        const hint = core.channel.pairing.buildPairingReply({
          channel: CHANNEL_ID,
          idLine: `Your XMPP JID: ${senderId}`,
          code,
        });
        await sendTextXmpp({ runtime: transport, toJid: replyJid, text: hint });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`xmpp: pairing reply failed for ${senderId}: ${String(err)}`);
      }
    }
    runtime.log?.(`xmpp: drop DM sender=${senderId} (pairing required)`);
    return;
  }

  if (access.commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: (m) => runtime.log?.(m),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    runtime.log?.(
      `xmpp: drop DM sender=${senderId} reason=${access.ingress.reasonCode}`,
    );
    return;
  }

  const fromLabel = senderId;
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "XMPP",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  const ctxPayload = channelRuntime.inbound.buildContext({
    channelIngress: access,
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: id,
    timestamp: now,
    from: `xmpp:${senderId}`,
    sender: { id: senderId, name: senderId },
    conversation: { kind: "direct", id: senderId, label: fromLabel },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: { to: `xmpp:${senderId}`, originatingTo: `xmpp:${senderId}` },
    message: { body, bodyForAgent: text, rawBody: text, commandBody: text },
    access: { commands: { authorized: commandAuthorized } },
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => runtime.error?.(`xmpp: failed updating session meta: ${String(err)}`),
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const textOut = String((payload as any)?.text ?? "").trim();
        if (!textOut) return;
        await sendTextXmpp({ runtime: transport, toJid: replyJid, text: textOut });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => runtime.error?.(`xmpp ${info.kind} reply failed: ${String(err)}`),
    },
  });
}
