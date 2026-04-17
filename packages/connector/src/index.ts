// Public entry for library consumers (the CLI, tests, future SDKs). Emits
// only what lives behind a stable interface — the server boot function and
// configuration loader. Internal modules remain reachable via deep imports
// for tests, but are not part of the supported surface.

export { startServer } from "./server.js";
export type { StartServerOptions } from "./server.js";
export { loadConfig } from "./config.js";
export type { Config } from "./config.js";
