import { parseAppliedChanges } from "./applied-changes";

/** Render normalized setup/drill changes for expanded version rows. */
export function AppliedChangesList({ json, comment }: { json: string | null; comment?: string | null }) {
  const changes = parseAppliedChanges(json);
  if (changes.length === 0 && !comment) return null;
  return (
    <div className="px-3 py-2 border-b border-app-border/40 space-y-1">
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Tweaks</div>
      {changes.length === 0 ? (
        <div className="text-app-compact text-app-text-dim">Base setup — no changes applied.</div>
      ) : (
        <ul className="space-y-0.5">
          {changes.map((c) =>
            c.kind === "drill" ? (
              <li key={`drill-${c.title}-${c.corners.join("-")}-${c.instruction ?? ""}`} className="text-app-compact text-app-text">
                <span className="font-mono text-status-warning">{c.title}</span>
                {c.corners.length > 0 && <span className="tabular-nums text-app-text-dim"> · {c.corners.join(", ")}</span>}
                {c.instruction && <div className="text-app-text-dim">{c.instruction}</div>}
              </li>
            ) : (
              <li key={`${c.component}-${c.from}-${c.to}-${c.reason ?? ""}`} className="text-app-compact text-app-text">
                <span className="font-mono text-(--focus-setup)">{c.component}</span>{" "}
                <span className="tabular-nums text-app-text-dim">
                  {c.from} → {c.to}
                </span>
                {c.reason && <span className="text-app-text-dim"> · {c.reason}</span>}
              </li>
            ),
          )}
        </ul>
      )}
      {comment && <div className="text-app-compact text-app-text-dim italic">Driver: “{comment}”</div>}
    </div>
  );
}
