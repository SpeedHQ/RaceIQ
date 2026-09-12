import type { ReactNode } from "react";
import { Headphones } from "lucide-react";
import { useSettings } from "../../hooks/settings";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { LiveEngineerOverlay } from "./LiveEngineerOverlay";
import { RadioModal } from "./RadioModal";
import { RadioPlaybackController } from "./RadioPlaybackController";

export function RadioDock({ children }: { children?: ReactNode }) {
  const { displaySettings } = useSettings();
  return <>
    <RadioPlaybackController />
    <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      {children}
      <LiveEngineerOverlay enabled={displaySettings.radioTextCalloutsEnabled} />
      <Dialog>
        <DialogTrigger render={<Button type="button" size="icon-lg" variant="app-outline" aria-label={m.label_radio()} title={m.label_radio()} />}><Headphones aria-hidden="true" /></DialogTrigger>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>{m.label_radio()}</DialogTitle><DialogDescription>{m.settings_radio_desc()}</DialogDescription></DialogHeader>
          <RadioModal />
        </DialogContent>
      </Dialog>
    </div>
  </>;
}
