import { createPortal } from "react-dom";
import { SessionRecap } from "./SessionRecap";

export function SessionRecapModal({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[560px] max-w-full max-h-[85vh] overflow-y-auto p-4">
        <SessionRecap sessionId={sessionId} />
      </div>
    </div>,
    document.body,
  );
}
