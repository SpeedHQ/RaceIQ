import { FOCUS_MODES, type SpectateFocus, type SpectateFocusMode } from "./spectate-focus";
import { Gauge, Scale, SlidersHorizontal, Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const FOCUS_ICONS = { inputs: SlidersHorizontal, ers: Zap, balance: Scale, speed: Gauge };

export function SpectateFocusToolbar({ focus, onChange }: { focus: SpectateFocus; onChange: (mode: SpectateFocusMode) => void }) {
  return (
    <TooltipProvider delay={0}>
      <div role="toolbar" aria-label="Focus mode" aria-orientation="vertical"
        className="group absolute right-3 top-1/2 z-40 flex -translate-y-1/2 flex-col rounded-sm border border-app-border bg-app-surface/90 p-0"
      data-focus-mode={focus.mode}>
      {FOCUS_MODES.map(({ mode, label }) => {
        const Icon = FOCUS_ICONS[mode];
        return (
          <Tooltip key={mode}>
            <TooltipTrigger render={<button type="button" aria-label={label} aria-pressed={focus.mode === mode} onClick={() => onChange(mode)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${focus.mode === mode ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`} />}>
              <Icon size={16} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent role="tooltip" side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div role="group" aria-label="Line color legend"
        className="pointer-events-none absolute right-full top-0 mr-2 flex w-max max-w-[calc(100vw-5rem)] flex-col gap-1 rounded-sm border border-app-border bg-app-surface/95 p-2 text-app-caption text-app-text-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
        <strong className="text-app-text">Focus · {FOCUS_MODES.find(({ mode }) => mode === focus.mode)?.label}</strong>
        {focus.legend.map(({ label, token }) => (
          <span key={label} className="inline-flex items-center gap-1 whitespace-nowrap">
            <i aria-hidden="true" className="h-0.5 w-3" style={{ background: `var(${token})` }} />{label}
          </span>
        ))}
        <span className="whitespace-nowrap">Track: A left · B right</span>
        <span className="whitespace-nowrap">Overview: A ━ · B ┄</span>
      </div>
    </div>
    </TooltipProvider>
    );
}
