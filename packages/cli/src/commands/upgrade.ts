// ---------------------------------------------------------------------------
// `acc upgrade` — self-update by re-running the canonical install script.
//
// The install script knows about platform detection, checksum verification,
// version pinning (ACC_VERSION env), and PATH management, so we delegate.
// This keeps upgrade logic in one place.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";

const INSTALL_URL = "https://get.xagenpay.com/install";

export async function runUpgrade(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const version = flags.get("version");

  process.stdout.write(`Fetching latest acc from ${INSTALL_URL} ...\n`);

  const env = { ...process.env };
  if (version) env.ACC_VERSION = version;

  const child = spawn("sh", ["-c", `curl -fsSL ${INSTALL_URL} | sh`], {
    stdio: "inherit",
    env,
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`installer exited with code ${code}`));
    });
    child.on("error", reject);
  });

  process.stdout.write(`\nRun 'acc version' to confirm.\n`);
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=", 2);
    if (k) map.set(k, v ?? "true");
  }
  return map;
}
