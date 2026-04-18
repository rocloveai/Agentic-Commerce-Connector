// Inline JSON import so the version string is baked into the compiled
// binary at build time. Bun's `--compile` virtual FS does NOT ship the
// original package.json alongside, so the prior `readFileSync` approach
// returned ENOENT in production.
import pkg from "../../package.json" with { type: "json" };

export function getVersion(): string {
  return (pkg as { version?: string }).version ?? "0.0.0";
}

export async function runVersion(): Promise<void> {
  process.stdout.write(`acc ${getVersion()}\n`);
}
