import { ensureDataDir } from "../data-dir.js";
import type { StepContext, StepOutcome } from "./context.js";

export async function stepDataDir(ctx: StepContext): Promise<StepOutcome> {
  // Layout is created by the orchestrator before step 1 to support
  // re-entrance detection. This step just re-applies permissions and
  // reports the location.
  const layout = ensureDataDir(ctx.layout.root);
  ctx.layout = layout;
  ctx.ui.ok("Data directory", layout.root);
  return {
    applied: true,
    summary: `Data dir ready at ${layout.root}`,
  };
}
