import {
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

import type { ResolvedXmppAccount } from "./accounts.js";
import { getXmppRuntime } from "./runtime.js";
import { sendTextXmpp } from "./send.js";
import type { XmppAccountRuntime } from "./transport.js";

const CHANNEL_ID = "xmpp" as const;

function bareJid(jid: string): string {
  return jid.split("/")[0];
}

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
  transport: XmppAccountRuntime;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { stanza, account, cfg, runtime, transport, statusSink } = params;
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

  const senderFull = from ? String(from) : "unknown";
  const senderId = from ? bareJid(String(from)) : "unknown";
  const replyJid = senderFull !== "unknown" ? senderFull : senderId;
  const now = Date.now();

  // Drop duplicates (by stanza id when present; otherwise by sender+body within a short window)
  // so we don't reply twice.
  if (isDuplicateInbound({ senderId, stanzaId: id, text, now })) {
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
  if (isDuplicateInbound({ senderId, text: contentKey, now })) {
    runtime.log?.(`xmpp: drop duplicate inbound (content) sender=${senderId}`);
    return;
  }
  const destId = to ? bareJid(String(to)) : account.jid ? bareJid(account.jid) : "unknown";

  runtime.log?.(
    `xmpp: inbound from=${senderId} to=${destId} type=${type ?? "chat"} text=${text.slice(0, 200)}`,
  );

  statusSink?.({ lastInboundAt: Date.now() });

  // DM policy / pairing gate.
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowFrom = (account.config.allowFrom ?? [])
    .map((entry) => String(entry).trim().replace(/^(xmpp|jabber):/i, "").toLowerCase())
    .filter(Boolean);

  const senderAllowed = (() => {
    const s = senderId.toLowerCase();
    for (const raw of allowFrom) {
      const e = String(raw).trim().toLowerCase();
      if (!e) continue;
      if (e === "*") return true;
      if (e.startsWith("*@")) {
        const domain = e.slice(2);
        if (domain && s.endsWith(`@${domain}`)) return true;
      }
      // allowFrom may also be configured as "@domain" or "domain" as shorthand
      if (e.startsWith("@")) {
        const domain = e.slice(1);
        if (domain && s.endsWith(`@${domain}`)) return true;
      }
      if (!e.includes("@") && s.endsWith(`@${e}`)) return true;
      if (e === s) return true;
    }
    return false;
  })();

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: CHANNEL_ID,
  });

  const hasControlCommand = core.channel.text.hasControlCommand(text, cfg);
  const commandGate = resolveControlCommandGate({
    useAccessGroups: cfg.commands?.useAccessGroups !== false,
    authorizers: [
      {
        configured: allowFrom.length > 0,
        allowed: senderAllowed,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });

  const commandAuthorized = commandGate.commandAuthorized;

  if (dmPolicy === "disabled") {
    runtime.log?.(`xmpp: drop DM sender=${senderId} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    const allowed = allowFrom.length === 0 ? false : senderAllowed;
    if (!allowed) {
      if (dmPolicy === "pairing") {
        // Only create pairing requests for senders that are NOT already allowed.
        // (e.g. if allowFrom includes *@quincy.snikket.chat, don't spam pairing codes.)
        if (!senderAllowed) {
          const { code } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderId,
            meta: { name: senderId },
          });

          if (shouldSendPairingHint(senderId)) {
            try {
              const hint = core.channel.pairing.buildPairingReply({
                channel: CHANNEL_ID,
                idLine: `Your XMPP JID: ${senderId}`,
                code,
              });
              // reply directly to sender
              await sendTextXmpp({ runtime: transport, toJid: replyJid, text: hint });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(`xmpp: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        }
      }

      runtime.log?.(`xmpp: drop DM sender=${senderId} (dmPolicy=${dmPolicy})`);
      return;
    }
  }

  if (commandGate.shouldBlock) {
    logInboundDrop({
      log: (m) => runtime.log?.(m),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  let route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "dm", id: senderId },
  });

  // Safety: some misconfigurations or legacy session routing can fall back to a generic
  // session key (e.g. "agent:main:main"), which can cause duplicate replies if a
  // per-peer DM session also exists. Enforce a deterministic per-peer DM session key here.
  const expectedPrefix = `agent:${route.agentId}:${CHANNEL_ID}:dm:`;
  const expectedSessionKey = `${expectedPrefix}${senderId}`;
  if (!route.sessionKey?.startsWith(expectedPrefix)) {
    runtime.warn?.(
      `xmpp: overriding unexpected sessionKey=${String(route.sessionKey)} -> ${expectedSessionKey}`,
    );
    route = { ...route, sessionKey: expectedSessionKey };
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

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: `xmpp:${senderId}`,
    To: `xmpp:${destId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: senderId,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: id,
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `xmpp:${destId}`,
    CommandAuthorized: commandAuthorized,
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
