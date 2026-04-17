// ---------------------------------------------------------------------------
// Pure string-routing for the `acc` CLI. Given argv (without the node binary
// and script name), return either a handler key + residual args, or an error
// message. No side effects — keeps dispatch testable without exec'ing a
// subprocess.
// ---------------------------------------------------------------------------

export interface RouteMatch {
  readonly handler: HandlerKey;
  readonly args: string[];
}

export type RouteResult = RouteMatch | { readonly error: string };

export type HandlerKey =
  | "help"
  | "version"
  | "init"
  | "publish"
  | "start"
  | "upgrade"
  | "doctor"
  | "shopify.connect"
  | "skill.init"
  | "skill.edit"
  | "skill.validate"
  | "wallet.show"
  | "wallet.new"
  | "wallet.import"
  | "placeholder";

const PLACEHOLDERS = new Set(["stop", "status"]);

const SHOPIFY_PLACEHOLDERS = new Set(["status", "disconnect"]);

export function route(argv: readonly string[]): RouteResult {
  if (argv.length === 0) return { handler: "help", args: [] };

  const first = argv[0]!;
  const rest = argv.slice(1);

  // Top-level flags short-circuit
  if (first === "--help" || first === "-h" || first === "help") {
    return { handler: "help", args: rest };
  }
  if (first === "--version" || first === "version") {
    return { handler: "version", args: rest };
  }

  // Nested domains first
  if (first === "shopify") return routeShopify(rest);
  if (first === "skill") return routeSkill(rest);
  if (first === "wallet") return routeWallet(rest);

  if (first === "init") return { handler: "init", args: rest };
  if (first === "publish") return { handler: "publish", args: rest };
  if (first === "start") return { handler: "start", args: rest };
  if (first === "upgrade") return { handler: "upgrade", args: rest };
  if (first === "doctor") return { handler: "doctor", args: rest };

  if (PLACEHOLDERS.has(first)) {
    return { handler: "placeholder", args: [first, ...rest] };
  }

  return { error: `unknown command: ${first}` };
}

function routeShopify(rest: readonly string[]): RouteResult {
  if (rest.length === 0) return { handler: "help", args: ["shopify"] };
  const verb = rest[0]!;
  const tail = rest.slice(1);
  if (verb === "connect") return { handler: "shopify.connect", args: tail };
  if (SHOPIFY_PLACEHOLDERS.has(verb)) {
    return { handler: "placeholder", args: ["shopify", verb, ...tail] };
  }
  return { error: `unknown shopify subcommand: ${verb}` };
}

function routeSkill(rest: readonly string[]): RouteResult {
  if (rest.length === 0) return { handler: "help", args: ["skill"] };
  const verb = rest[0]!;
  const tail = rest.slice(1);
  if (verb === "init") return { handler: "skill.init", args: tail };
  if (verb === "edit") return { handler: "skill.edit", args: tail };
  if (verb === "validate") return { handler: "skill.validate", args: tail };
  return { error: `unknown skill subcommand: ${verb}` };
}

function routeWallet(rest: readonly string[]): RouteResult {
  if (rest.length === 0) return { handler: "help", args: ["wallet"] };
  const verb = rest[0]!;
  const tail = rest.slice(1);
  if (verb === "show") return { handler: "wallet.show", args: tail };
  if (verb === "new") return { handler: "wallet.new", args: tail };
  if (verb === "import") return { handler: "wallet.import", args: tail };
  return { error: `unknown wallet subcommand: ${verb}` };
}
