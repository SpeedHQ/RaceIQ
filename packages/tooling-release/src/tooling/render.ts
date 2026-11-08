import {
  RELEASE_HEADING,
  RELEASE_SECTION_ORDER,
  type ChangelogEntry,
} from "./sections";

export function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid release date");
  return date.toISOString().slice(0, 10);
}

function cleanBlock(block: string): string {
  return block.trim().replace(/\n{3,}/g, "\n\n");
}
export function renderReleaseBody(markdown: string): string {
  const sections = new Map<string, string>();
  const heading = /^###\s+(.+)\s*$/gm;
  const headings = [...markdown.matchAll(heading)];

  for (let i = 0; i < headings.length; i++) {
    const name = headings[i][1].trim();
    if (name === "Internal" || !RELEASE_SECTION_ORDER.includes(name as (typeof RELEASE_SECTION_ORDER)[number])) continue;
    const start = (headings[i].index ?? 0) + headings[i][0].length;
    const next = headings[i + 1]?.index ?? markdown.length;
    const body = cleanBlock(markdown.slice(start, next));
    if (body) sections.set(name, body);
  }

  return RELEASE_SECTION_ORDER
    .filter((name) => sections.has(name))
    .map((name) => `### ${name}\n${sections.get(name)}`)
    .join("\n\n");
}

export function renderUnreleasedBody(markdown: string): string {
  const nextHeading = markdown.search(/^##\s+/m);
  return renderReleaseBody(markdown.slice(0, nextHeading < 0 ? markdown.length : nextHeading));
}


export function parseChangelog(markdown: string): ChangelogEntry[] {
  const releases = [...markdown.matchAll(RELEASE_HEADING)];
  return releases.map((release, index) => {
    const start = (release.index ?? 0) + release[0].length;
    const end = releases[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    const notes = renderReleaseBody(section);
    return {
      version: release[1],
      date: release[2] ?? "",
      notes,
      breaking: /^###\s+Breaking\s*$/m.test(section),
    };
  }).filter((entry) => entry.notes.length > 0);
}

export function renderAllReleaseNotes(markdown: string, release?: { version: string; date?: string }): string {
  const blocks: string[] = [];
  const unreleased = renderUnreleasedBody(markdown);
  if (unreleased) {
    const heading = release ? `## v${release.version}${release.date ? ` - ${release.date}` : ""}\n\n` : "";
    blocks.push(`${heading}${unreleased}`);
  }
  for (const entry of parseChangelog(markdown)) {
    blocks.push(`## v${entry.version}${entry.date ? ` - ${entry.date}` : ""}\n\n${entry.notes}`);
  }
  return blocks.join("\n\n");
}

export function rolloverChangelog(markdown: string, release: { version: string; date: string }): string {
  const nextHeading = markdown.search(/^##\s+/m);
  const end = nextHeading < 0 ? markdown.length : nextHeading;
  const body = markdown.slice(0, end).trim();
  if (!/^###\s+/m.test(body)) throw new Error("No pending release sections found");
  const released = `## v${release.version} - ${release.date}${body ? `\n\n${body}` : ""}`;
  const history = markdown.slice(end).trim();
  return `${released}${history ? `\n\n${history}` : ""}`;
}
