/**
 * /.well-known/acc-skill.md — self-hosted merchant skill file.
 *
 * Must serve the exact bytes on disk so the sha256 the marketplace
 * re-computes matches what the CLI signed over. The portal is wired up
 * through a real http.Server so we test the full Node stack (route
 * matching, Content-Type, streaming) rather than a handler-level mock.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPortal } from "../portal.js";
import type { Config } from "../config.js";
import type { Server } from "node:http";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // ignore — test teardown best-effort
    }
  }
});

function makeSkillFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "acc-skill-"));
  const skillDir = join(dir, "skill");
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "acc-skill.md");
  writeFileSync(path, content);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

function makeConfig(accSkillMdPath: string, port: number): Config {
  return {
    platform: "shopify",
    mode: "manual",
    merchantDid: "did:test",
    portalPort: port,
    databaseUrl: "",
    webhookSecret: "",
    paymentAddress: "0x0",
    signerPrivateKey: "0x0",
    nexusCoreUrl: "https://nexus.example.com",
    checkoutBaseUrl: "https://checkout.example.com",
    selfUrl: `http://localhost:${port}`,
    portalToken: "",
    storeUrl: "https://s.myshopify.com",
    shopifyStoreUrl: "https://s.myshopify.com",
    shopifyStorefrontToken: "t",
    shopifyAdminToken: "",
    shopifyApiVersion: "2025-07",
    paymentCurrency: "USD",
    fixedRate: 1,
    rateLockMinutes: 5,
    accEncryptionKey: "",
    accSkillMdPath,
    provider: "nexus",
    chainId: 1,
  } as unknown as Config;
}

function listenOnEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
    });
  });
}

async function startHarness(
  content: string | null,
): Promise<{ baseUrl: string; server: Server; filePath: string | null }> {
  const filePath =
    content === null
      ? join(tmpdir(), `acc-skill-missing-${Date.now()}.md`)
      : makeSkillFile(content);
  const server = startPortal(makeConfig(filePath, 0));
  const port = await listenOnEphemeral(server);
  cleanups.push(() => server.close());
  return { baseUrl: `http://localhost:${port}`, server, filePath };
}

describe("GET /.well-known/acc-skill.md", () => {
  it("serves the exact bytes on disk with text/markdown content-type", async () => {
    const content = [
      "---",
      "name: My Store",
      "skill_id: my-store-v1",
      "---",
      "",
      "# My Store",
      "",
      "Hello \u4e2d\u6587 + \uD83D\uDE80",
      "",
    ].join("\n");

    const { baseUrl } = await startHarness(content);
    const res = await fetch(`${baseUrl}/.well-known/acc-skill.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);

    const served = Buffer.from(await res.arrayBuffer());
    expect(served).toEqual(Buffer.from(content));

    // sha256 parity — this is the whole point of the route.
    const expected = createHash("sha256").update(content).digest("hex");
    const actual = createHash("sha256").update(served).digest("hex");
    expect(actual).toBe(expected);
  });

  it("404s with a helpful hint when the file doesn't exist", async () => {
    const { baseUrl, filePath } = await startHarness(null);
    const res = await fetch(`${baseUrl}/.well-known/acc-skill.md`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { hint?: string };
    expect(body.hint).toContain(filePath!);
    expect(body.hint).toMatch(/acc skill init/);
  });

  it("returns the updated bytes after the file is edited (no caching)", async () => {
    const { baseUrl, filePath } = await startHarness("first\n");

    const res1 = await fetch(`${baseUrl}/.well-known/acc-skill.md`);
    expect(await res1.text()).toBe("first\n");

    writeFileSync(filePath!, "second\n");
    const res2 = await fetch(`${baseUrl}/.well-known/acc-skill.md`);
    expect(await res2.text()).toBe("second\n");
  });

  it("sets a content-length matching the byte count", async () => {
    const content = "a".repeat(123);
    const { baseUrl } = await startHarness(content);
    const res = await fetch(`${baseUrl}/.well-known/acc-skill.md`);
    expect(res.headers.get("content-length")).toBe("123");
  });

  it("does not serve the well-known path on non-GET requests", async () => {
    const { baseUrl } = await startHarness("ok\n");
    const res = await fetch(`${baseUrl}/.well-known/acc-skill.md`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(404);
  });
});
