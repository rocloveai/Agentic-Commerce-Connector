import { writeFileSync, existsSync } from "node:fs";
import { buildSkillMd, type SkillFrontmatter } from "@acc/skill-spec";
import type { StepContext, StepOutcome } from "./context.js";

const TEMPLATE_FRONTMATTER: SkillFrontmatter = {
  name: "My Store",
  description:
    "Short one-line pitch for the marketplace listing (<= 280 chars).",
  skill_id: "my-store-v1",
  categories: ["digital"],
  supported_platforms: ["custom"],
  supported_payments: ["stripe"],
  health_url: "https://store.example.com/health",
  tags: ["placeholder"],
  website_url: "https://store.example.com",
};

const TEMPLATE_BODY = `# My Store

Describe what your store exposes to AI agents. Replace the frontmatter
above and this body, then run \`acc publish\` to submit to the marketplace.
`;

export async function stepSkill(ctx: StepContext): Promise<StepOutcome> {
  if (existsSync(ctx.layout.skillMd) && !ctx.force) {
    ctx.ui.ok("Skill template", `${ctx.layout.skillMd} ${ctx.ui.s.dim("(preserved)")}`);
    return {
      applied: false,
      summary: `skill.md preserved (already at ${ctx.layout.skillMd})`,
    };
  }
  const content = buildSkillMd(TEMPLATE_FRONTMATTER, TEMPLATE_BODY);
  writeFileSync(ctx.layout.skillMd, content, { mode: 0o644, encoding: "utf-8" });
  ctx.config.skillMdPath = ctx.layout.skillMd;
  ctx.ui.ok("Skill template", ctx.layout.skillMd);
  return { applied: true, summary: `wrote skill template to ${ctx.layout.skillMd}` };
}
