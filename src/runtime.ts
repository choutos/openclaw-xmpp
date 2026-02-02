import type { RuntimeEnv } from "openclaw/plugin-sdk";

let RUNTIME: RuntimeEnv | null = null;

export function setXmppRuntime(runtime: RuntimeEnv) {
  RUNTIME = runtime;
}

export function getXmppRuntime(): RuntimeEnv {
  if (!RUNTIME) throw new Error("xmpp runtime not initialized");
  return RUNTIME;
}
