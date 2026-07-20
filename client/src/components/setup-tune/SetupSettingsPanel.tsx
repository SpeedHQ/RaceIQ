import type { GameId } from "@shared/types";
import { arityLabels, getByPath, getSchemaForGame } from "./setup-schema";

/** Read-only summary of an ACC / AC-EVO setup JSON, grouped by the same
 *  sections FillForm edits. Skips fields absent from the settings object —
 *  imported / community setups may only cover a subset. */
export function SetupSettingsPanel({ gameId, settings }: { gameId: GameId; settings: Record<string, unknown> }) {
  const sections = getSchemaForGame(gameId);

  return (
    <div className="w-full columns-1 gap-3 md:columns-2 xl:columns-3">
      {sections.map((section) => {
        const rows: [string, string][] = [];
        for (const field of section.fields) {
          const value = getByPath(settings, field.path);
          if (value == null) continue;
          if (Array.isArray(value)) {
            const labels = arityLabels(field.arity);
            value.forEach((v, i) => {
              if (v == null) return;
              rows.push([labels[i] ? `${field.label} (${labels[i]})` : field.label, String(v)]);
            });
          } else {
            rows.push([field.label, String(value)]);
          }
        }
        if (rows.length === 0) return null;
        return (
          <div key={section.key} className="mb-3 break-inside-avoid rounded-lg bg-app-bg p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{section.label}</h4>
            <div className="space-y-0">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between text-xs gap-2">
                  <span className="text-app-text-muted whitespace-nowrap">{label}</span>
                  <span className="text-app-text font-mono whitespace-nowrap">{value}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
