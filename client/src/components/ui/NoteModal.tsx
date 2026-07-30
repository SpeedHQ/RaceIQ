import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { m } from "@/paraglide/messages";
import { Button } from "./button";

export function NoteModal({ value, onSave, onClose }: { value?: string; onSave: (v: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commit = () => {
    onSave(draft);
    onClose();
  };
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[480px] max-w-[90vw] flex flex-col gap-3 p-4">
        <p className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.note_title()}</p>
        <textarea
          ref={ref}
          rows={5}
          className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text/90 outline-none resize-none focus:border-app-accent/60"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && e.metaKey) commit();
          }}
          placeholder={m.note_placeholder()}
        />
        <div className="flex justify-end gap-2">
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button variant="app-outline" size="app-sm" className="bg-app-accent/15 !border-app-accent/40 text-app-accent hover:bg-app-accent/25" onClick={commit}>
            {m.common_save()}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
