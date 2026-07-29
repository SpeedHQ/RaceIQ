export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string;
  breaking: boolean;
}

const SECTION_ORDER = ["Breaking", "Features", "Fixes"] as const;
const RELEASE_HEADING = /^##\s+v([^\s]+)(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/gm;

function cleanBlock(block: string): string {
  return block.trim().replace(/\n{3,}/g, "\n\n");
}

export function renderReleaseBody(markdown: string): string {
  const sections = new Map<string, string>();
  const heading = /^###\s+(.+)\s*$/gm;
  const headings = [...markdown.matchAll(heading)];

  for (let i = 0; i < headings.length; i++) {
    const name = headings[i][1].trim();
    if (name === "Internal" || !SECTION_ORDER.includes(name as (typeof SECTION_ORDER)[number])) continue;
    const start = (headings[i].index ?? 0) + headings[i][0].length;
    const next = headings[i + 1]?.index ?? markdown.length;
    const body = cleanBlock(markdown.slice(start, next));
    if (body) sections.set(name, body);
  }

  return SECTION_ORDER
    .filter((name) => sections.has(name))
    .map((name) => `### ${name}\n${sections.get(name)}`)
    .join("\n\n");
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
