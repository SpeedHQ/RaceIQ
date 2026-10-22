import { useQuery } from "@tanstack/react-query";
import { parseSVM } from "@raceiq/game-lmu-metadata/setups/svm";
import { LmuSetupPages } from "@/components/lmu/setups/LmuSetupPages";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchLmuSetupContent } from "@/hooks/lmu-setup-queries";
import { m } from "@/paraglide/messages";

export function LmuExperimentSetupModal({ path, onClose }: { path: string; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({ queryKey: ["lmu-setup-content", path], queryFn: () => fetchLmuSetupContent(path), staleTime: 30_000 });
  const parsed = data ? parseSVM(Uint8Array.from(atob(data.contentBase64), (character) => character.charCodeAt(0))) : null;
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent size="wide" layout="scrollable"><DialogHeader><DialogTitle>{data?.fileName ?? path}</DialogTitle></DialogHeader>
    {isLoading && <p className="p-4 text-sm text-app-text-muted">{m.common_loading()}</p>}
    {error && <p role="alert" className="p-4 text-sm text-status-danger">{error instanceof Error ? error.message : "Could not read LMU setup"}</p>}
    {parsed && !parsed.ok && <p role="alert" className="p-4 text-sm text-status-danger">{parsed.error}</p>}
    {parsed?.ok && <LmuSetupPages document={parsed.document} pending={new Map()} />}
    <div className="flex justify-end"><Button variant="app-outline" size="app-sm" onClick={onClose}>{m.common_close()}</Button></div>
  </DialogContent></Dialog>;
}
