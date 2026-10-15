export function bareJid(value: string): string {
  return value.trim().split("/", 1)[0].toLowerCase();
}

export function isValidBareJid(value: string): boolean {
  const jid = bareJid(value);
  const at = jid.indexOf("@");
  return at > 0 && at === jid.lastIndexOf("@") && at < jid.length - 1 && !/\s/.test(jid);
}

export function normalizeAllowEntry(value: string): string {
  return value.trim().replace(/^(?:xmpp|jabber):/i, "").toLowerCase();
}

export function jidMatchesPattern(value: string, pattern: string): boolean {
  const jid = bareJid(value);
  const normalized = normalizeAllowEntry(pattern);
  if (normalized === "*") return true;
  if (normalized.startsWith("*@")) {
    const domain = normalized.slice(2);
    return Boolean(domain) && jid.endsWith(`@${domain}`);
  }
  return jid === bareJid(normalized);
}

export function isJidAllowed(value: string, allowFrom: readonly string[]): boolean {
  return allowFrom.some((pattern) => jidMatchesPattern(value, pattern));
}

export function validateServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["xmpp:", "xmpps:", "ws:", "wss:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const matchXmppIngressEntry: NonNullable<ChannelIngressIdentityDescriptor["matchEntry"]> = ({
  subject,
  entry,
}) => {
  if (!entry.value.startsWith("*@")) return undefined;
  const domain = entry.value.slice(2);
  return Boolean(domain) && subject.identifiers.some((identifier) => identifier.value.endsWith(`@${domain}`));
};

export const xmppIngressIdentity = defineStableChannelIngressIdentity({
  key: "xmpp-jid",
  authentication: "asserted",
  normalizeEntry: (value) => normalizeAllowEntry(value) || null,
  normalizeSubject: (value) => (isValidBareJid(value) ? bareJid(value) : null),
  sensitivity: "pii",
  isWildcardEntry: (value) => normalizeAllowEntry(value) === "*",
  matchEntry: matchXmppIngressEntry,
});
import {
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentityDescriptor,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
