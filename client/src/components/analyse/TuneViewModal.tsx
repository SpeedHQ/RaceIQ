import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";
import { Button } from "../ui/button";

export function TuneViewModal({ tuneId, onClose }: { tuneId: number; onClose: () => void }) {
  const { data: tune, isLoading } = useQuery({
    queryKey: ["tune", tuneId],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => client.api.tunes[":id"].$get({ param: { id: String(tuneId) } }).then((r) => r.json() as any),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[600px] max-h-[80vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {isLoading ? (
          <p className="text-app-text-muted text-sm">Loading tune...</p>
        ) : !tune ? (
          <p className="text-app-text-muted text-sm">Tune not found</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-app-text">{tune.name}</h2>
                {tune.author && <p className="text-xs text-app-text-muted">by {tune.author}</p>}
              </div>
              <Button variant="app-ghost" size="app-sm" onClick={onClose}>&times;</Button>
            </div>

            {tune.category && (
              <span className="inline-block px-2 py-0.5 text-xs rounded mb-3 bg-cyan-900/30 text-app-accent">
                {tune.category}
              </span>
            )}

            {tune.description && (
              <p className="text-sm text-app-text-muted mb-4">{tune.description}</p>
            )}

            {tune.settings && (
              <div className="grid grid-cols-2 gap-3 text-xs">
                {Object.entries(tune.settings).map(([section, values]) => (
                  <div key={section} className="bg-app-surface-alt rounded p-2 border border-app-border">
                    <h3 className="font-semibold text-app-accent uppercase tracking-wider mb-1">{section}</h3>
                    {typeof values === "object" && values !== null ? (
                      <dl className="space-y-0.5">
                        {Object.entries(values as Record<string, unknown>).map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <dt className="text-app-text-muted">{k.replace(/([A-Z])/g, " $1").trim()}</dt>
                            <dd className="text-app-text font-mono">{typeof v === "number" ? v.toFixed(2) : String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <span className="text-app-text">{String(values)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
