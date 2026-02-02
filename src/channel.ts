import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
  type ChannelPlugin,
  type ChannelSetupInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";

import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  type CoreConfig,
  type ResolvedXmppAccount,
} from "./accounts.js";
// (no zod schema import)
import { handleXmppInbound } from "./inbound.js";
import { sendTextXmpp } from "./send.js";
import { startXmppClient, type XmppAccountRuntime } from "./transport.js";
import * as xmppXml from "@xmpp/xml";

const meta = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (Snikket / Prosody / ejabberd)",
  docsPath: "/channels/xmpp",
  docsLabel: "xmpp",
  blurb: "XMPP chat via direct messages.",
  aliases: ["jabber"],
  order: 90,
  quickstartAllowFrom: true,
};

type XmppSetupInput = ChannelSetupInput & {
  jid?: string;
  password?: string;
  service?: string;
};

const xml = (() => {
  const anyXml = xmppXml as any;
  return anyXml.xml ?? anyXml.default ?? anyXml;
})();

const runtimes = new Map<string, XmppAccountRuntime>();

export const xmppPlugin: ChannelPlugin<ResolvedXmppAccount> = {
  id: "xmpp",
  meta,
  pairing: {
    idLabel: "jid",
    normalizeAllowEntry: (entry) => entry.replace(/^(xmpp|jabber):/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      console.log(`[xmpp] JID approved for pairing: ${id}`);
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.xmpp"] },
  // Config schema is provided as plain JSON Schema to avoid runtime zod dependency.
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        jid: { type: "string" },
        password: { type: "string" },
        service: { type: "string" },
        dmPolicy: { type: "string", enum: ["open", "pairing", "disabled"] },
        allowFrom: { type: "array", items: { type: "string" } },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: true,
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              jid: { type: "string" },
              password: { type: "string" },
              service: { type: "string" },
              dmPolicy: { type: "string", enum: ["open", "pairing", "disabled"] },
              allowFrom: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  },
  config: {
    listAccountIds: (cfg) => listXmppAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultXmppAccountId(cfg as CoreConfig),
    isConfigured: (account) => Boolean(account.jid?.trim() && account.password?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.jid?.trim() && account.password?.trim()),
      jid: account.jid ? "[set]" : "[missing]",
      password: account.password ? "[set]" : "[missing]",
      service: account.service ? account.service : "[default]",
    }),
    resolveAllowFrom: async ({ cfg, accountId }) => {
      const a = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
      return (a.config.allowFrom ?? []).map((x) => String(x).toLowerCase());
    },
    formatAllowFrom: ({ allowFrom }) =>
      (allowFrom ?? [])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .map((x) => x.replace(/^(xmpp|jabber):/i, ""))
        .map((x) => x.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.xmpp?.accounts?.[resolvedId]);
      const basePath = useAccountPath
        ? `channels.xmpp.accounts.${resolvedId}.`
        : "channels.xmpp.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("xmpp"),
        normalizeEntry: (raw) => raw.replace(/^(xmpp|jabber):/i, "").toLowerCase(),
      };
    },
    collectWarnings: ({ account }) => {
      if ((account.config.dmPolicy ?? "pairing") === "open") {
        return [
          `- XMPP DMs: dmPolicy=\"open\" allows any JID to trigger the agent. Prefer dmPolicy=\"pairing\" or set allowFrom.`,
        ];
      }
      return [];
    },
  },
  messaging: {
    normalizeTarget: (raw) => String(raw).trim(),
    targetResolver: {
      looksLikeId: (raw) => /@/.test(String(raw)),
      hint: "<jid>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    validateInput: ({ input }) => {
      const i = input as XmppSetupInput;
      if (!i.jid) return "XMPP setup requires --jid";
      if (!i.password) return "XMPP setup requires --password";
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const i = input as XmppSetupInput;
      const next = { ...(cfg as OpenClawConfig) };
      if (!next.channels) next.channels = {};
      const section = (next.channels.xmpp ?? {}) as any;
      section.enabled = true;

      if ((accountId ?? DEFAULT_ACCOUNT_ID) === DEFAULT_ACCOUNT_ID) {
        section.jid = i.jid;
        section.password = i.password;
        if (i.service) section.service = i.service;
      } else {
        section.accounts = section.accounts ?? {};
        section.accounts[accountId] = {
          ...(section.accounts[accountId] ?? {}),
          enabled: true,
          jid: i.jid,
          password: i.password,
          ...(i.service ? { service: i.service } : {}),
        };
      }
      next.channels.xmpp = section;
      return next;
    },
  },
  status: {
    describeAccountRuntime: async ({ accountId }) => {
      const rt = runtimes.get(accountId);
      return {
        mode: "xmpp",
        lastInboundAt: rt?.lastInboundAt ?? null,
        lastOutboundAt: rt?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.jid || !account.password) {
        throw new Error(
          `XMPP not configured for account "${account.accountId}" (missing jid or password)`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting XMPP client for ${account.jid}`);

      const { runtime: transport, stop } = await startXmppClient({
        accountId: account.accountId,
        jid: account.jid,
        password: account.password,
        service: account.service,
        log: (line) => ctx.log?.info(line),
        abortSignal: ctx.abortSignal,
        onStanza: (transportRuntime, stanza) => {
          if (stanza?.is?.("presence")) {
            const type = stanza.attrs?.type;
            const from = stanza.attrs?.from;
            if (type === "subscribe" && from && transportRuntime.client) {
              ctx.log?.info(`[${account.accountId}] auto-approving subscription from ${from}`);
              void transportRuntime.client.send(xml("presence", { to: from, type: "subscribed" }));
              void transportRuntime.client.send(xml("presence", { to: from, type: "subscribe" }));
              return;
            }
          }
          // fire and forget
          void handleXmppInbound({
            stanza,
            account,
            cfg: ctx.cfg as OpenClawConfig,
            runtime: ctx.runtime,
            transport: transportRuntime,
            abortSignal: ctx.abortSignal,
            statusSink: (patch) => {
              if (patch.lastInboundAt) transportRuntime.lastInboundAt = patch.lastInboundAt;
              if (patch.lastOutboundAt) transportRuntime.lastOutboundAt = patch.lastOutboundAt;
              ctx.setStatus({ accountId: ctx.accountId, ...patch });
            },
          });
        },
      });

      runtimes.set(account.accountId, transport);

      return {
        stop: async () => {
          runtimes.delete(account.accountId);
          await stop();
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const rt = runtimes.get(id);
      if (!rt) {
        return { channel: "xmpp", ok: false, error: `account ${id} not started` };
      }
      const result = await sendTextXmpp({ runtime: rt, toJid: to, text });
      return { channel: "xmpp", ...result } as any;
    },
    sendMedia: async ({ accountId }) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      return {
        channel: "xmpp",
        ok: false,
        error: `media not supported for xmpp account ${id}`,
      };
    },
  },
};
