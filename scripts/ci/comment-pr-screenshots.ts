import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const env = process.env;
const pr = env.PR || readFileSync("pr-preview/pr-number.txt", "utf8").trim();
const repo = env.REPO!;
const previewBranch = env.PREVIEW_BRANCH!;
const subdir = env.SUBDIR!;
const baseRef = env.BASE_REF!;
const base = `https://raw.githubusercontent.com/${repo}/${previewBranch}/${subdir}`;
const apiBase = "https://api.github.com";
const token = env.GH_TOKEN;

if (!token) throw new Error("GH_TOKEN is required");
if (!pr) throw new Error("PR number is required");

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body}`);
  }
  return response;
}

const lines = ["<!-- app-screenshot-diff -->", "## App UI changes", "", `Current PR screenshots compared with \`${baseRef}\`.`, ""];
for (const file of readdirSync("pr-preview").filter((name) => name.endsWith("-after.png"))) {
  const name = file.slice(0, -"-after.png".length);
  const separator = name.indexOf("--");
  const status = separator >= 0 ? name.slice(0, separator) : "changed";
  const label = (separator >= 0 ? name.slice(separator + 2) : name).replaceAll("--", " ");
  const title = status[0].toUpperCase() + status.slice(1);
  lines.push(`### ${title}: ${label}`, "", "| Base | PR | Diff |", "| --- | --- | --- |", `| ![base](${base}/${name}-before.png) | ![pr](${base}/${name}-after.png) | ![diff](${base}/${name}-diff.png) |`, "");
}
lines.push(`<sub>Rendered from Storybook and responsive app screenshot tests against \`${baseRef}\`.</sub>`);
writeFileSync("body.md", `${lines.join("\n")}\n`);

const commentsResponse = await github(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
const comments = (await commentsResponse.json()) as Array<{ id: number; body?: string }>;
for (const comment of comments.filter((item) => item.body?.includes("<!-- app-screenshot-diff -->"))) {
  await github(`/repos/${repo}/issues/comments/${comment.id}`, { method: "DELETE" });
}

await github(`/repos/${repo}/issues/${pr}/comments`, {
  method: "POST",
  body: JSON.stringify({ body: readFileSync("body.md", "utf8") }),
});

const labelsResponse = await github(`/repos/${repo}/labels?per_page=100`);
const labels = (await labelsResponse.json()) as Array<{ name: string }>;
if (!labels.some((label) => label.name === "ui change")) {
  await github(`/repos/${repo}/labels`, {
    method: "POST",
    body: JSON.stringify({ name: "ui change", color: "FFC0CB", description: "Pull request changes rendered dashboard UI" }),
  });
}
await github(`/repos/${repo}/issues/${pr}/labels`, {
  method: "POST",
  body: JSON.stringify({ labels: ["ui change"] }),
});
