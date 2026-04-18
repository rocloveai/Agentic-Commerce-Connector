import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync } from "node:fs";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../commands/init.js";
import type { PromptIO } from "../shared/prompts.js";
import { loadConfig } from "../shared/config-store.js";

function queueIO(answers: string[]): PromptIO {
  const q = [...answers];
  return {
    ask: async () => (q.length ? q.shift()! : ""),
    askSecret: async () => (q.length ? q.shift()! : ""),
    close: () => undefined,
  };
}

const SEED = {
  selfUrl: "https://acc.example.com",
  registry: "https://api.siliconretail.com",
  chainId: 1,
  shopifyStoreUrl: "xstore-test.myshopify.com",
  shopifyAdminToken: "shpat_test_admin_token",
  shopifyStorefrontToken: "test_storefront_token",
  signer: "generate" as const,
};

describe("runInit — non-interactive seed (full 8-step path)", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "acc-wizard-"));
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the full acc-data/* tree with expected files + perms", async () => {
    const dataDir = join(tmp, "acc-data");
    await runInit([`--data-dir=${dataDir}`], {
      io: queueIO([]),
      seed: SEED,
    });

    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
    expect(existsSync(join(dataDir, ".env"))).toBe(true);
    expect(existsSync(join(dataDir, "keys/enc.key"))).toBe(true);
    expect(existsSync(join(dataDir, "keys/signer.key"))).toBe(true);
    expect(existsSync(join(dataDir, "db/acc.sqlite"))).toBe(true);
    expect(existsSync(join(dataDir, "skill/acc-skill.md"))).toBe(true);

    // Perms
    expect(statSync(join(dataDir, "keys/enc.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "keys/signer.key")).mode & 0o777).toBe(0o600);
  });

  it("records wallet address in config.json with encrypted=false", async () => {
    const dataDir = join(tmp, "acc-data");
    await runInit([`--data-dir=${dataDir}`], { io: queueIO([]), seed: SEED });
    const cfg = loadConfig(join(dataDir, "config.json"));
    expect(cfg?.wallet?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(cfg?.wallet?.encrypted).toBe(false);
  });

  it("writes SHOPIFY + SELF_URL + ACC_ENCRYPTION_KEY into .env", async () => {
    const dataDir = join(tmp, "acc-data");
    await runInit([`--data-dir=${dataDir}`], { io: queueIO([]), seed: SEED });
    const env = readFileSync(join(dataDir, ".env"), "utf-8");
    expect(env).toContain("SELF_URL=https://acc.example.com");
    expect(env).toContain("SHOPIFY_STORE_URL=https://xstore-test.myshopify.com");
    expect(env).toContain("SHOPIFY_ADMIN_TOKEN=shpat_test_admin_token");
    expect(env).toContain("SHOPIFY_STOREFRONT_TOKEN=test_storefront_token");
    expect(env).toMatch(/ACC_ENCRYPTION_KEY=[0-9a-f]{64}/);
  });

  it("regenerates signer on --force (old signer is backed up, fresh identity)", async () => {
    const dataDir = join(tmp, "acc-data");
    await runInit([`--data-dir=${dataDir}`], { io: queueIO([]), seed: SEED });
    const firstWallet = loadConfig(join(dataDir, "config.json"))?.wallet?.address;

    await runInit([`--data-dir=${dataDir}`, "--force"], {
      io: queueIO([]),
      seed: SEED,
    });
    const secondWallet = loadConfig(join(dataDir, "config.json"))?.wallet?.address;
    // --force (start-over reset) moves the existing signer.key to a
    // timestamped .bak file and regenerates, so the second wallet must
    // differ from the first. This is a deliberate change from v0.7.3
    // where --force silently preserved signer.key.
    expect(secondWallet).not.toBe(firstWallet);
    expect(secondWallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Previous signer is recoverable from the .bak alongside signer.key.
    const signerDir = join(dataDir, "keys");
    const names = readdirSync(signerDir);
    expect(names.some((n) => n.startsWith("signer.key.bak."))).toBe(true);
  });
});

describe("runInit — re-entrance menu", () => {
  let tmp: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "acc-wizard-re-"));
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns early on choice (a) keep as-is", async () => {
    const dataDir = join(tmp, "acc-data");
    await runInit([`--data-dir=${dataDir}`], { io: queueIO([]), seed: SEED });
    // Now exists — simulate interactive re-entry choosing (a)
    const env0 = readFileSync(join(dataDir, ".env"), "utf-8");
    await runInit([`--data-dir=${dataDir}`], {
      io: queueIO(["a"]), // ask choice answers 'a'
      seed: undefined, // interactive path
    });
    const env1 = readFileSync(join(dataDir, ".env"), "utf-8");
    expect(env1).toBe(env0);
  });

  it("returns early on choice (d) cancel", async () => {
    const dataDir = join(tmp, "acc-data");
    // Seed an existing config manually
    const { ensureDataDir } = await import("../shared/data-dir.js");
    ensureDataDir(dataDir);
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        dataVersion: 1,
        registry: "https://api.siliconretail.com",
        chainId: 1,
        selfUrl: "https://acc.example.com",
        skillMdPath: "./acc-data/skill/acc-skill.md",
      }),
      "utf-8",
    );
    await runInit([`--data-dir=${dataDir}`], { io: queueIO(["d"]) });
    // no .env created because wizard short-circuited
    expect(existsSync(join(dataDir, ".env"))).toBe(false);
  });
});
