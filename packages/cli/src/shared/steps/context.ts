import type { Prompter } from "../prompts.js";
import type { DataDirLayout } from "../data-dir.js";
import type { AccConfig } from "../config-store.js";

export interface StepContext {
  /** Fully-resolved data-dir layout. */
  layout: DataDirLayout;
  /** Interactive prompter. In tests, pass a mock PromptIO. */
  prompter: Prompter;
  /** Raw CLI flags passed to `acc init`. */
  flags: ReadonlyMap<string, string>;
  /** Whether --force was passed. */
  force: boolean;
  /** Mutable config being accumulated; steps patch and later saveConfig writes. */
  config: Partial<AccConfig> & { wallet?: AccConfig["wallet"] };
  /** Non-interactive seed (for --non-interactive mode / tests). */
  seed?: Partial<NonInteractiveSeed>;
}

export interface NonInteractiveSeed {
  readonly selfUrl: string;
  readonly registry: string;
  readonly chainId: number;
  readonly shopifyClientId: string;
  readonly shopifyClientSecret: string;
  /** "generate" | "skip" | hex-private-key */
  readonly signer: string;
  /** Optional passphrase when signer should be encrypted at rest. */
  readonly signerPassphrase?: string;
  /** Payout wallet address (0x + 40 hex). Defaults to signer address if omitted. */
  readonly paymentAddress?: string;
}

export interface StepOutcome {
  readonly applied: boolean;
  readonly summary: string;
}
