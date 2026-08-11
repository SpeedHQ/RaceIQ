import { m } from "@/paraglide/messages";
import type { GameId } from "../../../shared/games/ids";
import { SessionRecap } from "./SessionRecap";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function SessionRecapModal({ sessionId, gameId, onClose }: { sessionId: number; gameId?: GameId | null; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" showCloseButton={false} overlayClassName="bg-app-bg/60">
        <DialogTitle className="sr-only">{m.recap_latest_session()}</DialogTitle>
        <SessionRecap sessionId={sessionId} gameId={gameId} />
      </DialogContent>
    </Dialog>
  );
}
