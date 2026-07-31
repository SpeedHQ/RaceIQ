import { useEffect, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { Button } from "./button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

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
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.note_title()}</DialogTitle>
        </DialogHeader>
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
        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button variant="app-outline" size="app-sm" className="bg-app-accent/15 !border-app-accent/40 text-app-accent hover:bg-app-accent/25" onClick={commit}>
            {m.common_save()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
