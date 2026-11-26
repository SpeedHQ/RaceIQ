function getUnreleasedBullets(changelog: string): string[] {
  const lines = changelog.split("\n");
  const end = lines.findIndex((line) => /^##\s+/.test(line.trim()));
  return lines
    .slice(0, end < 0 ? lines.length : end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.length > 2);
}

export function hasUnreleasedChangelogChange(
  patch: string,
  baseChangelog?: string,
  headChangelog?: string,
): boolean {
  if (baseChangelog !== undefined && headChangelog !== undefined) {
    const baseBullets = new Set(getUnreleasedBullets(baseChangelog));
    return getUnreleasedBullets(headChangelog).some((bullet) => !baseBullets.has(bullet));
  }

  let section: "unreleased" | "released" = "unreleased";

  for (const line of patch.split("\n")) {
    const content = line.slice(1).trim();
    if (!/^[ +-]/.test(line) || line.startsWith("+++")) continue;

    const releaseHeading = content.match(/^##\s+(.+)$/);
    if (releaseHeading) {
      section = "released";
      continue;
    }

    if (section === "unreleased" && line.startsWith("+") && content.length > 0) return true;
  }

  return false;
}
