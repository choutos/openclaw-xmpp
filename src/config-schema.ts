// NOTE: This file originally used zod for schema validation.
// In this environment, the Gateway's plugin loader may not resolve plugin-local node_modules
// reliably, so we avoid importing external deps here.
//
// The channel now provides a plain JSON Schema inline (see channel.ts).

export const XmppAccountSchema = null;
export const XmppConfigSchema = null;
