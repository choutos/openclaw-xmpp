# OpenClaw XMPP (DMs)

XMPP DM channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Install

```bash
openclaw plugins install @ksmith221/openclaw-xmpp
openclaw gateway restart
```

## Configure

Add an XMPP account in your OpenClaw config (example keys may vary by OpenClaw version):

- `jid`: your full JID (e.g. `bot@your-server.example`)
- `password`: your XMPP password / app password
- `allowFrom`: optional allowlist for who may DM the agent (recommended)

Security note: prefer restrictive DM policies + explicit allowlists.

## Development

This plugin’s entry is `index.ts`. OpenClaw can load TypeScript at runtime.

## Privacy

This repo/package should contain **no credentials**. Put secrets only in your local OpenClaw config.
