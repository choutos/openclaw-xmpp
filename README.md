# OpenClaw XMPP

An experimental, community-maintained XMPP/Jabber direct-message channel for
[OpenClaw](https://github.com/openclaw/openclaw).

## Status

The current release deliberately supports a small surface:

- direct text messages
- pairing and JID allowlists
- multiple XMPP accounts
- TCP/STARTTLS or WebSocket service URLs supported by `xmpp.js`
- message-carbon filtering and short-window duplicate suppression

MUC rooms, media upload, reactions, delivery receipts, and OMEMO are not yet
supported. They should be added only with interoperable server/client tests.

Requires OpenClaw 2026.9.9 or newer.

## Install

Until a reviewed ClawHub release exists, install from GitHub:

```bash
openclaw plugins install git:github.com/choutos/openclaw-xmpp@main
openclaw gateway restart
```

## Configure

Add the channel to `openclaw.json`:

```json5
{
  channels: {
    xmpp: {
      enabled: true,
      jid: "bot@example.com",
      password: "use-an-app-password",
      // Optional. Defaults to xmpp://<JID-domain>:5222.
      service: "xmpp://example.com:5222",
      dmPolicy: "pairing",
      allowFrom: ["alice@example.com", "*@trusted.example"],
    },
  },
}
```

Restart the Gateway, then check the account:

```bash
openclaw channels status --probe
```

`dmPolicy` defaults to `pairing`. Allowlist entries are exact bare JIDs,
`*@domain` wildcards, or `*`. Resources such as `/phone` are ignored for access
checks. Domain-name shorthand is intentionally unsupported to avoid accidental
authorization.

For multiple accounts, put the same fields under
`channels.xmpp.accounts.<accountId>`.

## Security

- Prefer an app-specific XMPP password and `dmPolicy: "pairing"`.
- Avoid `allowFrom: ["*"]` unless any federated JID may invoke the agent.
- Do not commit credentials. OpenClaw configuration must be readable only by
  the service account.
- `OPENCLAW_XMPP_DEBUG=1` enables protocol debugging and may expose message
  content in logs. Do not use it in production.

## Development

```bash
npm install
npm run check
npm test
```

`openclaw plugins validate` currently targets tool/feature authoring metadata
and rejects channel-only packages, including OpenClaw's bundled IRC channel.
Use an isolated `plugins install --link` plus `plugins doctor` for channel
loading checks.

## Provenance

This repository started from Kevin Smith's MIT-licensed
[`ksmith211/openclaw-xmpp`](https://github.com/ksmith211/openclaw-xmpp). Its
current SDK port and security review were informed by Mickaël Rémond's earlier
[OpenClaw XMPP PR #9741](https://github.com/openclaw/openclaw/pull/9741).
