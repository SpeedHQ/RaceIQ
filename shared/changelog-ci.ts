export function hasUnreleasedChangelogChange(patch: string): boolean {
  let section: "unreleased" | "released" | null = null;

  for (const line of patch.split("\n")) {
    const content = line.slice(1).trim();
    if (!/^[ +\-]/.test(line) || line.startsWith("+++")) continue;

    const releaseHeading = content.match(/^##\s+(.+)$/);
    if (releaseHeading) {
      section = releaseHeading[1].trim().toLowerCase() === "unreleased" ? "unreleased" : "released";
      continue;
    }

    if (section === "unreleased" && line.startsWith("+") && content.length > 0) {
      return true;
    }
  }

  return false;
}
