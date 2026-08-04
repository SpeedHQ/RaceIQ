import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NoteModal } from "@/components/ui/NoteModal";
import { m } from "@/paraglide/messages";

type NoteCellProps = { value?: string; onSave: (value: string) => void };

export function NoteCell({ value, onSave }: NoteCellProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && <NoteModal value={value} onSave={onSave} onClose={() => setOpen(false)} />}
      <Button
        type="button"
        className="relative cursor-pointer group block w-full text-left"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <span className={`text-xs break-words whitespace-pre-wrap transition-opacity group-hover:opacity-30 ${value ? "text-app-text/90" : "text-app-text/90 italic"}`}>
          {value || m.sessions_add_note()}
        </span>
        <span className="absolute inset-0 flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-app-text/90 text-app-caption font-medium">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          {m.common_edit()}
        </span>
      </Button>
    </>
  );
}
