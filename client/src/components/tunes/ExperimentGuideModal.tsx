import { m } from "@/paraglide/messages";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function Section({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-app-accent/15 text-xs font-semibold text-app-accent">{number}</span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-app-text">{title}</h3>
        <div className="mt-1 text-sm leading-relaxed text-app-text-muted">{children}</div>
      </div>
    </section>
  );
}

export function ExperimentGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="max-h-[85vh]">
        <DialogHeader className="flex flex-row items-center justify-between gap-3">
          <DialogTitle className="text-sm font-semibold text-app-text">{m.tunes_experiment_guide_title()}</DialogTitle>
          <Button variant="app-ghost" size="app-sm" aria-label={m.common_close()} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-app-text-muted">
            {m.tunes_experiment_guide_intro()}
          </p>

          <div className="space-y-4">
            <Section number={1} title={m.tunes_experiment_guide_create_title()}>
              {m.tunes_experiment_guide_create_body()}
            </Section>
            <Section number={2} title={m.tunes_experiment_guide_chat_title()}>
              {m.tunes_experiment_guide_chat_body()}
            </Section>
            <Section number={3} title={m.tunes_experiment_guide_preview_title()}>
              {m.tunes_experiment_guide_preview_body()}
            </Section>
            <Section number={4} title={m.tunes_experiment_guide_drive_title()}>
              {m.tunes_experiment_guide_drive_body()}
            </Section>
            <Section number={5} title={m.tunes_experiment_guide_compare_title()}>
              {m.tunes_experiment_guide_compare_body()}
            </Section>
          </div>

          <div className="rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs leading-relaxed text-status-warning">
            {m.tunes_experiment_guide_tip()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
