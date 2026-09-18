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
          <DialogTitle className="text-sm font-semibold text-app-text">How Experiments work</DialogTitle>
          <Button variant="app-ghost" size="app-sm" aria-label="Close guide" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-app-text-muted">
            Experiments are an agent-driven loop for testing setup changes. You drive the car and describe what you feel; Setup Engineer handles setup analysis and records each version.
          </p>

          <div className="space-y-4">
            <Section number={1} title="Create an experiment">
              Choose one car and track, add a base setup, and select what you want to improve. This gives the agent a fixed starting point and a clear focus.
            </Section>
            <Section number={2} title="Talk to Setup Engineer">
              Use chat beside the version tree. The agent reads the current setup, your symptoms, and experiment history. Ask questions or describe handling problems in plain language.
            </Section>
            <Section number={3} title="Preview, then approve changes">
              The agent proposes specific setup changes and can preview their effect. Nothing is applied until you confirm. Approved changes create a new version in the tree.
            </Section>
            <Section number={4} title="Drive clean laps">
              Start Dashboard, drive a consistent stint, then review the recorded laps. Clean, repeatable laps make comparisons and recommendations more useful.
            </Section>
            <Section number={5} title="Compare and repeat">
              Open Review laps to compare versions and lap deltas. Keep the better version as your head, then ask the agent for the next focused change. Import past laps when you already have useful
              history.
            </Section>
          </div>

          <div className="rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs leading-relaxed text-status-warning">
            Best results: change one area at a time, tell the agent what changed between runs, and drive similar fuel and tyre conditions.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
