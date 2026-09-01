import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const env = process.env;
const run = (args: string[]) => execFileSync(args[0], args.slice(1), { encoding: "utf8" });
const pr = env.PR!;
const repo = env.REPO!;
const previewBranch = env.PREVIEW_BRANCH!;
const subdir = env.SUBDIR!;
const baseRef = env.BASE_REF!;
const base = `https://raw.githubusercontent.com/${repo}/${previewBranch}/${subdir}`;
const lines = ["<!-- app-screenshot-diff -->", "## App UI changes", "", `Current PR screenshots compared with \`${baseRef}\`.`, ""];
for (const file of readdirSync("pr-preview").filter((name) => name.endsWith("-after.png"))) {
  const name = file.slice(0, -"-after.png".length);
  const separator = name.indexOf("--");
  const status = separator >= 0 ? name.slice(0, separator) : "changed";
  const label = (separator >= 0 ? name.slice(separator + 2) : name).replaceAll("--", " ");
  const title = status[0].toUpperCase() + status.slice(1);
  lines.push(`### ${title}: ${label}`, "", "| Before | After | Diff |", "| --- | --- | --- |", `| ![before](${base}/${name}-before.png) | ![after](${base}/${name}-after.png) | ![diff](${base}/${name}-diff.png) |`, "");
}
lines.push(`<sub>Rendered from Storybook and responsive app screenshot tests against \`${baseRef}\`.</sub>`);
writeFileSync("body.md", `${lines.join("\n")}\n`);
const ids = run(["gh", "api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[] | select(.body | contains(\"<!-- app-screenshot-diff -->\")) | .id"]).trim();
for (const id of ids ? ids.split(/\s+/) : []) run(["gh", "api", "--method", "DELETE", `repos/${repo}/issues/comments/${id}`]);
run(["gh", "api", `repos/${repo}/issues/${pr}/comments`, "-F", "body=@body.md"]);
run(["gh", "label", "create", "ui change", "--repo", repo, "--color", "FFC0CB", "--description", "Pull request changes rendered dashboard UI"]);
run(["gh", "pr", "edit", pr, "--repo", repo, "--add-label", "ui change"]);
