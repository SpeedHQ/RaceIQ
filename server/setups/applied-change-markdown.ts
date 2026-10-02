/** Build persisted Setup Engineer apply summaries. */
export function buildAppliedChangesMarkdown(
  /** Display label (e.g. "v1.4") — matches version tree, not raw storage version. */
  label: string,
  applied: { component: string; from: number; to: number }[],
  fileName: string,
  /** F1 has no setup file to load; output an advisory-only diff. */
  hasFile: boolean = true,
  /** One-line goal of change, shown under header. */
  goal?: string | null,
): string {
  const header = goal ? `**Applied — ${label}** — _${goal}_` : `**Applied — ${label}**`;
  const loadLine = hasFile
    ? `Load \`${fileName}\` in-game from the setup menu.`
    : "Advisory only — apply these values in the in-game setup screen.";
  if (applied.length === 0) {
    return `${header}\n\nNo changes were needed — the setup already fits.\n\n${loadLine}`;
  }
  const lines = applied.map((change) => `- ${change.component}: ${change.from} → ${change.to}`).join("\n");
  return `${header}\n${lines}\n\n${loadLine}`;
}
