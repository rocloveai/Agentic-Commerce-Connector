import type { StepContext, StepOutcome } from "./context.js";

export async function stepPreflight(ctx: StepContext): Promise<StepOutcome> {
  const isBun =
    typeof (process as unknown as { versions?: Record<string, string> }).versions?.bun === "string";

  // Under Bun (the distribution path) sqlite is statically linked into the
  // binary via bun:sqlite — nothing to resolve. Under Node (dev/tests) we
  // still require better-sqlite3 to be installable, because that's the
  // driver the Node fallback uses.
  if (isBun) {
    ctx.ui.ok("Runtime", `Bun ${process.versions.bun}`);
    return { applied: true, summary: `Bun ${process.versions.bun} + bun:sqlite OK` };
  }

  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (Number.isNaN(major) || major < 20) {
    throw new Error(
      `acc init requires Node >= 20 (found ${raw}). Upgrade Node and re-run.`,
    );
  }
  try {
    await import("better-sqlite3");
  } catch (err) {
    throw new Error(
      `better-sqlite3 failed to load (${err instanceof Error ? err.message : String(err)}). ` +
        "On Linux VPS hosts, install build-essential + python3 then re-run `npm install`.",
    );
  }
  ctx.ui.ok("Runtime", `Node ${raw}`);
  return { applied: true, summary: `Node ${raw} + better-sqlite3 OK` };
}
