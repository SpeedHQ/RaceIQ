import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.PREVIEW_ROOT;
if (!root) throw new Error("PREVIEW_ROOT is required");

const previews = [
  join(root, "pr-visual-responsive-preview"),
  join(root, "pr-visual-storybook-preview"),
];
const output = "pr-preview";
mkdirSync(output, { recursive: true });

const metadata = previews.map((directory) => ({
  pr: readFileSync(join(directory, "pr-number.txt"), "utf8").trim(),
  baseRef: readFileSync(join(directory, "base-ref.txt"), "utf8").trim(),
}));
const responsive = metadata[0]!;
const storybook = metadata[1]!;
if (responsive.pr !== storybook.pr || responsive.baseRef !== storybook.baseRef) {
  throw new Error("Visual preview artifacts refer to different pull requests or base revisions");
}

writeFileSync(join(output, "pr-number.txt"), responsive.pr);
writeFileSync(join(output, "base-ref.txt"), responsive.baseRef);
for (const directory of previews) {
  for (const name of ["base-responsive", "current-responsive", "base-storybook", "current-storybook"]) {
    const source = join(directory, name);
    if (!existsSync(source)) continue;
    const target = join(output, name);
    if (existsSync(target)) throw new Error(`Duplicate visual render directory: ${name}`);
    cpSync(source, target, { recursive: true });
  }
}
