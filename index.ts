import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { xmppPlugin } from "./src/channel.js";
import { setXmppRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin (DMs) for OpenClaw",
  plugin: xmppPlugin,
  setRuntime: setXmppRuntime,
});
