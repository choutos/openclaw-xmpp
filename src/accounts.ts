import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";

// (no zod schema import)

export type CoreConfig = OpenClawConfig;

export type ResolvedXmppAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;

  jid?: string;
  password?: string;
  service?: string;

  config: {
    dmPolicy?: "open" | "pairing" | "disabled";
    allowFrom?: string[];
  };
};

export function listXmppAccountIds(cfg: CoreConfig): string[] {
  const section = cfg.channels?.xmpp;
  const accounts = section?.accounts && typeof section.accounts === "object" ? section.accounts : {};
  const ids = Object.keys(accounts);
  // If top-level credentials exist, default account exists even if not explicitly in accounts.
  if (
    ids.length === 0 ||
    section?.jid ||
    section?.password ||
    section?.service
  ) {
    if (!ids.includes(DEFAULT_ACCOUNT_ID)) ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}

export function resolveDefaultXmppAccountId(cfg: CoreConfig): string {
  const section: any = cfg.channels?.xmpp ?? {};
  const accounts = section.accounts && typeof section.accounts === "object" ? section.accounts : null;

  if (accounts) {
    const ids = Object.keys(accounts);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
    if (ids.length > 0) return ids[0];
  }

  return DEFAULT_ACCOUNT_ID;
}

export function resolveXmppAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedXmppAccount {
  const { cfg } = params;
  const accountId = (params.accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;

  const section: any = cfg.channels?.xmpp ?? {};

  const fromAccounts = section.accounts?.[accountId];
  const merged = {
    enabled: section.enabled !== false,
    name: fromAccounts?.name,
    jid: fromAccounts?.jid ?? section.jid,
    password: fromAccounts?.password ?? section.password,
    service: fromAccounts?.service ?? section.service,
    dmPolicy: fromAccounts?.dmPolicy ?? section.dmPolicy,
    allowFrom: (fromAccounts?.allowFrom ?? section.allowFrom) as string[] | undefined,
  };

  return {
    accountId,
    enabled: merged.enabled && (fromAccounts?.enabled !== false),
    name: merged.name,
    jid: merged.jid,
    password: merged.password,
    service: merged.service,
    config: {
      dmPolicy: merged.dmPolicy,
      allowFrom: merged.allowFrom,
    },
  };
}
