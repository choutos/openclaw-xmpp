import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let RUNTIME: PluginRuntime | null = null;

export function setXmppRuntime(runtime: PluginRuntime) {
  RUNTIME = runtime;
}

export function getXmppRuntime(): PluginRuntime {
  if (!RUNTIME) throw new Error("xmpp runtime not initialized");
  return RUNTIME;
}
