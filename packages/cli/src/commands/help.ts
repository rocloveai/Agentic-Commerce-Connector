const TOP_LEVEL_HELP = `acc — Agentic Commerce Connector CLI

Usage:
  acc <command> [subcommand] [flags]

Setup:
  acc init [--data-dir=./acc-data] [--non-interactive]
      Interactive wizard: provisions acc-data/, generates keys, collects
      Shopify Partners creds, writes .env + config.json.

Shopify:
  acc shopify connect --shop=<X>.myshopify.com [--print-url-only]
      Build + print the OAuth install URL (with QR); poll until the shop
      completes install.
  acc shopify status                 (Phase 9+)
  acc shopify disconnect             (Phase 9+)

Skill:
  acc skill init [--out=PATH] [--force]
      Scaffold a skill.md template.
  acc skill edit                     (Phase 9+)
  acc skill validate                 (Phase 9+)

Marketplace:
  acc publish [FILE] [--url=URL] [--registry=URL] [--private-key=0x...]
      Sign + POST a skill.md to the marketplace. Zero-arg mode reads
      config.json for url/registry/key.

Wallet:
  acc wallet show
  acc wallet new --yes               (destructive)
  acc wallet import --key=0x...

Lifecycle:
  acc start [--data-dir=PATH]        Boot the connector in the foreground.
  acc doctor [--data-dir=PATH]       Verify config + reachability.
  acc upgrade [--version=X.Y.Z]      Re-run the install script to update.
  acc stop | status                  (Phase 9+)

Meta:
  acc version
  acc help [command]
`;

const TOPIC_HELP: Record<string, string> = {
  shopify: `acc shopify — Shopify integration commands

  acc shopify connect --shop=<X>.myshopify.com [--print-url-only]
      Print the install URL + a QR for phone scanning, then poll the
      local installation store until the shop appears.

Deferred to Phase 9+:
  acc shopify status
  acc shopify disconnect
`,
  skill: `acc skill — skill markdown commands

  acc skill init [--out=PATH] [--force]
      Write a skill.md template under acc-data/skill/acc-skill.md.

Deferred to Phase 9+:
  acc skill edit       # opens $EDITOR on acc-data/skill/acc-skill.md
  acc skill validate   # parses frontmatter, prints sha256
`,
  wallet: `acc wallet — marketplace signer management

  acc wallet show
      Print the wallet address (never the private key).

  acc wallet new --yes
      DESTRUCTIVE: regenerates signer.key. Requires --yes.

  acc wallet import --key=0x...
      Replace signer.key with an imported 32-byte hex private key.
`,
};

export async function runHelp(args: readonly string[]): Promise<void> {
  const topic = args[0];
  if (topic && topic in TOPIC_HELP) {
    process.stdout.write(TOPIC_HELP[topic]!);
    return;
  }
  process.stdout.write(TOP_LEVEL_HELP);
}

export function helpText(topic?: string): string {
  if (topic && topic in TOPIC_HELP) return TOPIC_HELP[topic]!;
  return TOP_LEVEL_HELP;
}
