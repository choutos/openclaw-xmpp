import { describe, expect, it } from "vitest";

import { listXmppAccountIds, resolveXmppAccount } from "./accounts.js";

describe("XMPP account config", () => {
  it("resolves top-level credentials as the default account", () => {
    const cfg = {
      channels: {
        xmpp: {
          jid: "bot@example.com",
          password: "secret",
          dmPolicy: "pairing",
        },
      },
    } as never;

    expect(listXmppAccountIds(cfg)).toEqual(["default"]);
    expect(resolveXmppAccount({ cfg })).toMatchObject({
      accountId: "default",
      enabled: true,
      jid: "bot@example.com",
      password: "secret",
      config: { dmPolicy: "pairing" },
    });
  });

  it("lets account config override root defaults", () => {
    const cfg = {
      channels: {
        xmpp: {
          jid: "default@example.com",
          password: "root-secret",
          accounts: {
            work: {
              jid: "bot@work.example",
              password: "work-secret",
              allowFrom: ["alice@work.example"],
            },
          },
        },
      },
    } as never;

    expect(listXmppAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveXmppAccount({ cfg, accountId: "work" })).toMatchObject({
      accountId: "work",
      jid: "bot@work.example",
      password: "work-secret",
      config: { allowFrom: ["alice@work.example"] },
    });
  });

  it("honors global and account disable flags", () => {
    const cfg = {
      channels: {
        xmpp: {
          enabled: false,
          accounts: { work: { jid: "bot@work.example", password: "secret" } },
        },
      },
    } as never;

    expect(resolveXmppAccount({ cfg, accountId: "work" }).enabled).toBe(false);
  });
});
