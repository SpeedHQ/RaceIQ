import { useQuery } from "@tanstack/react-query";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

export function TuneViewModal({ tuneId, onClose }: { tuneId: number; onClose: () => void }) {
  const { data: tune, isLoading } = useQuery({
    queryKey: ["tune", tuneId],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => client.api.tunes[":id"].$get({ param: { id: String(tuneId) } }).then((r) => r.json() as any),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg" showCloseButton={false} layout="scrollable" overlayClassName="bg-app-bg/60" className="@container/tune-view max-h-[80vh] max-w-[600px] gap-0 @sm/tune-view:p-5">
        {isLoading ? (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{m.tuneview_loading()}</DialogTitle>
            </DialogHeader>
            <p className="text-app-text-muted text-sm">{m.tuneview_loading()}</p>
          </>
        ) : !tune ? (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{m.tuneview_not_found()}</DialogTitle>
            </DialogHeader>
            <p className="text-app-text-muted text-sm">{m.tuneview_not_found()}</p>
          </>
        ) : (
          <>
            <DialogHeader className="mb-4 flex flex-row items-center justify-between gap-0">
              <div>
                <DialogTitle className="text-lg font-semibold text-app-text">{tune.name}</DialogTitle>
                {tune.author && (
                  <p className="text-xs text-app-text-muted">
                    {m.tuneview_by_author()} {tune.author}
                  </p>
                )}
              </div>
              <Button variant="app-ghost" size="app-sm" aria-label={m.common_close()} onClick={onClose}>
                &times;
              </Button>
            </DialogHeader>

            {tune.category && <span className="inline-block px-2 py-0.5 text-xs rounded mb-3 bg-app-accent/15 text-app-accent">{tune.category}</span>}

            {tune.description && <p className="text-sm text-app-text-muted mb-4">{tune.description}</p>}

            {tune.settings && (
              <div className="grid grid-cols-1 gap-3 text-xs @3xl/tune-view:grid-cols-2">
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
      </DialogContent>
    </Dialog>
  );
}
