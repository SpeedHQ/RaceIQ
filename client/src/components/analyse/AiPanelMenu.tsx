import { useState, useEffect, useRef } from "react";
import { Settings2 } from "lucide-react";

interface AiPanelMenuProps {
  onClearChat: () => void;
  onClearAnalysis: () => void;
  onClearAll: () => void;
}

export function AiPanelMenu({ onClearChat, onClearAnalysis, onClearAll }: AiPanelMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="text-app-text-muted hover:text-app-text transition-colors" title="Manage">
        <Settings2 className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-app-surface border border-app-border-input rounded-lg shadow-xl py-1 min-w-[160px]">
          <button onClick={() => { onClearChat(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-app-text-secondary hover:text-app-text hover:bg-app-surface-alt transition-colors">
            Clear chat only
          </button>
          <button onClick={() => { onClearAnalysis(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-app-text-secondary hover:text-app-text hover:bg-app-surface-alt transition-colors">
            Clear analysis (keep chat)
          </button>
          <div className="border-t border-app-border-input my-1" />
          <button onClick={() => { onClearAll(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:text-red-300 hover:bg-app-surface-alt transition-colors">
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
