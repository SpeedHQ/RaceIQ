export type Bump = "major" | "minor" | "patch";

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

type Version = [major: number, minor: number, patch: number];

function parseVersionTag(tag: string): Version | undefined {
  const match = VERSION_TAG.exec(tag);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function formatVersion(version: Version): string {
  return version.join(".");
}

export function computeNextReleaseVersion(tags: readonly string[], bump: Bump): string {
  const versions = tags.flatMap((tag) => {
    const version = parseVersionTag(tag);
    return version ? [version] : [];
  });
  if (versions.length === 0) throw new Error("No released version tags found");

  const latest = versions.reduce((current, version) => compareVersions(version, current) > 0 ? version : current);
  const releasedVersions = new Set(versions.map(formatVersion));
  const next: Version = [...latest];
  const increment = () => {
    if (bump === "major") { next[0]++; next[1] = 0; next[2] = 0; }
    else if (bump === "minor") { next[1]++; next[2] = 0; }
    else if (bump === "patch") next[2]++;
    else throw new Error(`Unknown bump: ${bump}`);
  };

  increment();
  while (releasedVersions.has(formatVersion(next))) increment();
  return formatVersion(next);
}
